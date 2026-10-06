import { AgyError } from "./errors.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { researchedMetadataFor } from "./model-metadata.js";

/** Transport byte caps bound input work, not the model's combined token window.
 * Charge input at one token per UTF-8 byte (conservative, not a tokenizer), and
 * reserve output against the model window independently. Routine max_tokens
 * must never be subtracted from a smaller adapter input byte cap. */
export function modelTranscriptBudget(model: string, inputByteCap: number, fixed: string, outputBudget?: number): number {
  const metadata = researchedMetadataFor({ id: model, name: model, acpModel: model });
  const context = metadata?.context ?? 32_768;
  const output = metadata?.output ?? 8_192;
  // ACP owns limits: a smaller advisory host field cannot prove less output.
  const reserve = Math.max(output, Math.min(outputBudget ?? output, output));
  const inputWindow = context - reserve - Math.ceil(context * 0.1);
  return transcriptBudget(Math.min(inputByteCap, inputWindow), fixed, 0);
}

export const HISTORY_OMISSION = "[historical text/media omitted to fit context budget]";
export function blockBytes(block: ContentBlock): number { return Buffer.byteLength(JSON.stringify(block)) + 1; }

/** Charge every block, including media. Only historical text can be cut;
 * historical media that cannot fit is explicitly omitted, never half-sent. */
export function boundHistoricalBlocks(blocks: ContentBlock[], available: number): { blocks: ContentBlock[]; remaining: number; omitted: boolean } {
  const selected: ContentBlock[] = [];
  let omitted = false;
  for (const block of blocks) {
    const size = blockBytes(block);
    if (size <= available) { selected.push(block); available -= size; continue; }
    omitted = true;
    if (block.type !== "text") continue;
    const characters = Array.from(block.text);
    let low = 0; let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (blockBytes({ type: "text", text: characters.slice(0, middle).join("") }) <= available) low = middle;
      else high = middle - 1;
    }
    if (low) {
      const bounded: ContentBlock = { type: "text", text: characters.slice(0, low).join("") };
      selected.push(bounded); available -= blockBytes(bounded);
    }
  }
  return { blocks: selected, remaining: available, omitted };
}

/** UTF-8 bytes conservatively overestimate tokens on this route. Not token accounting. */
export function transcriptBudget(limit: number, fixed: string, reserve = Math.floor(limit / 2)): number {
  const available = limit - reserve - Buffer.byteLength(fixed) - 512;
  if (available < 1024) throw new AgyError("invalid_request", "Fixed instructions and current request exhaust the context budget", { code: "agy_context_budget" });
  return available;
}

export function orderedChunks(items: Array<{ text: string; identity: string }>, budget: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const item of items) {
    if (Buffer.byteLength(item.text) <= budget) {
      const next = current ? `${current}\n\n${item.text}` : item.text;
      if (Buffer.byteLength(next) > budget) { chunks.push(current); current = item.text; }
      else current = next;
      continue;
    }
    if (current) { chunks.push(current); current = ""; }
    const header = `${item.identity}\n[continued oversized historical item]\n`;
    const available = budget - Buffer.byteLength(header);
    if (available < 512) throw new AgyError("invalid_request", "Historical item identities exhaust the summary budget", { code: "agy_context_budget" });
    let part = ""; let bytes = 0;
    for (const character of item.text) {
      const size = Buffer.byteLength(character);
      if (bytes + size > available) { chunks.push(header + part); part = ""; bytes = 0; }
      part += character; bytes += size;
    }
    if (part) chunks.push(header + part);
  }
  if (current) chunks.push(current);
  return chunks;
}

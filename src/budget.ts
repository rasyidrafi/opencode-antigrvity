import { AgyError } from "./errors.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { researchedMetadataFor } from "./model-metadata.js";
import { DEFAULT_HISTORY_MAX_CHARS } from "./constants.js";
import { warn } from "./log.js";
import { IMAGE_CONTEXT_ESTIMATE } from "./attachments.js";
export const TRANSCRIPT_INPUT_BYTE_CAP = 100_000;
export const FIXED_BUDGET_HEADROOM = 1024;

export function historyCharacterLimit(): number {
  const raw = process.env.OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS;
  if (raw === undefined) return DEFAULT_HISTORY_MAX_CHARS;
  const value = Number(raw);
  if (raw.trim() && Number.isSafeInteger(value) && value > 0) return value;
  warn("invalid history character limit; using default", { code: "agy_history_limit_invalid" });
  return DEFAULT_HISTORY_MAX_CHARS;
}

/** Transport byte caps bound input work, not the model's combined token window.
 * Charge input at one token per UTF-8 byte (conservative, not a tokenizer), and
 * reserve output against the model window independently. Routine max_tokens
 * must never be subtracted from a smaller adapter input byte cap. */

function modelInputWindow(model: string, outputBudget?: number): number {
  const metadata = researchedMetadataFor({ id: model, name: model, acpModel: model });
  const context = metadata?.context ?? 32_768;
  const output = metadata?.output ?? 8_192;
  // ACP owns limits: a smaller advisory host field cannot prove less output.
  const reserve = Math.max(output, Math.min(outputBudget ?? output, output));
  return context - reserve - Math.ceil(context * 0.1);
}

export const HISTORY_OMISSION = "[historical text/media omitted to fit context budget]";
export function blockBytes(block: ContentBlock): number { return block.type === "image" ? IMAGE_CONTEXT_ESTIMATE : Buffer.byteLength(JSON.stringify(block)) + 1; }

/** Sum numeric costs, never allocate estimate-sized strings or serialize media. */
export function blockBudget(model: string, blocks: ContentBlock[], outputBudget?: number): { text: number; context: number } {
  let text = 0; let context = 0;
  for (const block of blocks) {
    const size = blockBytes(block);
    context += size;
    if (block.type !== "image") text += size;
  }
  return {
    text: fixedBudget(TRANSCRIPT_INPUT_BYTE_CAP, text),
    context: fixedBudget(modelInputWindow(model, outputBudget), context),
  };
}

function fixedBudget(limit: number, fixedBytes: number): number {
  const available = limit - fixedBytes - 512;
  if (available < FIXED_BUDGET_HEADROOM) throw new AgyError("invalid_request", "Fixed instructions and current request exhaust the context budget", { code: "agy_context_budget" });
  return available;
}

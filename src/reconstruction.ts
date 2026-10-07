import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { HostMessage } from "./prompt.js";
import { blockBytes, blockBudget, FIXED_BUDGET_HEADROOM, HISTORY_OMISSION } from "./budget.js";
import { MAX_MEDIA_BYTES, validateMediaBlocks } from "./attachments.js";

export type ReconstructionGroup = { blocks: ContentBlock[]; operative: boolean; message: HostMessage };

function identities(message: HostMessage): string[] {
  const ids: string[] = [];
  if (typeof message.tool_call_id === "string") ids.push(message.tool_call_id);
  if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) if (typeof call?.id === "string") ids.push(call.id);
  if (Array.isArray(message.content)) for (const part of message.content) {
    if (part?.type === "tool_use" && typeof part.id === "string") ids.push(part.id);
    if (part?.type === "tool_result" && typeof part.tool_use_id === "string") ids.push(part.tool_use_id);
    // Host-promoted images follow result envelopes in this same message.
  }
  return ids;
}

/** Select whole causal units newest first, then emit original chronology.
 * Unioning by ID keeps parallel calls/results together even across messages. */
export function reconstruct(groups: ReconstructionGroup[], instructions: string, model: string, historyLimit: number, outputBudget?: number): ContentBlock[] {
  const parents = groups.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parents[root] !== root) root = parents[root];
    while (parents[i] !== i) { const next = parents[i]; parents[i] = root; i = next; }
    return root;
  };
  const owner = new Map<string, number>();
  groups.forEach((group, i) => {
    for (const id of identities(group.message)) {
      const previous = owner.get(id);
      if (previous !== undefined) parents[find(i)] = find(previous);
      owner.set(id, i);
    }
  });
  const units = new Map<number, number[]>();
  groups.forEach((_, i) => { const root = find(i); const unit = units.get(root) ?? []; unit.push(i); units.set(root, unit); });
  const required = new Set<number>();
  for (const unit of units.values()) if (unit.some(i => groups[i].operative)) unit.forEach(i => required.add(i));
  const fixed = [...(instructions ? [{ type: "text" as const, text: instructions }] : []), ...groups.flatMap((g, i) => required.has(i) ? g.blocks : [])];
  let media = validateMediaBlocks(fixed);
  const marker: ContentBlock = { type: "text", text: HISTORY_OMISSION.slice(0, historyLimit) };
  // Omission evidence is fixed overhead whenever optional material exists.
  // Admit it now, and retain exactly the headroom the final validator requires.
  const budget = blockBudget(model, required.size < groups.length ? [...fixed, marker] : fixed, outputBudget);
  let bytes = budget.context - FIXED_BUDGET_HEADROOM;
  let textBytes = budget.text - FIXED_BUDGET_HEADROOM;
  let chars = Math.max(0, historyLimit - marker.text.length);
  const selected = new Set(required);
  let omitted = false;
  const optional = [...units.values()].filter(unit => !unit.some(i => required.has(i))).sort((a, b) => b.at(-1)! - a.at(-1)!);
  for (const unit of optional) {
    const blocks = unit.flatMap(i => groups[i].blocks);
    const cost = blocks.reduce((n, block) => n + blockBytes(block), 0);
    const characters = blocks.reduce((n, block) => n + (block.type === "text" ? block.text.length : 0), 0);
    const textCost = blocks.reduce((n, block) => n + (block.type === "image" ? 0 : blockBytes(block)), 0);
    const mediaCost = validateMediaBlocks(blocks, Number.POSITIVE_INFINITY);
    if (cost > bytes || textCost > textBytes || characters > chars || media + mediaCost > MAX_MEDIA_BYTES) { omitted = true; continue; }
    bytes -= cost; textBytes -= textCost; chars -= characters; media += mediaCost;
    unit.forEach(i => selected.add(i));
  }
  return [...(omitted ? [marker] : []), ...groups.flatMap((group, i) => selected.has(i) ? group.blocks : [])];
}

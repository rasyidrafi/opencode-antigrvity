import { createHash } from "node:crypto";
import type { HostMessage } from "./prompt.js";

/** Object keys are transport details; array order is conversation chronology. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function fingerprints(messages: HostMessage[]): string[] {
  return messages.map(m => {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content.map(part => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "thinking") return { type: "thinking", thinking: part.thinking };
      // OpenCode moves the Anthropic cache marker to the newest message on
      // every request. It is transport metadata, not a history edit.
      const { cache_control: _cache, ...semantic } = part;
      return semantic;
    }) : m.content;
    return createHash("sha256").update(canonical({ role: m.role, content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id })).digest("hex");
  });
}

export function extendsBoundary(boundary: string[], incoming: string[]): boolean {
  return boundary.length <= incoming.length && boundary.every((item, i) => item === incoming[i]);
}

export type ConversationState = {
  version: 1;
  epoch: number;
  boundary: string[];
  instructions: string;
  hostSessionID?: string;
  resumable: boolean;
};

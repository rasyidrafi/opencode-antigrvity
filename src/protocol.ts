import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";

export type { ContentBlock, PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";

/** Internal response metadata; separate from ACP's request-token accounting. */
export type ContextOccupancy = { used: number };

export type AcpEvent =
  | { event: "update"; sessionId: string; update: SessionUpdate }
  | { event: "result"; sessionId: string; result: PromptResponse; contextOccupancy?: ContextOccupancy };

export function isSuccessfulResult(event: AcpEvent): boolean {
  return event.event === "result" && event.result.stopReason === "end_turn";
}

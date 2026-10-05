import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";

export type { ContentBlock, PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";

export type AcpEvent =
  | { event: "update"; sessionId: string; update: SessionUpdate }
  | { event: "result"; sessionId: string; result: PromptResponse };

export function isSuccessfulResult(event: AcpEvent): boolean {
  return event.event === "result" && event.result.stopReason === "end_turn";
}

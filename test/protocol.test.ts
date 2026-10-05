import { describe, expect, test } from "bun:test";
import { isSuccessfulResult, type AcpEvent } from "../src/protocol.js";

describe("ACP protocol event model", () => {
  test("represents streamed messages and terminal prompt results", () => {
    const update: AcpEvent = { event: "update", sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } };
    const result: AcpEvent = { event: "result", sessionId: "s", result: { stopReason: "end_turn" } };
    expect(update.event).toBe("update");
    expect(result.event).toBe("result");
    expect(isSuccessfulResult(result)).toBe(true);
  });

  test("recognizes cancelled prompt results as unsuccessful", () => {
    expect(isSuccessfulResult({ event: "result", sessionId: "s", result: { stopReason: "cancelled" } })).toBe(false);
  });
});

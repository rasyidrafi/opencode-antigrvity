import { describe, expect, test } from "bun:test";
import { mapAcpEvent, usageFromAcp, appendResultWithoutDuplication, collectTurn, createAcpTranslationState } from "../src/translate.js";

describe("ACP to Anthropic translation", () => {
  test("maps token usage without inventing price", () => {
    expect(usageFromAcp({ inputTokens: 10, outputTokens: 4, thoughtTokens: 3, cacheReadTokens: 2, totalTokens: 14 })).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 2,
      output_tokens_details: { thinking_tokens: 3 },
    });
  });

  test("shows a tool once as running and omits successful completion", () => {
    const state = createAcpTranslationState();
    const started = mapAcpEvent({ event: "update", sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "run_command", kind: "execute", status: "in_progress" } }, state);
    expect(started).toEqual({ kind: "activity", text: "[Antigravity ACP tool: Running run_command]" });
    const repeated = mapAcpEvent({ event: "update", sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "run_command", kind: "execute", status: "in_progress" } }, state);
    expect(repeated).toEqual({ kind: "ignore" });
    const completed = mapAcpEvent({ event: "update", sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" } }, state);
    expect(completed).toEqual({ kind: "ignore" });
  });

  test("streams plan and tool output details as ordered activity", () => {
    const plan = mapAcpEvent({
      event: "update",
      sessionId: "s",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Inspect the repository", priority: "high", status: "in_progress" }],
      } as any,
    });
    expect(plan).toEqual({ kind: "activity", text: "[Antigravity ACP plan]\n- [in_progress] Inspect the repository" });

    const tool = mapAcpEvent({
      event: "update",
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "read files",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "package.json" } }],
      } as any,
    });
    expect(tool.kind).toBe("activity");
    expect((tool as any).text).toContain("read files");
    expect((tool as any).text).toContain("package.json");
  });

  test("does not duplicate the terminal result after deltas", async () => {
    expect(appendResultWithoutDuplication("hello", "hello world")).toBe(" world");
    expect(appendResultWithoutDuplication("hello", "different")).toBeUndefined();
    const result = await collectTurn((async function* () {
      yield { event: "update", sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } as const;
      yield { event: "result", sessionId: "s", result: { stopReason: "end_turn" } } as const;
    })());
    expect(result.content).toBe("hello");
  });
  test("shows bounded identifying arguments and only one failure per call", () => {
    const state = createAcpTranslationState();
    const update = (value: any) => mapAcpEvent({ event: "update", sessionId: "s", update: value }, state);
    const started = update({ sessionUpdate: "tool_call", toolCallId: "shell", title: "run_command", kind: "execute", status: "in_progress",
      rawInput: { command: "rg -n TODO src", token: "SECRET", content: "FILE_BODY" } });
    expect(started).toEqual({ kind: "activity", text: "[Antigravity ACP tool: Running run_command: rg -n TODO src]" });
    const failed = { sessionUpdate: "tool_call_update", toolCallId: "shell", status: "failed" };
    expect(update(failed)).toEqual({ kind: "activity", text: "[Antigravity ACP tool failed: run_command: rg -n TODO src]" });
    expect(update(failed).kind).toBe("ignore");
    expect(update({ sessionUpdate: "tool_call", toolCallId: "read", kind: "read", status: "completed", locations: [{ path: "src/index.ts", line: 10 }] }))
      .toEqual({ kind: "activity", text: "[Antigravity ACP tool: Read: src/index.ts, line 10]" });
    const long = update({ sessionUpdate: "tool_call", toolCallId: "long", title: "x\u001b\n" + "y".repeat(1000) });
    expect((long as any).text.length).toBeLessThan(280);
    expect((long as any).text).not.toContain("\u001b");
  });

});

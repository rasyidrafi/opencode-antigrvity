import { describe, expect, test } from "bun:test";
import { UnsupportedMediaError } from "../src/errors.js";
import { buildBoundedHistory, normalizePrompt, stableConversationKey } from "../src/prompt.js";

describe("prompt normalization", () => {
  test("extracts only the latest user text and bounded prior context", async () => {
    const prompt = await normalizePrompt([
      { role: "system", content: "Be concise" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
    expect(prompt.text).toBe("second");
    expect(buildBoundedHistory(prompt.priorMessages, 500)).toContain("first");
    expect(stableConversationKey([{ role: "user", content: "first" }])).toHaveLength(48);
  });

  test("converts ACP-supported media and rejects remote URLs", async () => {
    const prompt = await normalizePrompt([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }]);
    expect(prompt.blocks[0]).toMatchObject({ type: "image", mimeType: "image/png", data: "AA==" });
    await expect(normalizePrompt([{ role: "user", content: [{ type: "input_audio", data: "AA==", media_type: "audio/wav" }] }])).rejects.toThrow(UnsupportedMediaError);
    await expect(normalizePrompt([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }])).rejects.toThrow(UnsupportedMediaError);
  });

  test("rejects host tool calls", async () => {
    await expect(normalizePrompt([{ role: "assistant", content: "x", tool_calls: [] }, { role: "user", content: "next" }])).rejects.toThrow(/tool calls/i);
  });

  test("tiny bounded history cannot replay an oversized entry through slice(-0)", () => {
    for (const limit of [1, 10, 24, 40]) {
      const history = buildBoundedHistory([{ role: "user", content: "X".repeat(10_000) }], limit);
      const body = history.split("\n").slice(2, -1).join("\n");
      expect(body.length).toBeLessThanOrEqual(limit);
      expect(history).not.toContain("X".repeat(100));
    }
    const history = buildBoundedHistory([{ role: "user", content: "X".repeat(10_000) }, { role: "assistant", content: "recent" }], 240);
    expect(history.length).toBeLessThanOrEqual(240);
    expect(history).toContain("recent");
  });

  test("rebuilt host tool continuation identifies completed calls without losing steering or images", async () => {
    const prompt = await normalizePrompt([
      { role: "assistant", content: [{ type: "tool_use", id: "original", name: "shell", input: { command: "echo completed" } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "original", content: [{ type: "text", text: "ORIGINAL_RESULT" }] },
        { type: "text", text: "NEW_STEERING" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      ] },
    ], { hostTools: true });
    expect(prompt.text).toContain("have already executed in OpenCode");
    expect(prompt.text).toContain("not a new request to execute those calls");
    expect(prompt.text).toContain("[tool result original]");
    expect(prompt.text.indexOf("ORIGINAL_RESULT")).toBeLessThan(prompt.text.indexOf("NEW_STEERING"));
    expect(prompt.blocks.at(-1)).toMatchObject({ type: "image", data: "AA==" });
  });
});

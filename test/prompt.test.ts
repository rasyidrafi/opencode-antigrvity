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
    const audio = await normalizePrompt([{ role: "user", content: [{ type: "input_audio", data: "AA==", media_type: "audio/wav" }] }]);
    expect(audio.blocks[0]).toMatchObject({ type: "audio", mimeType: "audio/wav", data: "AA==" });
    await expect(normalizePrompt([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }])).rejects.toThrow(UnsupportedMediaError);
  });

  test("rejects host tool calls", async () => {
    await expect(normalizePrompt([{ role: "assistant", content: "x", tool_calls: [] }, { role: "user", content: "next" }])).rejects.toThrow(/tool calls/i);
  });
});

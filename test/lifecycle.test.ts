import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SessionPool } from "../src/session-pool.js";
import { SessionStore } from "../src/session-store.js";
import { canonical, extendsBoundary, fingerprints } from "../src/coordinator.js";
import type { HostMessage } from "../src/prompt.js";
import { blockBytes, HISTORY_OMISSION } from "../src/budget.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const settings = { cwd: process.cwd(), model: "fake-model-low", executable: fixture };
async function setup() {
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(`${process.env.TMPDIR || "/tmp/opencode"}/lifecycle-`);
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  delete process.env.FAKE_ACP_STATE_FILE;
  return { store: new SessionStore(), pool: new SessionPool(), log: process.env.FAKE_ACP_PROMPT_LOG };
}
async function execute(pool: SessionPool, messages: HostMessage[], key = "conversation") {
  let text = "";
  for await (const e of pool.turn({ key, messages, hostSessionID: "host", prompt: [{ type: "text", text: "current" }], settings })) {
    if (e.event === "update" && e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text") text += e.update.content.text;
  }
  return text;
}

describe("authoritative host lifecycle", () => {
  test("canonical keys retain chronology and equivalent emitted text representations", () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(fingerprints([{ role: "assistant", content: "answer" }])).toEqual(fingerprints([{ role: "assistant", content: [{ type: "text", text: "answer" }] }]));
    expect(fingerprints([{ role: "user", content: [{ type: "text", text: "request", cache_control: { type: "ephemeral" } }] }])).toEqual(fingerprints([{ role: "user", content: "request" }]));
    expect(fingerprints([{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "shell", input: { cache_control: "a" } }] }])).not.toEqual(fingerprints([{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "shell", input: { cache_control: "b" } }] }]));
    expect(extendsBoundary(["a", "b"], ["b", "a"])).toBe(false);
  });

  test("warm append sends queued messages and instruction update once, not its own response", async () => {
    const { pool, log } = await setup();
    try {
      const answer = await execute(pool, [{ role: "user", content: [{ type: "text", text: "INITIAL_ONLY", cache_control: { type: "ephemeral" } }] }]);
      const before = await new SessionStore().get("conversation");
      await execute(pool, [{ role: "user", content: "INITIAL_ONLY" }, { role: "assistant", content: [{ type: "text", text: answer }] }, { role: "user", content: "QUEUED_ONE" }, { role: "system", content: "UPDATED_INSTRUCTIONS" }, { role: "user", content: [{ type: "text", text: "QUEUED_TWO", cache_control: { type: "ephemeral" } }] }]);
      expect((await new SessionStore().get("conversation"))!.sessionId).toBe(before!.sessionId);
      const prompts = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line).text as string);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).not.toContain("INITIAL_ONLY");
      expect(prompts[1].indexOf("QUEUED_ONE")).toBeLessThan(prompts[1].indexOf("UPDATED_INSTRUCTIONS"));
      expect(prompts[1].indexOf("UPDATED_INSTRUCTIONS")).toBeLessThan(prompts[1].indexOf("QUEUED_TWO"));
    } finally { await pool.close(); }
  });

  test("edits rebuild and a replacement session accepts the current history", async () => {
    const { pool, store, log } = await setup();
    try {
      await execute(pool, [{ role: "user", content: "SECRET_A" }]);
      const before = await store.get("conversation");
      await execute(pool, [{ role: "user", content: "SECRET_B" }]);
      expect((await store.get("conversation"))!.conversation!.epoch).toBeGreaterThan(before!.conversation!.epoch);
      const last = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1)!).text;
      expect(last).toContain("SECRET_B");
      expect(last).not.toContain("SECRET_A");
      await pool.close();
      const replacement = new SessionPool();
      try {
        await execute(replacement, [{ role: "user", content: "CHECKPOINT_AND_RECENT_TAIL" }]);
        expect((await store.get("conversation"))!.conversation!.resumable).toBe(true);
      } finally { await replacement.close(); }
    } finally { await pool.close(); }
  });

  test("completed results are private durable records and reject conflicting replay", async () => {
    const { pool, store } = await setup();
    try {
      await store.saveToolCall("conversation", "call", { call: { id: "call", name: "write", input: { path: "file" } }, epoch: 0 });
      const result = { content: [{ type: "text", text: "done" }], isError: false };
      await store.saveToolResult("conversation", "call", result);
      await store.saveToolResult("conversation", "call", result);
      await expect(store.saveToolResult("conversation", "call", { content: [{ type: "text", text: "different" }], isError: false })).rejects.toThrow("Conflicting");
      expect((await store.toolCall("conversation", "call"))!.delivery).toBe("result-persisted");
      await expect(store.saveToolResult("other", "call", result)).rejects.toThrow("originating");
    } finally { await pool.close(); }
  });

  test("cold rebuild budgets every historical text/media block and preserves the complete current request", async () => {
    const { pool, log } = await setup();
    const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
    try {
      for (const [index, historical] of [
        [{ type: "text", text: "A".repeat(70000) }, { type: "text", text: "B".repeat(60000) }, image("AA==")],
        [{ type: "text", text: "historical image" }, image("A".repeat(120000))],
      ].entries()) {
        await execute(pool, [{ role: "user", content: historical }, { role: "assistant", content: "prior answer" }, { role: "user", content: [{ type: "text", text: "CURRENT_HEAD" }, { type: "text", text: "CURRENT_TAIL" }, image("AA==")] }], `budget-${index}`);
      }
      const prompts = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(prompts).toHaveLength(2);
      for (const [index, sent] of prompts.entries()) {
        expect(sent.prompt.reduce((sum: number, block: any) => sum + blockBytes(block), 0)).toBeLessThan(50000);
        if (index === 0) expect(sent.text).toContain(HISTORY_OMISSION);
        else expect(sent.text).not.toContain(HISTORY_OMISSION);
        expect(sent.text).toContain("CURRENT_HEAD");
        expect(sent.text).toContain("CURRENT_TAIL");
        expect(sent.prompt.filter((block: any) => block.type === "image")).toEqual([...(index === 1 ? [{ type: "image", data: "A".repeat(120000), mimeType: "image/png" }] : []), { type: "image", data: "AA==", mimeType: "image/png" }]);
      }
      await expect(execute(pool, [{ role: "user", content: [{ type: "text", text: "C".repeat(60000) }, { type: "text", text: "OPERATIVE_TAIL" }] }], "oversized-operative")).rejects.toThrow("exhaust");
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally { await pool.close(); }
  });
});

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SessionPool } from "../src/session-pool.js";
import { SessionStore } from "../src/session-store.js";
import { canonical, extendsBoundary, fingerprints } from "../src/coordinator.js";
import { runSummary, type OneShotResult } from "../src/utility.js";
import type { HostMessage } from "../src/prompt.js";
import { blockBytes, HISTORY_OMISSION } from "../src/budget.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const settings = { cwd: process.cwd(), model: "fake-model-low", executable: fixture };
async function setup() {
  await chmod(fixture, 0o755);
  const directory = await mkdtemp("/tmp/opencode/lifecycle-");
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
    expect(extendsBoundary(["a", "b"], ["b", "a"])).toBe(false);
  });

  test("warm append sends queued messages and instruction update once, not its own response", async () => {
    const { pool, log } = await setup();
    try {
      const initial = [{ role: "user", content: "INITIAL_ONLY" }];
      const answer = await execute(pool, initial);
      await execute(pool, [...initial, { role: "assistant", content: [{ type: "text", text: answer }] }, { role: "user", content: "QUEUED_ONE" }, { role: "system", content: "UPDATED_INSTRUCTIONS" }, { role: "user", content: "QUEUED_TWO" }]);
      const prompts = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line).text as string);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).not.toContain("INITIAL_ONLY");
      expect(prompts[1].indexOf("QUEUED_ONE")).toBeLessThan(prompts[1].indexOf("UPDATED_INSTRUCTIONS"));
      expect(prompts[1].indexOf("UPDATED_INSTRUCTIONS")).toBeLessThan(prompts[1].indexOf("QUEUED_TWO"));
    } finally { await pool.close(); }
  });

  test("edits rebuild and commit survives restart without a replacement binding", async () => {
    const { pool, store, log } = await setup();
    try {
      await execute(pool, [{ role: "user", content: "SECRET_A" }]);
      const before = await store.get("conversation");
      await execute(pool, [{ role: "user", content: "SECRET_B" }]);
      expect((await store.get("conversation"))!.conversation!.epoch).toBeGreaterThan(before!.conversation!.epoch);
      const last = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1)!).text;
      expect(last).toContain("SECRET_B");
      expect(last).not.toContain("SECRET_A");
      await store.compaction("host", "summary-start", "generating");
      await store.compaction("host", "failure-event", "failed");
      expect((await store.lifecycle("host")).epoch).toBe(0);
      await store.compaction("host", "commit-event", "committed");
      await store.compaction("host", "commit-event", "committed");
      expect((await store.lifecycle("host")).epoch).toBe(1);
      await pool.close();
      const replacement = new SessionPool();
      try {
        await execute(replacement, [{ role: "user", content: "CHECKPOINT_AND_RECENT_TAIL" }]);
        expect((await store.get("conversation"))!.conversation!.hostEpoch).toBe(1);
      } finally { await replacement.close(); }
    } finally { await pool.close(); }
  });

  test("legacy bindings cold rebuild and old receipts remain replay tombstones", async () => {
    const { pool, store } = await setup();
    await store.set("conversation", { sessionId: "legacy", model: settings.model, cwd: settings.cwd, cliVersion: null, createdAt: 1, updatedAt: 1, lastUsedAt: Date.now() });
    await store.saveReceipt("conversation", "old", { state: "started" });
    try {
      await execute(pool, [{ role: "user", content: "COLD_HOST_CONTEXT" }]);
      expect((await store.get("conversation"))!.sessionId).not.toBe("legacy");
      expect((await store.get("conversation"))!.version).toBe(1);
      expect((await store.receipt("conversation", "old"))!.state).toBe("started");
    } finally { await pool.close(); }
  });

  test("legacy lifecycle migration preserves evidenced failures across replacement and reload", async () => {
    const { pool, store } = await setup();
    try {
      await store.compaction("host", "legacy-failure-F", "failed");
      const path = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, "lifecycle", `${createHash("sha256").update("host").digest("hex")}.json`);
      const legacy = JSON.parse(await readFile(path, "utf8"));
      delete legacy.failures;
      await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
      await store.compaction("host", "next-transaction", "generating");
      await store.compaction("host", "next-commit", "committed");
      const reloaded = new SessionStore();
      expect((await reloaded.lifecycle("host")).failures).toEqual(["legacy-failure-F"]);
      let retired = false;
      expect(await reloaded.applyCompactionEvent("host", "legacy-failure-F", "failed", async () => { retired = true; })).toBe(false);
      expect(retired).toBe(false);
      expect((await reloaded.lifecycle("host")).epoch).toBe(1);
      expect((await reloaded.lifecycle("host")).transaction!.id).toBe("next-commit");
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
      for (const sent of prompts) {
        expect(sent.prompt.reduce((sum: number, block: any) => sum + blockBytes(block), 0)).toBeLessThan(50000);
        expect(sent.text).toContain(HISTORY_OMISSION);
        expect(sent.text).toContain("CURRENT_HEAD");
        expect(sent.text).toContain("CURRENT_TAIL");
        expect(sent.prompt.filter((block: any) => block.type === "image")).toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
      }
      await expect(execute(pool, [{ role: "user", content: [{ type: "text", text: "C".repeat(60000) }, { type: "text", text: "OPERATIVE_TAIL" }] }], "oversized-operative")).rejects.toThrow("exhaust");
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally { await pool.close(); }
  });
});

test("bounded reduction preserves summary template and refuses incomplete output", async () => {
  const prompts: string[] = [];
  const run = async (prompt: string): Promise<OneShotResult> => {
    prompts.push(prompt);
    return { response: "Important ID EXACT_123; recent state retained", result: { stopReason: "end_turn" } };
  };
  const messages = [{ role: "system", content: "CURRENT_SUMMARY_INSTRUCTIONS" }, { role: "user", content: "older facts ".repeat(6000) + "RECENT_FACT EXACT_123" }, { role: "assistant", content: "recent state" }, { role: "user", content: "ORIGINAL_SUMMARY_TEMPLATE" }];
  const result = await runSummary(messages, settings, run);
  expect(result.response).toContain("EXACT_123");
  expect(prompts.length).toBeGreaterThan(2);
  expect(prompts.length).toBeLessThanOrEqual(25);
  expect(prompts.every(p => p.includes("ORIGINAL_SUMMARY_TEMPLATE") && Buffer.byteLength(p) < 24000)).toBe(true);
  expect(prompts.some(p => p.includes("RECENT_FACT"))).toBe(true);
  await expect(runSummary([{ role: "user", content: "context" }], settings, async () => ({ response: "partial", result: { stopReason: "max_tokens" } }))).rejects.toThrow("Incomplete");
  await expect(runSummary([{ role: "system", content: "fixed".repeat(6000) }], settings, run)).rejects.toThrow("exhaust");
});

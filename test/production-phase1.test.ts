import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionPool } from "../src/session-pool.js";
import { SessionStore, ownershipKey } from "../src/session-store.js";
import { observeContext, readContextSnapshot } from "../src/telemetry.js";
import { historyCharacterLimit } from "../src/budget.js";
import { buildBoundedHistory, type HostMessage } from "../src/prompt.js";

const fixture = join(import.meta.dir, "fixtures/fake-acp.mjs");
const keys = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS", "FAKE_ACP_LOAD_MODE", "FAKE_ACP_STATE_FILE", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_NO_USAGE"];
let saved: Array<string | undefined>;
let root: string;
beforeEach(async () => {
  saved = keys.map(key => process.env[key]);
  root = await mkdtemp(`${process.env.TMPDIR || "/tmp/opencode"}/phase1-`);
  for (const key of keys) delete process.env[key];
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = root;
  process.env.FAKE_ACP_PROMPT_LOG = join(root, "prompts.jsonl");
  await chmod(fixture, 0o755);
});
afterEach(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }));
async function execute(pool: SessionPool, messages?: HostMessage[], priorMessages?: HostMessage[], model = "fake-model-low") {
  let answer = "";
  for await (const event of pool.turn({ key: "conversation", hostSessionID: "host", messages, priorMessages, prompt: [{ type: "text", text: "CURRENT_REQUEST" }], settings: { cwd: process.cwd(), model, executable: fixture } })) {
    if (event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") answer += event.update.content.text;
  }
  return answer;
}
async function prompts() { return (await readFile(join(root, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); }

for (const mode of ["missing", "unsupported", "method-unsupported", "not-resumable", "rejected", "auth"]) test(`restart load ${mode} reconstructs or fails closed`, async () => {
  const first = new SessionPool();
  const initial = [{ role: "user", content: "remember FAKE_MEMORY SECRET_A" }];
  let answer: string;
  try { answer = await execute(first, initial); } finally { await first.close(); }
  const before = await new SessionStore().get("conversation");
  process.env.FAKE_ACP_LOAD_MODE = mode;
  const second = new SessionPool();
  try {
    const messages = [...initial, { role: "assistant", content: answer! }, { role: "user", content: "QUEUED_ONE" }, { role: "system", content: "INSTRUCTION_UPDATE" }, { role: "user", content: "what did you remember? What was the secret? QUEUED_TWO" }];
    if (mode === "rejected" || mode === "auth") {
      await expect(execute(second, messages)).rejects.toThrow();
      expect(await prompts()).toHaveLength(1);
    } else {
      expect(await execute(second, messages)).toContain("FAKE_MEMORY");
      const sent = (await prompts()).at(-1).text;
      for (const item of ["SECRET_A", "QUEUED_ONE", "INSTRUCTION_UPDATE", "QUEUED_TWO"]) expect(sent).toContain(item);
      expect((await new SessionStore().get("conversation"))!.executionGeneration).not.toBe(before!.executionGeneration);
    }
  } finally { await second.close(); }
});

test("durable generations reject late occupancy even when source ID is reused", async () => {
  const store = new SessionStore();
  await store.saveExecutionBinding("host", { generation: "old", sourceSessionID: "same" });
  await observeContext("host", 0, "same", "model", { used: 12, size: 1000 }, undefined, undefined, "old");
  expect((await readContextSnapshot("host")).state).toBe("measured");
  await store.saveExecutionBinding("host", { generation: "new", sourceSessionID: "same" });
  expect((await readContextSnapshot("host")).state).toBe("unknown");
  await observeContext("host", 0, "same", "model", { used: 99, size: 1000 }, undefined, undefined, "old");
  expect((await readContextSnapshot("host")).state).toBe("unknown");
  await observeContext("host", 0, "same", "model", { used: 1, size: 1000 }, undefined, undefined, "new");
  expect(await readContextSnapshot("host")).toMatchObject({ state: "measured", used: 1 });
});

for (const replacement of ["edit", "profile", "lost-resume"]) test(`${replacement} leaves occupancy unknown without replacement usage`, async () => {
  const first = new SessionPool();
  const initial = [{ role: "user", content: "SECRET_A" }];
  let answer: string;
  try { answer = await execute(first, initial); } finally { await first.close(); }
  expect((await readContextSnapshot("host")).state).toBe("measured");
  const old = (await new SessionStore().executionBinding("host"))!;
  process.env.FAKE_ACP_NO_USAGE = "1";
  if (replacement === "lost-resume") process.env.FAKE_ACP_LOAD_MODE = "missing";
  const second = new SessionPool();
  try {
    await execute(second, replacement === "edit" ? [{ role: "user", content: "SECRET_B" }] : [...initial, { role: "assistant", content: answer! }, { role: "user", content: "CONTINUE" }], undefined, replacement === "profile" ? "gemini-3.8-flash-low" : "fake-model-low");
    expect((await readContextSnapshot("host")).state).toBe("unknown");
    await observeContext("host", 0, old.sourceSessionID, "model", { used: 999, size: 1000 }, undefined, undefined, old.generation);
    expect((await readContextSnapshot("host")).state).toBe("unknown");
    if (replacement === "edit") expect((await prompts()).at(-1).text).not.toContain("SECRET_A");
  } finally { await second.close(); }
});

test("real host owner prevents metadata prune and deletion without lock-order waits", async () => {
  const store = new SessionStore();
  await store.set("conversation", { version: 1, sessionId: "s", model: "m", cwd: root, cliVersion: null, createdAt: 1, updatedAt: 1, lastUsedAt: 1, conversation: { version: 1, epoch: 0, boundary: [], instructions: "", hostSessionID: "host", resumable: true } });
  await store.saveReceipt("conversation", "parked", { state: "parked" });
  const module = join(import.meta.dir, "../src/session-store.ts");
  const child = Bun.spawn([process.execPath, "--eval", `const { SessionStore, ownershipKey } = await import(${JSON.stringify(module)}); const store = new SessionStore(); const release = await store.lockTurn(ownershipKey("conversation", "host")); console.log("locked"); await Bun.stdin.text(); await release();`], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    const started = Date.now();
    await store.prune(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await store.get("conversation")).toBeDefined();
    expect((await store.receipt("conversation", "parked"))?.state).toBe("parked");
    await expect(store.delete("conversation")).rejects.toThrow("busy");
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await store.prune(0);
    expect(await store.get("conversation")).toBeUndefined();
    expect(ownershipKey("legacy")).toBe("legacy");
  } finally { reader.releaseLock(); child.kill(); await child.exited; }
});

test("host deletion waits for ownership, removes execution provenance, and preserves other hosts", async () => {
  const store = new SessionStore();
  await store.saveExecutionBinding("host", { generation: "old", sourceSessionID: "source" });
  await store.saveExecutionBinding("other", { generation: "other", sourceSessionID: "unrelated" });
  const module = join(import.meta.dir, "../src/session-store.ts");
  const child = Bun.spawn([process.execPath, "--eval", `const { SessionStore } = await import(${JSON.stringify(module)}); const release = await new SessionStore().lockTurn("host:host"); console.log("locked"); await Bun.stdin.text(); await release();`], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let deleting: Promise<void> | undefined;
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    deleting = store.removeHostSession("host");
    for (let i = 0; i < 100 && !await store.isHostDeleted("host"); i++) await Bun.sleep(5);
    expect(await store.isHostDeleted("host")).toBe(true);
    expect(await store.executionBinding("host")).toBeDefined();
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await deleting;
    expect(await store.executionBinding("host")).toBeUndefined();
    expect(await store.executionBinding("other")).toMatchObject({ generation: "other" });
    expect(await store.deletedHosts()).not.toContain("host");
  } finally { reader.releaseLock(); child.kill(); await child.exited; await deleting; }
});

test("stale host ownership is reclaimed", async () => {
  const store = new SessionStore();
  const base = { sessionId: "s", model: "m", cwd: root, cliVersion: null, createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
  await store.set("conversation", { ...base, version: 1, conversation: { version: 1, epoch: 0, boundary: [], instructions: "", hostSessionID: "host", resumable: true } });
  const module = join(import.meta.dir, "../src/session-store.ts");
  const child = Bun.spawn([process.execPath, "--eval", `const { SessionStore } = await import(${JSON.stringify(module)}); await new SessionStore().lockTurn("host:host"); console.log("locked"); await Bun.stdin.text();`], { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    child.kill("SIGKILL"); await child.exited;
    await store.prune(0);
    expect(await store.get("conversation")).toBeUndefined();
  } finally { reader.releaseLock(); child.kill(); await child.exited; }
});

test("failed resume rebuild preserves completed host tool results and their identity", async () => {
  const first = new SessionPool();
  const initial = [{ role: "user", content: "ORIGINAL_REQUEST" }];
  let answer: string;
  try { answer = await execute(first, initial); } finally { await first.close(); }
  process.env.FAKE_ACP_LOAD_MODE = "missing";
  const second = new SessionPool();
  try {
    await execute(second, [...initial, { role: "assistant", content: answer! },
      { role: "assistant", content: [{ type: "tool_use", id: "completed-call", name: "read", input: { path: "fixture" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "completed-call", content: [{ type: "text", text: "DURABLE_TOOL_RESULT" }] }] },
      { role: "user", content: "CONTINUE_WITH_RESULT" }]);
    const sent = (await prompts()).at(-1).text;
    expect(sent).toContain("completed-call");
    expect(sent).toContain("DURABLE_TOOL_RESULT");
    expect(sent).toContain("CONTINUE_WITH_RESULT");
  } finally { await second.close(); }
});

for (const canonical of [true, false]) test(`1024 character cap bounds rendered history (${canonical ? "messages" : "priorMessages"})`, async () => {
  process.env.OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS = "1024";
  const pool = new SessionPool();
  const history = [{ role: "user", content: "H".repeat(10000) }, { role: "assistant", content: "recent" }];
  try {
    await execute(pool, canonical ? [...history, { role: "user", content: "CURRENT_REQUEST" }] : undefined, canonical ? undefined : history);
    const sent = (await prompts())[0].text;
    expect(sent).toContain("CURRENT_REQUEST");
    expect(sent.match(/H/g)?.length ?? 0).toBeLessThan(1024);
    expect(buildBoundedHistory(history).length).toBeLessThanOrEqual(1024);
  } finally { await pool.close(); }
});

test("invalid history limits use the default", () => {
  for (const invalid of ["", "-1", "0", "1.5", "Infinity", "oops"]) {
    process.env.OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS = invalid;
    expect(historyCharacterLimit()).toBe(100000);
  }
});

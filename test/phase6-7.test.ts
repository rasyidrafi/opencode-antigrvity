import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "../src/file-lock.js";
import { effectiveAuth } from "../src/effective-auth.js";
import { hostResults, readMcpBody, mcpProgressResponse } from "../src/host-tools.js";
import { SessionStore } from "../src/session-store.js";
import { acpModelCatalog, resolveAcpModelSelection } from "../src/models.js";
import { assertHostToolCompatibility } from "../src/acp-compatibility.js";
import { pruneUtilityArtifacts } from "../src/retention.js";
import { SessionPool } from "../src/session-pool.js";
import { getEventListeners } from "node:events";

async function isolatedData(): Promise<() => Promise<void>> {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  const gemini = process.env.GEMINI_HOME;
  const path = await mkdtemp("/tmp/opencode/agy-phase67-");
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = path;
  process.env.GEMINI_HOME = join(path, "gemini");
  return async () => {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR; else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
    if (gemini === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = gemini;
    await rm(path, { recursive: true, force: true });
  };
}

test("successful turns do not accumulate abort listeners", async () => {
  const restore = await isolatedData();
  const pool = new SessionPool();
  const controller = new AbortController();
  const signal = (pool as any).lifecycleController.signal;
  const baseline = getEventListeners(signal, "abort").length;
  try {
    for (let i = 0; i < 5; i++) {
      for await (const _ of pool.turn({ key: "listener-success", requestId: `listener-success-${i}`, prompt: [{ type: "text", text: "hello" }], signal: controller.signal,
        settings: { cwd: process.cwd(), model: "fake-model-low", executable: join(import.meta.dir, "fixtures/fake-acp.mjs") } })) {}
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(signal, "abort")).toHaveLength(baseline);
    }
  } finally { await pool.close(); await restore(); }
});

test("capacity evicts completed idle workers and never evicts active work", async () => {
  const restore = await isolatedData();
  const oldCapacity = process.env.OPENCODE_ANTIGRAVITY_MAX_SESSIONS;
  process.env.OPENCODE_ANTIGRAVITY_MAX_SESSIONS = "1";
  const pool = new SessionPool();
  try {
    const settings = { cwd: process.cwd(), model: "fake-model-low", executable: join(import.meta.dir, "fixtures/fake-acp.mjs") };
    const turn = (key: string, text: string) => pool.turn({ key, prompt: [{ type: "text", text }], settings, requestId: key });
    for await (const _ of turn("capacity-completed", "hi")) {}
    for await (const _ of turn("capacity-replacement", "hi")) {}
    expect(pool.size).toBe(1);
    expect((await pool.status("capacity-completed")).workerState).toBe("none");
    // Use a fresh logical request identity rather than replaying its completion.
    const pending = pool.turn({ key: "capacity-active", prompt: [{ type: "text", text: "FAKE_HANG" }], settings, requestId: "new-active" }).next();
    await Bun.sleep(30);
    await expect(turn("capacity-blocked", "hi").next()).rejects.toThrow(/session limit/);
    await pool.close();
    await expect(pending).rejects.toThrow();
  } finally {
    await pool.close();
    if (oldCapacity === undefined) delete process.env.OPENCODE_ANTIGRAVITY_MAX_SESSIONS; else process.env.OPENCODE_ANTIGRAVITY_MAX_SESSIONS = oldCapacity;
    await restore();
  }
});

test("utility retention removes dead abandoned private directories but protects live owners and unrelated paths", async () => {
  const directory = await mkdtemp("/tmp/opencode/agy-utility-gc-");
  try {
    const root = join(directory, "utilities");
    const dead = join(root, "utility-dead");
    const live = join(root, "utility-live");
    const other = join(root, "unrelated");
    await Promise.all([dead, live, other].map(path => mkdir(path, { recursive: true })));
    await writeFile(join(dead, ".owner"), "2147483647:dead");
    const release = await acquireFileLock(join(live, ".owner"));
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await Promise.all([dead, live, other].map(path => utimes(path, old, old)));
    await pruneUtilityArtifacts(directory);
    expect((await readdir(root)).sort()).toEqual(["unrelated", "utility-live"]);
    await release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unknown ACP overrides fail closed regardless of version text", async () => {
  await expect(assertHostToolCompatibility(join(import.meta.dir, "fixtures/fake-acp.mjs"))).rejects.toThrow(/no tested host-tool isolation profile/);
});

test("lock release cannot delete a replacement owner; dead reaper and primary recover", async () => {
  const directory = await mkdtemp("/tmp/opencode/agy-lock-");
  try {
    const path = join(directory, "turn.lock");
    const release = await acquireFileLock(path);
    await writeFile(path, `${process.pid}:replacement`);
    await release();
    expect(await readFile(path, "utf8")).toContain("replacement");
    await writeFile(path, "2147483647:dead");
    await writeFile(`${path}.reap`, "2147483647:dead-reaper");
    const recovered = await acquireFileLock(path);
    await recovered();
    let active = 0; let maximum = 0;
    await writeFile(path, "2147483647:dead");
    await writeFile(`${path}.reap`, "2147483647:dead-reaper");
    await Promise.all(Array.from({ length: 12 }, async () => {
      const release = await acquireFileLock(path, 2000);
      active++; maximum = Math.max(maximum, active);
      await Bun.sleep(2); active--;
      await release();
    }));
    expect(maximum).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("effective auth scopes overrides, project/location, endpoint and credential revision without exposing secrets", async () => {
  const home = await mkdtemp("/tmp/opencode/agy-auth-");
  try {
    await mkdir(join(home, "antigravity-acp"));
    await writeFile(join(home, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "oauth-business" }, gcp: { project: "a", location: "us" } }));
    const env = { GEMINI_HOME: home };
    const first = await effectiveAuth(env);
    const override = await effectiveAuth({ ...env, OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD: "oauth-personal" });
    expect(override.settings.auth.type).toBe("oauth-personal");
    expect(override.scope).not.toBe(first.scope);
    expect((await effectiveAuth({ ...env, GOOGLE_CLOUD_LOCATION: "eu" })).scope).not.toBe(first.scope);
    const adcDirectory = join(home, "gcloud");
    await mkdir(adcDirectory);
    const adcEnv = { ...env, CLOUDSDK_CONFIG: adcDirectory };
    const beforeAdc = await effectiveAuth(adcEnv);
    await writeFile(join(adcDirectory, "application_default_credentials.json"), JSON.stringify({ refresh_token: "synthetic-private-revision" }));
    expect((await effectiveAuth(adcEnv)).scope).not.toBe(beforeAdc.scope);
    expect(first.scope).toMatch(/^[a-f0-9]{64}$/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("session current low selection does not mutate family default", () => {
  const entries: Array<[string, string]> = [["foo-high", "Foo (High)"], ["foo-low", "Foo (Low)"]];
  const high = acpModelCatalog("fake", null, entries, "foo-high");
  const low = acpModelCatalog("fake", null, entries, "foo-low");
  expect(resolveAcpModelSelection("foo", undefined, low).acpModel).toBe(resolveAcpModelSelection("foo", undefined, high).acpModel);
  expect(resolveAcpModelSelection("foo", "low", low).acpModel).toBe("foo-low");
});

test("promoted result images associate only an unambiguous immediate group", () => {
  const image = { type: "image", source: { type: "base64", data: "AA==", media_type: "image/png" } };
  const result = { type: "tool_result", tool_use_id: "call", content: "ok" };
  expect(hostResults([{ role: "user", content: [result, image] }]).get("call")?.content).toHaveLength(2);
  expect(hostResults([{ role: "user", content: [result, { type: "text", text: "steering" }, image] }]).get("call")?.content).toHaveLength(1);
  expect(hostResults([{ role: "user", content: [result, { ...result, tool_use_id: "other" }, image] }]).get("other")?.content).toHaveLength(1);
});

test("MCP chunked body limit and read deadline are bounded", async () => {
  await expect(readMcpBody(new Request("http://localhost", { method: "POST", body: "oversized" }), 2)).rejects.toThrow(/too large/);
  const stream = new ReadableStream({ start() {} });
  await expect(readMcpBody(new Request("http://localhost", { method: "POST", body: stream, duplex: "half" } as RequestInit), 1024, 10)).rejects.toThrow(/deadline/);
});

test("MCP opted-in progress and keepalive stop with the actual terminal result", async () => {
  let finish!: (value: unknown) => void;
  const promise = new Promise(resolve => { finish = resolve; });
  const response = mcpProgressResponse("request", "progress-token", promise, () => {}, 5);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('"method":"notifications/progress"');
  expect(first).toContain('"progress":0');
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(": keepalive");
  finish({ content: [{ type: "text", text: "actual result" }] });
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("actual result");
  expect((await reader.read()).done).toBe(true);
  let cancelled = false;
  let reject!: (error: Error) => void;
  const cancelledResponse = mcpProgressResponse(2, "token", new Promise((_, fail) => { reject = fail; }), () => { cancelled = true; reject(new Error("cancelled")); }, 5);
  await cancelledResponse.body!.cancel();
  expect(cancelled).toBe(true);
});

test("ancillary corruption is privately quarantined without authorizing absent-record recovery", async () => {
  const restore = await isolatedData();
  try {
    const store = new SessionStore();
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    for (const name of ["context", "lifecycle", "auto-compaction"]) {
      await mkdir(join(root, name));
      const { createHash } = await import("node:crypto");
      await writeFile(join(root, name, `${createHash("sha256").update("corrupt").digest("hex")}.json`), "invalid JSON");
    }
    await expect(store.contextSnapshot("corrupt")).rejects.toThrow();
    await expect(store.lifecycle("corrupt")).rejects.toThrow();
    await expect(store.autoAdmission("corrupt")).rejects.toThrow();
    await expect(store.lifecycle("corrupt")).rejects.toThrow();
    expect(await readdir(join(root, "quarantine"))).toHaveLength(3);
    await store.saveToolCall("corrupt-tools", "call", { call: { id: "call", name: "shell", input: {} } });
    const { createHash } = await import("node:crypto");
    await writeFile(join(root, "tools", createHash("sha256").update("corrupt-tools").digest("hex"), `${createHash("sha256").update("call").digest("hex")}.json`), "broken tool JSON");
    await expect(store.toolCall("corrupt-tools", "call")).rejects.toThrow();
    expect(await readdir(join(root, "quarantine"))).toHaveLength(4);
  } finally { await restore(); }
});

test("session deletion tombstones late writers and waits for active ownership before removing indexed payloads", async () => {
  const restore = await isolatedData();
  try {
    const store = new SessionStore();
    const key = "deleted-record";
    const host = "deleted-host";
    await store.set(key, { version: 1, sessionId: "remote", model: "fake", cwd: process.cwd(), cliVersion: null, createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: Date.now(), conversation: { version: 1, epoch: 0, hostSessionID: host, boundary: [], instructions: "", resumable: false } });
    await store.saveReceipt(key, "request", { state: "completed", events: [] });
    await store.saveToolCall(key, "call", { hostSessionID: host, call: { id: "call", name: "shell", input: {} }, profile: '{"model":"fake","tools":[{"input_schema":{},"name":"shell"}]}' });
    const release = await store.lockTurn(`host:${host}`);
    const cleanup = store.removeHostSession(host);
    await Bun.sleep(20);
    expect(await store.isHostDeleted(host)).toBe(true);
    expect(await store.get(key)).toBeDefined();
    await expect(store.saveToolResult(key, "call", { content: [], isError: false })).rejects.toThrow(/deleted/);
    await release();
    await cleanup;
    expect(await store.get(key)).toBeUndefined();
    expect(await store.toolCall(key, "call")).toBeUndefined();
    expect(await store.receipt(key, "request")).toBeUndefined();
    expect(await store.isHostDeleted(host)).toBe(true);
  } finally { await restore(); }
});

test("authoritative checkpoints deduplicate late/concurrent events without retiring newer work", async () => {
  const restore = await isolatedData();
  try {
    const store = new SessionStore();
    await store.reconcileHostCheckpoints("checkpoint-host", [], false);
    await store.reconcileHostCheckpoints("checkpoint-host", ["msg_checkpoint"], true);
    let retired = 0;
    const retire = async () => { retired++; };
    await Promise.all([store.applyAuthoritativeCompactionEvent("checkpoint-host", "evt_late_checkpoint", ["msg_checkpoint"], retire), store.applyAuthoritativeCompactionEvent("checkpoint-host", "evt_late_checkpoint", ["msg_checkpoint"], retire)]);
    expect(retired).toBe(0);
    expect((await store.lifecycle("checkpoint-host")).epoch).toBe(1);
    await Promise.all([store.applyAuthoritativeCompactionEvent("checkpoint-host", "evt_new_checkpoint", ["msg_new_checkpoint"], retire), store.applyAuthoritativeCompactionEvent("checkpoint-host", "evt_new_checkpoint", ["msg_new_checkpoint"], retire)]);
    expect(retired).toBe(1);
    expect((await store.lifecycle("checkpoint-host")).epoch).toBe(2);
  } finally { await restore(); }
});

for (const winner of ["hook", "event"] as const) test(`checkpoint hook/${winner} interleaving re-reads state and never joins a newer turn`, async () => {
  const restore = await isolatedData();
  let releaseOld: (() => Promise<void>) | undefined;
  let releaseNew: (() => Promise<void>) | undefined;
  let resume!: () => void;
  try {
    const store = new SessionStore();
    const host = `interleave-${winner}`;
    await store.reconcileHostCheckpoints(host, [], false);
    releaseOld = await store.lockTurn(`host:${host}`);
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    let retired = 0;
    const retire = async () => { retired++; await releaseOld!(); releaseOld = undefined; };
    const delayedHook = (async () => { enter(); await resumed; return store.reconcileHostCheckpointBoundary(host, ["msg_checkpoint"], retire); })();
    await entered;
    if (winner === "hook") await store.reconcileHostCheckpointBoundary(host, ["msg_checkpoint"], retire);
    else await store.applyAuthoritativeCompactionEvent(host, "evt_checkpoint", ["msg_checkpoint"], retire);
    releaseNew = await store.lockTurn(`host:${host}`);
    resume();
    // The new parked owner remains held: any accidental join/turn-lock wait
    // would time out, even though no retirement of that owner is permissible.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { expect(await Promise.race([delayedHook, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reconciliation waited on its newer parked owner")), 1000); })])).toBe(false); }
    finally { clearTimeout(timer); }
    expect(retired).toBe(1);
    expect((await store.lifecycle(host)).epoch).toBe(1);
    if (winner === "event") await store.applyAuthoritativeCompactionEvent(host, "evt_checkpoint_alias", ["msg_checkpoint"], retire);
    expect(retired).toBe(1);
  } finally { resume?.(); await releaseNew?.(); await releaseOld?.(); await restore(); }
});

test("seven-day completed payload retention keeps replay tombstones and protects parked records", async () => {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  const directory = await mkdtemp("/tmp/opencode/agy-retention-");
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  try {
    const store = new SessionStore();
    await store.saveReceipt("session", "done", { state: "completed", events: [] });
    await store.saveReceipt("session", "parked", { state: "parked", events: [] });
    const large = { content: [{ type: "text", text: "x".repeat(70_000) }], isError: false };
    for (const requestId of ["done", "parked"]) {
      await store.saveToolCall("session", requestId, { call: { id: requestId, name: "shell", input: {} }, requestId, hostSessionID: "host", profile: '{"model":"fake","tools":[{"input_schema":{},"name":"shell"}]}' });
      await store.saveToolResult("session", requestId, large);
    }
    await store.pruneCompletedToolPayloads(Date.now() + 8 * 24 * 60 * 60_000);
    expect((await store.toolCall("session", "done"))?.result).toBeUndefined();
    expect((await store.toolCall("session", "done"))?.resultDigest).toBeDefined();
    expect((await store.toolCall("session", "parked"))?.result).toEqual(large);
    await store.saveToolResult("session", "done", large);
    expect((await store.toolCall("session", "done"))?.result).toEqual(large);
    await expect(store.saveToolResult("session", "done", { content: [], isError: false })).rejects.toThrow(/Conflicting/);
    await store.pruneCompletedPayloads(Date.now() + 8 * 24 * 60 * 60_000);
    expect(await store.receipt("session", "done")).toMatchObject({ state: "completed" });
    expect((await store.receipt("session", "done"))?.events).toBeUndefined();
    expect((await store.receipt("session", "parked"))?.events).toEqual([]);
    const sub = (await readdir(join(directory, "requests")))[0];
    const files = await readdir(join(directory, "requests", sub));
    for (const file of files) await writeFile(join(directory, "requests", sub, file), "broken-json");
    await expect(store.receipt("session", "done")).rejects.toThrow();
    expect((await store.receipt("session", "done"))?.state).toBe("uncertain");
    expect(await readdir(join(directory, "quarantine"))).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR; else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { useFixtureAuthentication } from "./fixtures/compatibility.js";
useFixtureAuthentication();
import { SessionPool } from "../src/session-pool.js";
import { sessionStore } from "../src/session-store.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const contexts = new Map<string, Array<{ role: string; content: string }>>();

async function turn(pool: SessionPool, key: string, prompt: string): Promise<string> {
  let response = "";
  const messages = [...(contexts.get(key) ?? []), { role: "user", content: prompt }];
  for await (const event of pool.turn({
    key,
    messages,
    prompt: [{ type: "text", text: prompt }],
    settings: { cwd: process.cwd(), model: "fake-model-low", executable: fixture },
  })) {
    if (event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") response += event.update.content.text;
  }
  contexts.set(key, [...messages, { role: "assistant", content: response }]);
  return response;
}

describe("session pool isolation", () => {
  test("host turn paused before admission waits for forget", async () => {
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "agy-forget-host-"));
    const pool = new SessionPool();
    const key = `host-forget-${process.env.OPENCODE_ANTIGRAVITY_DATA_DIR}`;
    const host = `${key}-host`;
    const run = async (text: string) => {
      for await (const _ of pool.turn({ key, hostSessionID: host, messages: [{ role: "user", content: text }], prompt: [{ type: "text", text }], settings: { cwd: process.cwd(), model: "fake-model-low", executable: fixture } })) { /* consume */ }
    };
    await run("first");
    let lookupReached!: () => void; let releaseLookup!: () => void;
    let deletionReached!: () => void; let releaseDeletion!: () => void;
    const lookupWait = new Promise<void>(resolve => { lookupReached = resolve; });
    const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve; });
    const deletionWait = new Promise<void>(resolve => { deletionReached = resolve; });
    const deletionGate = new Promise<void>(resolve => { releaseDeletion = resolve; });
    const lookup = sessionStore.isHostDeleted.bind(sessionStore);
    const remove = sessionStore.delete.bind(sessionStore);
    let pause = true;
    const lookupSpy = spyOn(sessionStore, "isHostDeleted").mockImplementation(async id => {
      if (id === host && pause) { pause = false; lookupReached(); await lookupGate; }
      return id === host ? false : lookup(id);
    });
    const deleteSpy = spyOn(sessionStore, "delete").mockImplementation(async target => { deletionReached(); await deletionGate; return remove(target); });
    const lock = sessionStore.lockTurn.bind(sessionStore);
    let attempted = false;
    const lockSpy = spyOn(sessionStore, "lockTurn").mockImplementation(async (...args) => { if (args[0] === `host:${host}`) attempted = true; return lock(...args); });
    try {
      const next = run("concurrent");
      await lookupWait;
      const forgetting = pool.forget(key);
      await deletionWait;
      releaseLookup();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(attempted).toBe(false);
      releaseDeletion();
      await forgetting; await next;
      expect((await sessionStore.get(key))?.sessionId).toBeDefined();
      expect(await pool.status(key)).toMatchObject({ workerState: "ready" });
    } finally { releaseLookup(); releaseDeletion(); lookupSpy.mockRestore(); deleteSpy.mockRestore(); lockSpy.mockRestore(); await pool.close(); }
  });

  test("admission rechecks forget after awaiting capacity eviction", async () => {
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "agy-forget-eviction-"));
    const pool = new SessionPool({ maxSessions: 1 });
    const idle = `evict-idle-${process.env.OPENCODE_ANTIGRAVITY_DATA_DIR}`;
    const target = `${idle}-target`;
    await turn(pool, idle, "first");
    let evictionReached!: () => void; let releaseEviction!: () => void;
    let deletionReached!: () => void; let releaseDeletion!: () => void;
    const evictionWait = new Promise<void>(resolve => { evictionReached = resolve; });
    const evictionGate = new Promise<void>(resolve => { releaseEviction = resolve; });
    const deletionWait = new Promise<void>(resolve => { deletionReached = resolve; });
    const deletionGate = new Promise<void>(resolve => { releaseDeletion = resolve; });
    const evict = pool.forgetWorker.bind(pool);
    const remove = sessionStore.delete.bind(sessionStore);
    const evictSpy = spyOn(pool, "forgetWorker").mockImplementation(async key => { await evict(key); evictionReached(); await evictionGate; });
    const deleteSpy = spyOn(sessionStore, "delete").mockImplementation(async key => { deletionReached(); await deletionGate; return remove(key); });
    const lock = sessionStore.lockTurn.bind(sessionStore);
    let attempted = false;
    const lockSpy = spyOn(sessionStore, "lockTurn").mockImplementation(async (...args) => { if (args[0] === target) attempted = true; return lock(...args); });
    try {
      const next = turn(pool, target, "new turn");
      await evictionWait;
      const forgetting = pool.forget(target);
      await deletionWait;
      releaseEviction();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(attempted).toBe(false);
      releaseDeletion();
      await forgetting; await next;
      expect((await sessionStore.get(target))?.sessionId).toBeDefined();
      expect(await pool.status(target)).toMatchObject({ workerState: "ready" });
    } finally { releaseEviction(); releaseDeletion(); evictSpy.mockRestore(); deleteSpy.mockRestore(); lockSpy.mockRestore(); await pool.close(); }
  });
  test("forget cannot delete a turn that enters while deletion is pending", async () => {
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "agy-forget-race-"));
    delete process.env.FAKE_ACP_STATE_FILE;
    const pool = new SessionPool();
    const key = `forget-race-${process.env.OPENCODE_ANTIGRAVITY_DATA_DIR}`;
    await turn(pool, key, "first");
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = sessionStore.delete.bind(sessionStore);
    const deletion = spyOn(sessionStore, "delete").mockImplementation(async target => {
      entered(); await gate; return original(target);
    });
    try {
      const forgetting = pool.forget(key);
      await waiting;
      const next = turn(pool, key, "concurrent");
      release();
      await forgetting;
      await next;
      expect((await sessionStore.get(key))?.sessionId).toBeDefined();
      expect(await pool.status(key)).toMatchObject({ workerState: "ready" });
    } finally {
      release(); deletion.mockRestore(); await pool.close();
    }
  });
  test("synthetic ACP trace reuses the worker then rebuilds on a changed MCP endpoint", async () => {
    const data = await mkdtemp(join(tmpdir(), "agy-endpoint-continuity-"));
    const previousData = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    const previousLog = process.env.FAKE_ACP_RPC_LOG;
    const previousState = process.env.FAKE_ACP_STATE_FILE;
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = data;
    process.env.FAKE_ACP_RPC_LOG = join(data, "rpc.jsonl");
    delete process.env.FAKE_ACP_STATE_FILE;
    const key = `endpoint-${data}`;
    const first = new SessionPool();
    const second = new SessionPool();
    const settings = (url?: string) => ({ cwd: process.cwd(), model: "fake-model-low", executable: fixture,
      mcpServers: url ? [{ type: "http" as const, name: "external_tool", url, headers: [] }] : [] });
    const run = async (pool: SessionPool, session: string, messages: Array<{ role: string; content: string }>, url?: string) => {
      const events = [];
      for await (const event of pool.turn({ key: session, messages, prompt: [{ type: "text", text: messages.at(-1)!.content }], settings: settings(url) })) events.push(event);
      return events.filter(event => event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text")
        .map(event => (event as any).update.content.text).join("");
    };
    try {
      const one = [{ role: "user", content: "endpoint first" }];
      const answer = await run(first, key, one, "http://127.0.0.1:1/mcp/secret-one");
      const two = [...one, { role: "assistant", content: answer }, { role: "user", content: "endpoint second" }];
      const answer2 = await run(first, key, two, "http://127.0.0.1:1/mcp/secret-one");
      await first.close();
      const records = await readFile(join(data, "sessions.json"), "utf8");
      expect(records).not.toContain("secret-one");
      await run(second, key, [...two, { role: "assistant", content: answer2 }, { role: "user", content: "endpoint third" }], "http://127.0.0.1:1/mcp/secret-two");
      const log = (await readFile(join(data, "rpc.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const sessions = log.filter(frame => frame.method === "session/new" || frame.method === "session/resume");
      expect(sessions.map(frame => frame.method)).toEqual(["session/new", "session/new"]);
      expect(sessions[1].params.mcpServers[0].url).toEndWith("secret-two");
    } finally {
      await first.close(); await second.close();
      if (previousData === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR; else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previousData;
      if (previousLog === undefined) delete process.env.FAKE_ACP_RPC_LOG; else process.env.FAKE_ACP_RPC_LOG = previousLog;
      if (previousState === undefined) delete process.env.FAKE_ACP_STATE_FILE; else process.env.FAKE_ACP_STATE_FILE = previousState;
    }
  });
  test("closed pools reject requests as non-retryable client errors", async () => {
    const pool = new SessionPool();
    await pool.close();
    await expect(turn(pool, "closed-pool", "never execute")).rejects.toMatchObject({
      code: "agy_pool_closed", kind: "invalid_request", status: 400, retryable: false,
    });
  });

  test("keeps independent workers separate", async () => {
    await chmod(fixture, 0o755);
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-antigravity-pool-"));
    delete process.env.FAKE_ACP_STATE_FILE;
    const pool = new SessionPool({ idleMs: 60_000 });
    try {
      await turn(pool, "session-a", "remember FAKE_MEMORY");
      const other = await turn(pool, "session-b", "what did you remember");
      const original = await turn(pool, "session-a", "what did you remember");
      expect(other).toContain("NOT_REMEMBERED");
      expect(original).toContain("FAKE_MEMORY");
    } finally {
      await pool.close();
    }
  });

  test("evicts by the injected clock, not wall time", async () => {
    await chmod(fixture, 0o755);
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-antigravity-clock-"));
    delete process.env.FAKE_ACP_STATE_FILE;
    let now = 10_000;
    const pool = new SessionPool({ maxSessions: 2, idleMs: 60_000, now: () => now });
    try {
      await turn(pool, "clock-a", "hello");
      now = 5_000;
      await turn(pool, "clock-b", "hello");
      now = 6_000;
      await turn(pool, "clock-c", "hello");
      expect(pool.size).toBe(2);
      // The injected clock says clock-b is oldest even though wall time says
      // clock-a is. Eviction must follow the injected clock.
      expect(await pool.status("clock-b")).toMatchObject({ workerState: "none" });
      expect(await pool.status("clock-a")).toMatchObject({ workerState: "ready" });
      expect(await pool.status("clock-c")).toMatchObject({ workerState: "ready" });
    } finally {
      await pool.close();
    }
  });

  test("persists an ACP session id and resumes it in a new pool", async () => {
    await chmod(fixture, 0o755);
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-antigravity-resume-"));
    process.env.FAKE_ACP_STATE_FILE = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR, "fake-state.json");
    const firstPool = new SessionPool({ idleMs: 60_000 });
    await turn(firstPool, "restart-session", "remember FAKE_MEMORY");
    await firstPool.close();
    const secondPool = new SessionPool({ idleMs: 60_000 });
    try {
      const resumed = await turn(secondPool, "restart-session", "what did you remember");
      expect(resumed).toContain("FAKE_MEMORY");
    } finally {
      await secondPool.close();
    }
  });
});

import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPool, type SessionTurnRequest } from "../src/session-pool.js";
import { SessionStore } from "../src/session-store.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const pools: SessionPool[] = [];
const directories: string[] = [];
const savedEnvironment = { ...process.env };
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  for (const key of ["OPENCODE_ANTIGRAVITY_DATA_DIR", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_STATE_FILE"]) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
});
async function setup() {
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(join(tmpdir(), "agy-retry-"));
  directories.push(directory);
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  delete process.env.FAKE_ACP_STATE_FILE;
  return directory;
}
function pool() { const value = new SessionPool({ maxQueue: 3 }); pools.push(value); return value; }
function request(requestId: string, text = "hello"): SessionTurnRequest {
  return { key: "session", requestId, prompt: [{ type: "text", text }],
    settings: { cwd: process.cwd(), model: "fake-model-low", executable: fixture } };
}
async function collect(events: AsyncIterable<unknown>) {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
}
async function promptCount(directory: string) {
  return (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").length;
}

test("replays completed requests across pools, even after a newer message", async () => {
  const directory = await setup();
  const first = pool();
  const original = await collect(first.turn(request("one")));
  await first.close();
  const second = pool();
  expect(await collect(second.turn(request("one")))).toEqual(original);
  await collect(second.turn(request("two")));
  expect(await collect(second.turn(request("one")))).toEqual(original);
  expect(await promptCount(directory)).toBe(2);
});

test("rejects uncertain retries after failure without sending another prompt", async () => {
  const directory = await setup();
  const first = pool();
  await expect(collect(first.turn(request("failed", "FAKE_EXIT")))).rejects.toThrow();
  await first.close();
  const second = pool();
  await expect(collect(second.turn(request("failed", "FAKE_EXIT")))).rejects.toThrow("already started");
  expect(await promptCount(directory)).toBe(1);
  await collect(second.turn(request("new")));
  expect(await promptCount(directory)).toBe(2);
});

test("does not send a prompt if the started receipt cannot be saved", async () => {
  const directory = await setup();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(directory, "requests"), "not a directory");
  await expect(collect(pool().turn(request("one")))).rejects.toThrow();
  await expect(readFile(join(directory, "prompts.jsonl"))).rejects.toThrow();
});

test("cancelling a queued request leaves later turns behind the active turn", async () => {
  const directory = await setup();
  const sessions = pool();
  const active = sessions.turn(request("active", "FAKE_PAUSE_STREAM"));
  await active.next();
  const abort = new AbortController();
  const queued = collect(sessions.turn({ ...request("queued"), signal: abort.signal }));
  const rejected = queued.catch(error => error);
  abort.abort();
  expect((await rejected).message).toContain("cancelled");
  const later = collect(sessions.turn(request("later")));
  await collect(active);
  await later;
  expect(await promptCount(directory)).toBe(2);
  // A request cancelled before submission remains safe to submit later.
  await collect(sessions.turn(request("queued")));
  expect(await promptCount(directory)).toBe(3);
});

test("another pool cannot mutate a session while its turn is active", async () => {
  await setup();
  const active = pool().turn(request("one", "FAKE_PAUSE_STREAM"));
  await active.next();
  const second = pool();
  await expect(collect(second.turn(request("two")))).rejects.toThrow("busy");
  await collect(active);
  await collect(second.turn(request("two")));
});

test("request receipts survive idle metadata pruning", async () => {
  const directory = await setup();
  await collect(pool().turn(request("one")));
  await new SessionStore().prune(-1);
  await collect(pool().turn(request("one")));
  expect(await promptCount(directory)).toBe(1);
});

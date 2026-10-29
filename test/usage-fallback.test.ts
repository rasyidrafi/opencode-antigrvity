import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { SessionPool, type SessionTurnRequest } from "../src/session-pool.js";
import { SessionStore } from "../src/session-store.js";
import { HostBridge, handleHostMcp } from "../src/host-tools.js";
import { contextOccupancyForExecution, freezeContextOccupancy, readBoundContextOccupancy, type ContextSnapshot } from "../src/telemetry.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const savedEnvironment = { ...process.env };
const pools: SessionPool[] = [];
const directories: string[] = [];
let compatibility: ReturnType<typeof fixtureCompatibility>;

beforeAll(() => { compatibility = fixtureCompatibility(); });
afterAll(() => compatibility.mockRestore());

afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  for (const key of ["OPENCODE_ANTIGRAVITY_DATA_DIR", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_STATE_FILE"]) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
});

async function setup(): Promise<string> {
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(join(tmpdir(), "agy-context-usage-"));
  directories.push(directory);
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  delete process.env.FAKE_ACP_STATE_FILE;
  return directory;
}

function pool(): SessionPool {
  const value = new SessionPool({ maxQueue: 3, idleMs: 60_000 });
  pools.push(value);
  return value;
}

function request(requestId: string, text: string, extra: Partial<SessionTurnRequest> = {}): SessionTurnRequest {
  return {
    key: "usage-session",
    requestId,
    hostSessionID: "usage-host",
    prompt: [{ type: "text", text }],
    settings: { cwd: process.cwd(), model: "fake-model-low", executable: fixture },
    ...extra,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<any[]> {
  const result: any[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function terminal(events: any[]): any {
  return events.findLast(event => event.event === "result");
}

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    version: 1,
    hostSessionID: "usage-host",
    epoch: 2,
    sourceSessionID: "acp-source",
    sequence: 4,
    observedAt: Date.now(),
    used: 101,
    size: 1000,
    state: "measured",
    executionGeneration: "generation-a",
    ...overrides,
  };
}

test("only accepts fresh measurements from the exact bound execution", async () => {
  const now = Date.now();
  const measured = snapshot({ observedAt: now });
  const binding = { generation: "generation-a", sourceSessionID: "acp-source" };
  const candidate = contextOccupancyForExecution(measured, binding, "usage-host", "acp-source", "generation-a", now)!;
  expect(candidate).toEqual({ used: 101, observedAt: now });
  expect(contextOccupancyForExecution(snapshot({ used: 0, observedAt: now }), binding, "usage-host", "acp-source", "generation-a", now)).toEqual({ used: 0, observedAt: now });

  for (const invalid of [
    snapshot({ state: "unknown", observedAt: now }),
    snapshot({ state: "stale", observedAt: now }),
    snapshot({ observedAt: now - 300_000 }),
    snapshot({ observedAt: now + 1 }),
    snapshot({ executionGeneration: "generation-b", observedAt: now }),
    snapshot({ sourceSessionID: "other-source", observedAt: now }),
    snapshot({ used: Number.NaN, observedAt: now }),
    snapshot({ used: 1.5, observedAt: now }),
  ]) {
    expect(contextOccupancyForExecution(invalid, binding, "usage-host", "acp-source", "generation-a", now)).toBeUndefined();
  }
  expect(contextOccupancyForExecution(measured, { ...binding, generation: "generation-b" }, "usage-host", "acp-source", "generation-a", now)).toBeUndefined();
  expect(await readBoundContextOccupancy("usage-host", "acp-source", "generation-a", async () => { throw new Error("unreadable telemetry"); })).toBeUndefined();
  expect(freezeContextOccupancy(candidate, now + 299_000)).toEqual({ used: 101 });
  expect(freezeContextOccupancy(candidate, now + 300_000)).toBeUndefined();
  expect(freezeContextOccupancy(candidate, now + 301_000)).toBeUndefined();
});

test("rechecks a 299-second seed when freezing a terminal response", async () => {
  await setup();
  let scheduledClock: (() => number) | undefined;
  const sessions = new SessionPool({ maxQueue: 3, idleMs: 60_000, now: () => scheduledClock?.() ?? Date.now() });
  pools.push(sessions);
  const seeded = await collect(sessions.turn(request("clock-seed", "FAKE_CONTEXT_A FAKE_NO_RESULT_USAGE")));
  expect(terminal(seeded).contextOccupancy).toEqual({ used: 101 });
  const observedAt = (await new SessionStore().contextSnapshot("usage-host"))!.observedAt!;

  // Simulate a candidate 299 seconds old when the next turn starts, then a
  // two-second turn with no new telemetry. The clock advances by calls rather
  // than sleeping, so this boundary test is deterministic.
  let clockReads = 0;
  scheduledClock = () => ++clockReads === 1 ? observedAt + 299_000 : observedAt + 301_000;
  const later = await collect(sessions.turn(request("clock-later", "FAKE_NO_USAGE_UPDATE FAKE_NO_RESULT_USAGE")));
  expect(clockReads).toBe(2);
  expect(terminal(later).contextOccupancy).toBeUndefined();
});

test("rechecks occupancy across a parked host-tool continuation", async () => {
  await setup();
  let now = Date.now();
  const sessions = new SessionPool({ maxQueue: 3, idleMs: 60_000, now: () => now });
  pools.push(sessions);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handleHostMcp });
  const bridge = new HostBridge("parked-context-usage", "usage-host", process.cwd(), { sessions, now: () => now });
  const tools = [{ name: "host_tool", input_schema: { type: "object" } }];
  const settings = { cwd: process.cwd(), model: "fake-model-low", executable: fixture };
  const base = {
    tools,
    settings,
    baseURL: `http://127.0.0.1:${server.port}`,
    requestId: "parked-context-usage-request",
  };

  try {
    const initialMessages = [{ role: "user", content: "FAKE_MCP_USAGE_BEFORE" }];
    const first = bridge.request({ ...base, messages: initialMessages })[Symbol.asyncIterator]();
    let toolResponse: any;
    while (!toolResponse) {
      const next = await first.next();
      if (next.done) throw new Error("Host bridge ended before exposing its tool response");
      if (next.value.event === "update" && next.value.update.sessionUpdate === "usage_update") {
        const observedAt = (await new SessionStore().contextSnapshot("usage-host"))!.observedAt!;
        now = observedAt + 299_000;
      }
      if (next.value.event === "host_tools") toolResponse = next.value;
    }
    expect(toolResponse.contextOccupancy).toEqual({ used: 21 });
    expect((await first.next()).done).toBe(true);

    // The host holds the tool response while the ACP turn is parked. Continue
    // two simulated seconds later without another usage_update.
    const observedAt = (await new SessionStore().contextSnapshot("usage-host"))!.observedAt!;
    now = observedAt + 301_000;
    const call = toolResponse.calls[0];
    const continuationMessages = [
      ...initialMessages,
      { role: "assistant", content: [call] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "host completed" }] },
    ];
    const continued = await collect(bridge.request({ ...base, messages: continuationMessages }));
    expect(terminal(continued).contextOccupancy).toBeUndefined();
  } finally {
    await bridge.close();
    server.stop(true);
  }
});

test("completed receipts replay their response occupancy after another generation replaces telemetry", async () => {
  const directory = await setup();
  const firstPool = pool();
  const textA = "FAKE_CONTEXT_A FAKE_NO_RESULT_USAGE";
  const requestA = request("response-a", textA, { messages: [{ role: "user", content: textA }] });
  const original = await collect(firstPool.turn(requestA));
  expect(terminal(original).contextOccupancy).toEqual({ used: 101 });
  const observedAt = (await new SessionStore().contextSnapshot("usage-host"))!.observedAt!;
  expect((await new SessionStore().receipt("usage-session", "response-a"))?.events?.at(-1)).toMatchObject({ contextOccupancy: { used: 101 } });

  const textB = "FAKE_CONTEXT_B FAKE_NO_USAGE_UPDATE FAKE_NO_RESULT_USAGE";
  const replaced = await collect(firstPool.turn(request("response-b", textB, { messages: [{ role: "user", content: textB }] })));
  expect(terminal(replaced).contextOccupancy).toBeUndefined();
  expect(await new SessionStore().executionBinding("usage-host")).toMatchObject({ sourceSessionID: expect.any(String) });

  await firstPool.close();
  pools.splice(pools.indexOf(firstPool), 1);
  const restarted = new SessionPool({ maxQueue: 3, idleMs: 60_000, now: () => observedAt + 301_000 });
  pools.push(restarted);
  const replay = await collect(restarted.turn(requestA));
  expect(replay).toEqual(original);
  expect(terminal(replay).contextOccupancy).toEqual({ used: 101 });
  expect((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
});

test("queued turn handoff cannot replace the previous response's occupancy", async () => {
  await setup();
  const sessions = pool();
  const first = sessions.turn(request("queued-a", "FAKE_CONTEXT_A FAKE_NO_RESULT_USAGE"))[Symbol.asyncIterator]();
  let firstResult: any;
  while (!firstResult) {
    const next = await first.next();
    if (next.done) throw new Error("First turn ended without a result");
    if (next.value.event === "result") firstResult = next.value;
  }
  expect(firstResult.contextOccupancy).toEqual({ used: 101 });

  // Starting B's iterator queues it behind A while A is suspended on its
  // terminal event. No timer or timing assumption is needed for this handoff.
  const second = sessions.turn(request("queued-b", "FAKE_CONTEXT_B FAKE_NO_RESULT_USAGE"))[Symbol.asyncIterator]();
  const pendingSecond = second.next();
  await first.next();

  const secondEvents: any[] = [];
  let next = await pendingSecond;
  while (!next.done) {
    secondEvents.push(next.value);
    next = await second.next();
  }
  expect(terminal(secondEvents).contextOccupancy).toEqual({ used: 202 });
  expect((await new SessionStore().contextSnapshot("usage-host"))?.used).toBe(202);
  expect(firstResult.contextOccupancy).toEqual({ used: 101 });
});

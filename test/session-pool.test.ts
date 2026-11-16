import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { useFixtureAuthentication } from "./fixtures/compatibility.js";
useFixtureAuthentication();
import { SessionPool } from "../src/session-pool.js";

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

import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SessionPool } from "../src/session-pool.js";
import { SessionStore } from "../src/session-store.js";
import type { AcpEvent } from "../src/protocol.js";
import { collectTurn, hostVisibleContent } from "../src/translate.js";
import type { HostMessage } from "../src/prompt.js";

test("synthetic ACP compaction notifications preserve worker, session ID, and epochs without prior prompt replay", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "internal-compaction-"));
  const names = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_PID_LOG", "FAKE_ACP_STATE_FILE"];
  const previous = names.map(name => process.env[name]);
  const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
  await chmod(fixture, 0o755);
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  process.env.FAKE_ACP_PID_LOG = join(directory, "pids");
  delete process.env.FAKE_ACP_STATE_FILE;
  const pool = new SessionPool();
  const store = new SessionStore();
  const messages: HostMessage[] = [];
  const events: AcpEvent[] = [];
  async function turn(text: string) {
    messages.push({ role: "user", content: text });
    let answer = "";
    const turnEvents: AcpEvent[] = [];
    for await (const event of pool.turn({ key: "internal", hostSessionID: "host-internal", messages,
      prompt: [{ type: "text", text }], settings: { cwd: process.cwd(), model: "fake-model-low", executable: fixture } })) {
      events.push(event);
      turnEvents.push(event);
      if (event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") answer += event.update.content.text;
    }
    const collected = await collectTurn((async function* () { yield* turnEvents; })());
    messages.push({ role: "assistant", content: hostVisibleContent(collected.segments) });
    return answer;
  }
  try {
    await turn("remember FAKE_MEMORY");
    const before = await store.get("internal");
    await turn("FAKE_INTERNAL_COMPACTION");
    expect(await turn("what did you remember")).toContain("FAKE_MEMORY");
    const after = await store.get("internal");
    expect(after!.sessionId).toBe(before!.sessionId);
    expect(after!.conversation!.epoch).toBe(before!.conversation!.epoch);
    expect(after!.conversation!.hostEpoch).toBe(before!.conversation!.hostEpoch);
    expect((await store.lifecycle("host-internal")).epoch).toBe(0);
    expect((await readFile(join(directory, "pids"), "utf8")).trim().split("\n")).toHaveLength(1);
    const prompts = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).text);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).not.toContain("remember FAKE_MEMORY");
    expect(prompts[2]).not.toContain("FAKE_INTERNAL_COMPACTION");
    expect(prompts[2]).not.toContain("remember FAKE_MEMORY");
    const updates = events.filter(event => event.event === "update").map(event => event.update as { sessionUpdate: string; used?: number; status?: string });
    const index = updates.findIndex(update => update.sessionUpdate === "usage_update" && update.used === 950);
    expect(updates.slice(index, index + 4).map(update => [update.sessionUpdate, update.used ?? update.status])).toEqual([
      ["usage_update", 950], ["compaction_update", "in_progress"], ["compaction_update", "completed"], ["usage_update", 100],
    ]);
    expect(events.filter(event => event.event === "result")).toHaveLength(3);
  } finally {
    await pool.close();
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    await rm(directory, { recursive: true, force: true });
  }
});

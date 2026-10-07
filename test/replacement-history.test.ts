import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as acpProcess from "../src/acp-process.js";
import { SessionPool } from "../src/session-pool.js";
import { SessionStore } from "../src/session-store.js";

for (const idle of [false, true]) test(`failed replacement preserves accepted history (${idle ? "idle" : "warm"})`, async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "replacement-history-"));
  const keys = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "FAKE_ACP_STATE_FILE", "FAKE_ACP_PROMPT_LOG"];
  const saved = keys.map(key => process.env[key]);
  const first = new SessionPool(), restarted = new SessionPool(), afterIdle = new SessionPool();
  let startup: ReturnType<typeof spyOn> | undefined;
  try {
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = root;
    process.env.FAKE_ACP_STATE_FILE = join(root, "memory.json");
    process.env.FAKE_ACP_PROMPT_LOG = join(root, "prompts.jsonl");
    const execute = async (pool: SessionPool, messages: Array<{ role: string; content: string }>) => {
      let answer = "";
      for await (const event of pool.turn({ key: "conversation", hostSessionID: "host", messages,
        prompt: [{ type: "text", text: "request" }], settings: { cwd: process.cwd(), model: "fake-model-low", executable: resolve("test/fixtures/fake-acp.mjs") } })) {
        if (event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") answer += event.update.content.text;
      }
      return answer;
    };
    const initial = [{ role: "user", content: "remember FAKE_MEMORY ORIGINAL_CAUSAL_DETAIL" }];
    const answer = await execute(first, initial);
    const store = new SessionStore(), before = (await store.get("conversation"))!;
    if (idle) await first.close();
    const pool = idle ? restarted : first;
    startup = spyOn(acpProcess, "createAcpWorker").mockImplementation(async () => { throw new Error("TEST_STARTUP_FAILED"); });
    await expect(execute(pool, [{ role: "user", content: "FAILED_EDIT_CONTEXT" }])).rejects.toThrow("TEST_STARTUP_FAILED");
    startup.mockRestore(); startup = undefined;
    expect(await store.get("conversation")).toEqual(before);
    const messages = [...initial, { role: "assistant", content: answer }, { role: "user", content: "what did you remember?" }];
    const continued = await execute(pool, messages);
    expect(continued).toContain("FAKE_MEMORY");
    expect((await store.get("conversation"))!.sessionId).toBe(before.sessionId);
    const prompts = (await readFile(process.env.FAKE_ACP_PROMPT_LOG!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(prompts).toHaveLength(2);
    expect(prompts.at(-1).text).not.toContain("FAILED_EDIT_CONTEXT");
    await pool.close();
    expect(await execute(afterIdle, [...messages, { role: "assistant", content: continued }, { role: "user", content: "what did you remember after idle?" }])).toContain("FAKE_MEMORY");
  } finally {
    startup?.mockRestore();
    await Promise.all([first.close(), restarted.close(), afterIdle.close()]);
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    await rm(root, { recursive: true, force: true });
  }
});

import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.js";
import { canonical } from "../src/coordinator.js";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
test("tool V2 validates versions, ownership, profile and digests on every read; corruption stays nonretryable", async () => {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  const root = await mkdtemp("/tmp/opencode/tool-record-");
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = root;
  try {
    const store = new SessionStore();
    const profile = canonical({ model: "model", tools: [{ name: "shell", input_schema: {} }] });
    const changes = [
      { version: 99 }, { version: undefined }, { conversationKey: "other" }, { hostSessionID: 1 },
      { hostSessionID: "other-host" }, { profile: "unparsed" }, { profileDigest: "0".repeat(64) },
      { argumentsDigest: "0".repeat(64) }, { resultDigest: "0".repeat(64) },
      { delivery: "acknowledged" }, { delivery: "accepted" }, { epoch: -1 },
      { call: { id: "different", name: "shell", input: {} } }, { result: { content: [], isError: true } },
      { result: { text: "untyped" }, resultDigest: hash(canonical({ text: "untyped" })) },
      { terminalAcceptance: { version: 1, hostSessionID: "host", eventID: "fabricated", acceptedAt: 1 } },
      { profile: null, profileDigest: null },
      { call: { id: "call", name: "undeclared", input: {} } },
    ];
    for (let index = 0; index < changes.length; index++) {
      const key = `key-${index}`, id = "call";
      await store.set(key, { version: 1, sessionId: "remote", model: "model", cwd: root, cliVersion: null, createdAt: 1, updatedAt: 1, lastUsedAt: 1, conversation: { version: 1, epoch: 0, hostSessionID: "host", boundary: [], instructions: "", resumable: false } });
      await store.saveToolCall(key, id, { call: { id, name: "shell", input: {} }, hostSessionID: "host", profile });
      await store.saveToolResult(key, id, { content: [], isError: false });
      const path = join(root, "tools", hash(key), `${hash(id)}.json`);
      const raw = JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), ...changes[index] });
      await writeFile(path, raw);
      for (let read = 0; read < 2; read++) {
        let error: any;
        try { await new SessionStore().toolCall(key, id); } catch (caught) { error = caught; }
        expect(error?.retryable).toBe(false);
        expect(error?.code).toBe("agy_tool_record_corrupt");
      }
      expect(JSON.parse(await readFile(path, "utf8")).corrupt).toBe(true);
      const preserved = await Promise.all((await readdir(join(root, "quarantine"))).map(file => readFile(join(root, "quarantine", file), "utf8").then(JSON.parse)));
      expect(preserved.some(value => value.raw === raw)).toBe(true);
    }
    await store.saveToolCall("migration", "call", { call: { id: "call", name: "shell", input: {} }, hostSessionID: "host", profile });
    await store.saveToolResult("migration", "call", { content: [], isError: false });
    const path = join(root, "tools", hash("migration"), `${hash("call")}.json`);
    const legacy = JSON.parse(await readFile(path, "utf8"));
    legacy.version = 1; legacy.delivery = "accepted"; delete legacy.profileDigest;
    await writeFile(path, JSON.stringify(legacy));
    expect(await new SessionStore().toolCall("migration", "call")).toMatchObject({ version: 2, delivery: "result-persisted" });
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
    legacy.profile = undefined;
    await writeFile(path, JSON.stringify(legacy));
    await expect(new SessionStore().toolCall("migration", "call")).rejects.toThrow("cannot be retried");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
  }
});

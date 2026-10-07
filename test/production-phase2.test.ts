import { expect, test } from "bun:test";
import { chmod, mkdtemp, open, readFile, unlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { MAX_ATTACHMENT_BYTES, MAX_MEDIA_BYTES, materializeMedia, mediaBytes, validateMediaBlocks } from "../src/attachments.js";
import { blockBudget, HISTORY_OMISSION } from "../src/budget.js";
import { messageContentToAcp, hostResultMessageToAcp, normalizePrompt } from "../src/prompt.js";
import { reconstruct, type ReconstructionGroup } from "../src/reconstruction.js";
import { hostResults } from "../src/host-tools.js";
import { SessionPool } from "../src/session-pool.js";
import { SessionStore } from "../src/session-store.js";
import { protocol as anthropicProtocol } from "@opencode/ai/protocols/anthropic-messages";

async function withFixturePool(run: (pool: SessionPool, root: string, executable: string) => Promise<void>) {
  const keys = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_STATE_FILE"];
  const saved = keys.map(key => process.env[key]);
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "phase2-review-"));
  const executable = join(import.meta.dir, "fixtures/fake-acp.mjs");
  await chmod(executable, 0o755);
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = root;
  process.env.OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS = "1024";
  process.env.FAKE_ACP_PROMPT_LOG = join(root, "prompts.jsonl");
  delete process.env.FAKE_ACP_STATE_FILE;
  const pool = new SessionPool();
  try { await run(pool, root, executable); }
  finally {
    await pool.close();
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    await rm(root, { recursive: true, force: true });
  }
}

const image = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" });
const hostImage = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const text = (blocks: ContentBlock[]) => blocks.filter(b => b.type === "text").map(b => b.text).join("\n");
const group = (value: string, operative = false, message: ReconstructionGroup["message"] = { role: "user", content: value }): ReconstructionGroup => ({ blocks: [{ type: "text", text: value }], operative, message });

test("realistic images use media transport and estimated context, not text/base64 budget", async () => {
  const data = Buffer.alloc(128 * 1024, 31).toString("base64");
  const blocks = await messageContentToAcp([{ type: "text", text: "screenshot" }, hostImage(data), hostImage(data)]);
  expect(validateMediaBlocks(blocks)).toBe(256 * 1024);
  const budget = blockBudget("fake-model-low", blocks);
  expect(budget.text).toBeGreaterThan(99000);
  expect(budget.context).toBeLessThan(blockBudget("fake-model-low", [{ type: "text", text: "screenshot" }]).context);
  expect(await hostResultMessageToAcp({ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [hostImage(data)] }, { type: "text", text: "steer" }, hostImage(data)] }, [])).toContainEqual(image(data));
});

test("many tiny images fail numeric context planning without estimate-sized allocations", () => {
  const blocks = Array.from({ length: 10000 }, () => image("AA=="));
  expect(() => blockBudget("fake-model-low", blocks)).toThrow("exhaust");
});

test("strict base64 and exact individual/aggregate decoded boundaries", async () => {
  for (const value of ["", "!!!!", "AA=", "A===", "AB==", "AAB=", "AA==\n", "AA==AA=="]) {
    expect(() => mediaBytes(value)).toThrow();
    await expect(messageContentToAcp([hostImage(value)])).rejects.toThrow();
  }
  const exact = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64");
  expect(mediaBytes(exact)).toBe(MAX_ATTACHMENT_BYTES);
  expect(validateMediaBlocks([image(exact), image(exact)])).toBe(MAX_MEDIA_BYTES);
  expect(() => validateMediaBlocks([image(exact), image(exact), image("AA==")])).toThrow("combined images");
  expect(() => mediaBytes(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"))).toThrow("too large");
  const inspected = hostResults([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [hostImage(exact), hostImage(exact)] }, { ...hostImage("AA=="), tool_use_id: "a" }] }]);
  expect(() => validateMediaBlocks(inspected.get("a")!.content as ContentBlock[])).toThrow("combined images");
});

test("optional selection reserves the same headroom as final fixed admission", () => {
  const sent = reconstruct([group("X".repeat(20558)), group("NOW", true)], "", "unknownmodel", 100000);
  expect(text(sent)).toContain("NOW");
  expect(text(sent)).toContain(HISTORY_OMISSION);
  expect(() => blockBudget("unknownmodel", sent)).not.toThrow();
  // A larger model still independently reserves text-transport headroom.
  const large = reconstruct([group("X".repeat(98900)), group("NOW", true)], "", "gemini-3.8-flash", 100000);
  expect(() => blockBudget("gemini-3.8-flash", large)).not.toThrow();
  const empty = [{ type: "text" as const, text: "" }];
  const exact = "X".repeat(blockBudget("unknownmodel", empty).context - 1024);
  expect(blockBudget("unknownmodel", [{ type: "text", text: exact }]).context).toBe(1024);
  // With optional history, the omission envelope itself needs fixed admission.
  expect(() => reconstruct([group("optional"), group(exact, true)], "", "unknownmodel", 100000)).toThrow("exhaust");
});

test("both assemblers can omit near-budget history without failing final admission", async () => {
  await withFixturePool(async (pool, root, executable) => {
    process.env.OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS = "100000";
    const prior = [{ role: "user", content: "X".repeat(20558) }, { role: "assistant", content: "ACK" }];
    for (const canonical of [true, false]) {
      for await (const _ of pool.turn({ key: `headroom-${canonical}`, prompt: [{ type: "text", text: "NOW" }], ...(canonical ? { messages: [...prior, { role: "user", content: "NOW" }] } : { priorMessages: prior }), settings: { cwd: root, model: "fake-model-low", executable } })) { /* drain */ }
    }
    const prompts = (await readFile(join(root, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(prompts).toHaveLength(2);
    for (const sent of prompts) {
      expect(sent.text).toContain("NOW");
      expect(sent.text).toContain(HISTORY_OMISSION);
      expect(() => blockBudget("fake-model-low", sent.prompt)).not.toThrow();
    }
  });
});

test("accumulated historical media is selected before aggregate admission; operative media still fails", () => {
  const data = Buffer.alloc(11 * 1024 * 1024).toString("base64");
  const history = [0, 1, 2].map(i => ({ ...group(`HISTORY_${i}`), blocks: [{ type: "text" as const, text: `HISTORY_${i}` }, image(data)] }));
  const selected = reconstruct([...history, group("NOW", true)], "", "unknownmodel", 100000);
  expect(validateMediaBlocks(selected)).toBe(22 * 1024 * 1024);
  expect(text(selected)).toContain(HISTORY_OMISSION);
  expect(text(selected)).not.toContain("HISTORY_0");
  expect(text(selected)).toContain("HISTORY_1");
  expect(text(selected)).toContain("HISTORY_2");
  expect(() => reconstruct(history.map(g => ({ ...g, operative: true })), "", "unknownmodel", 100000)).toThrow("combined images");
  // One causal unit exceeding the aggregate cap is omitted whole, not rejected.
  expect(text(reconstruct([{ ...group("OLD_UNIT"), blocks: history.flatMap(g => g.blocks) }, group("NOW", true)], "", "unknownmodel", 100000))).toContain(HISTORY_OMISSION);
  const results = hostResults([{ role: "user", content: [0, 1, 2].map(i => ({ type: "tool_result", tool_use_id: `call-${i}`, content: [hostImage(data)] })) }]);
  expect(results.size).toBe(3);
});

test("local historical inspection stores metadata only and never reads omitted files", async () => {
  const root = await mkdtemp(`${process.env.TMPDIR || "/tmp/opencode"}/phase2-inspection-`);
  const groups: ReconstructionGroup[] = [];
  const paths: string[] = [];
  const inspection = { remaining: Number.POSITIVE_INFINITY, inspect: true };
  for (let i = 0; i < 3; i++) {
    const path = join(root, `${i}.png`); paths.push(path);
    const file = await open(path, "w");
    try { await file.truncate(11 * 1024 * 1024); } finally { await file.close(); }
    const blocks = await messageContentToAcp([{ type: "image", url: path }], [root], inspection);
    expect(blocks[0]).toMatchObject({ type: "image", data: "" });
    groups.push({ ...group(`LOCAL_${i}`), blocks });
  }
  const selected = reconstruct([...groups, group("NOW", true)], "", "unknownmodel", 100000);
  await unlink(paths[0]); // Would fail if the omitted oldest image were read.
  const actual = await materializeMedia(selected);
  expect(validateMediaBlocks(actual)).toBe(22 * 1024 * 1024);
  expect(actual.filter(b => b.type === "image")).toHaveLength(2);
  expect(text(actual)).toContain(HISTORY_OMISSION);
});

test("both assemblers continue when accumulated media exceeds the selected prompt cap", async () => {
  await withFixturePool(async (pool, root, executable) => {
    const data = Buffer.alloc(11 * 1024 * 1024).toString("base64");
    const prior = [0, 1, 2].flatMap(i => [{ role: "user", content: [{ type: "text", text: `IMAGE_${i}` }, hostImage(data)] }, { role: "assistant", content: `ACK_${i}` }]);
    // Three 11 MiB images are below the configured 48 MiB encoded HTTP cap.
    expect(Buffer.byteLength(JSON.stringify(prior))).toBeLessThan(48 * 1024 * 1024);
    for (const canonical of [true, false]) {
      for await (const _ of pool.turn({ key: `accumulated-${canonical}`, prompt: [{ type: "text", text: "NOW" }], ...(canonical ? { messages: [...prior, { role: "user", content: "NOW" }] } : { priorMessages: prior }), settings: { cwd: root, model: "fake-model-low", executable } })) { /* drain */ }
    }
    const prompts = (await readFile(join(root, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    for (const sent of prompts) {
      expect(sent.text).toContain(HISTORY_OMISSION);
      expect(sent.text).toContain("NOW");
      expect(sent.text).not.toContain("IMAGE_0");
      expect(validateMediaBlocks(sent.prompt)).toBe(22 * 1024 * 1024);
    }
    await expect((async () => {
      for await (const _ of pool.turn({ key: "operative-media", prompt: [{ type: "text", text: "NOW" }], messages: [0, 1, 2].map(i => ({ role: "user", content: [hostImage(data)] })), settings: { cwd: root, model: "fake-model-low", executable } })) { /* drain */ }
    })()).rejects.toThrow("combined images");
  });
});

test("committed epoch preserves a summary encoded by the installed host codec", async () => {
  // Codec evidence, not proof of native checkpoint-to-message preprocessing.
  const Effect = await import(Bun.resolveSync("effect/Effect", dirname(import.meta.resolve("@opencode/ai"))));
  const summary = `ACCEPTED_SUMMARY ${"sanitized checkpoint fact ".repeat(35)}`.trim();
  const body: any = await Effect.runPromise(anthropicProtocol.body.from({
    model: { id: "gemini-3.8-flash", provider: "antigravity-cli", route: {} }, system: [], tools: [],
    messages: [
      { role: "assistant", content: [{ type: "text", text: summary }] },
      { role: "user", content: [{ type: "text", text: "OPTIONAL_OLD".repeat(10000) }] },
      { role: "assistant", content: [{ type: "text", text: "RECENT_TAIL_DECISION" }] },
      { role: "user", content: [{ type: "text", text: "CURRENT_CONTINUATION" }] },
    ],
  } as any));
  expect(body.messages[0].role).toBe("assistant");
  expect(text(await messageContentToAcp(body.messages[0].content))).toBe(summary);
  await withFixturePool(async (pool, root, executable) => {
    const store = new SessionStore();
    await store.compaction("checkpoint-host", "accepted-fixture", "committed");
    expect((await store.lifecycle("checkpoint-host")).epoch).toBe(1);
    for await (const _ of pool.turn({ key: "checkpoint-fixture", hostSessionID: "checkpoint-host", messages: body.messages, prompt: [{ type: "text", text: "CURRENT_CONTINUATION" }], settings: { cwd: root, model: "fake-model-low", executable } })) { /* drain */ }
    const sent = JSON.parse((await readFile(join(root, "prompts.jsonl"), "utf8")).trim()).text;
    expect(sent).toContain(summary);
    expect(sent).toContain("RECENT_TAIL_DECISION");
    expect(sent).toContain("CURRENT_CONTINUATION");
    expect(sent).not.toContain("OPTIONAL_OLD");
  });
});

test("oversized sparse local image fails before materialization; unsupported media remains early", async () => {
  const root = await mkdtemp(`${process.env.TMPDIR || "/tmp/opencode"}/phase2-media-`);
  const path = join(root, "large.png");
  const file = await open(path, "w");
  try { await file.truncate(MAX_ATTACHMENT_BYTES + 1); } finally { await file.close(); }
  await expect(messageContentToAcp([{ type: "image", url: path }], [root])).rejects.toThrow("too large");
  for (const type of ["audio", "pdf", "document", "file"]) await expect(messageContentToAcp([{ type, data: "AA==" }])).rejects.toThrow();
  await expect(messageContentToAcp([{ type: "image", url: "https://example.invalid/image.png" }])).rejects.toThrow();
});

test("cancelled image materialization stops before file access or decoding", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(messageContentToAcp([{ type: "image", url: "/missing/image.png" }], [], { remaining: MAX_MEDIA_BYTES, signal: controller.signal })).rejects.toThrow("cancel");
  await expect(normalizePrompt([{ role: "user", content: [hostImage("AA==")] }], { signal: controller.signal })).rejects.toThrow("cancel");
});

test("historical image omission is whole with evidence; image order and steering remain intact", () => {
  const history: ReconstructionGroup = { ...group("MEDIA"), blocks: [{ type: "text", text: "MEDIA" }, ...Array.from({ length: 6 }, () => image("AA=="))] };
  const current: ReconstructionGroup = { ...group("STEERING", true), blocks: [image("AQ=="), { type: "text", text: "STEERING" }, image("Ag==")] };
  const sent = reconstruct([history, group("RECENT DECISION"), current], "", "fake-model-low", 1024);
  expect(text(sent)).toContain(HISTORY_OMISSION);
  expect(text(sent)).toContain("RECENT DECISION");
  expect(text(sent)).not.toContain("MEDIA");
  expect(sent.filter(b => b.type === "image")).toEqual([image("AQ=="), image("Ag==")]);
});

test("recent whole causal units win over oversized oldest history and preserve parallel result chronology", () => {
  const calls = group("CALL_A CALL_B", false, { role: "assistant", content: [{ type: "tool_use", id: "a" }, { type: "tool_use", id: "b" }] });
  const resultA = group("RESULT_A", false, { role: "user", content: [{ type: "tool_result", tool_use_id: "a" }] });
  const resultB = group("RESULT_B DECISION", false, { role: "user", content: [{ type: "tool_result", tool_use_id: "b" }] });
  const sent = text(reconstruct([group("OLD".repeat(10000)), calls, resultA, group("INTERVENING"), resultB, group("QUEUED_ONE", true), group("QUEUED_TWO", true)], "instructions", "fake-model-low", 1024));
  expect(sent).toContain(HISTORY_OMISSION);
  expect(sent).not.toContain("OLD");
  for (const value of ["CALL_A CALL_B", "RESULT_A", "INTERVENING", "RESULT_B DECISION", "QUEUED_ONE", "QUEUED_TWO"]) expect(sent).toContain(value);
  expect(sent.indexOf("CALL_A")).toBeLessThan(sent.indexOf("RESULT_A"));
  expect(sent.indexOf("RESULT_A")).toBeLessThan(sent.indexOf("RESULT_B"));
  expect(text(reconstruct([calls, resultA, resultB, group("NOW", true)], "", "fake-model-low", 65))).not.toContain("CALL_A");
});

test("operative result reserves its entire causal unit, and impossible fixed content fails", () => {
  const calls = group("CALL".repeat(10000), false, { role: "assistant", content: [{ type: "tool_use", id: "a" }] });
  const result = group("RESULT", true, { role: "user", content: [{ type: "tool_result", tool_use_id: "a" }] });
  expect(() => reconstruct([calls, result], "", "fake-model-low", 1024)).toThrow("exhaust");
  const accepted = text(reconstruct([group("SUMMARY", true), group("OLDER".repeat(10000)), group("RECENT"), group("CURRENT", true)], "", "fake-model-low", 1024));
  expect(accepted).toContain("SUMMARY");
  expect(accepted).toContain("RECENT");
  expect(accepted).toContain("CURRENT");
});

test("both production assemblers retain recent decisions and whole parallel call/results over oldest oversized text", async () => {
  const keys = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS", "FAKE_ACP_PROMPT_LOG", "FAKE_ACP_STATE_FILE"];
  const saved = keys.map(key => process.env[key]);
  const root = await mkdtemp(`${process.env.TMPDIR || "/tmp/opencode"}/phase2-rebuild-`);
  const executable = join(import.meta.dir, "fixtures/fake-acp.mjs");
  await chmod(executable, 0o755);
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = root;
  process.env.OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS = "2048";
  process.env.FAKE_ACP_PROMPT_LOG = join(root, "prompts.jsonl");
  delete process.env.FAKE_ACP_STATE_FILE;
  const pool = new SessionPool();
  const prior = [
    { role: "user", content: "OVERSIZED_OLD".repeat(10000) },
    { role: "assistant", content: [{ type: "tool_use", id: "call-a", name: "inspect", input: {} }, { type: "tool_use", id: "call-b", name: "inspect", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "RESULT_A" }, { type: "tool_result", tool_use_id: "call-b", content: "RESULT_B" }] },
    { role: "assistant", content: "RECENT_DECISION" },
    { role: "user", content: "QUEUED_INPUT" },
    { role: "system", content: "INSTRUCTION_BOUNDARY" },
  ];
  try {
    for (const canonical of [true, false]) {
      for await (const _ of pool.turn({ key: `phase2-${canonical}`, prompt: [{ type: "text", text: "CURRENT" }], ...(canonical ? { messages: [...prior, { role: "user", content: "CURRENT" }] } : { priorMessages: prior }), instructions: "OPERATIVE_INSTRUCTIONS", settings: { cwd: root, model: "fake-model-low", executable } })) { /* drain */ }
    }
    const sent = (await readFile(join(root, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).text as string);
    expect(sent).toHaveLength(2);
    for (const prompt of sent) {
      expect(prompt).not.toContain("OVERSIZED_OLD");
      for (const item of [HISTORY_OMISSION, "call-a", "call-b", "RESULT_A", "RESULT_B", "RECENT_DECISION", "QUEUED_INPUT", "INSTRUCTION_BOUNDARY", "OPERATIVE_INSTRUCTIONS", "CURRENT"]) expect(prompt).toContain(item);
      expect(prompt.indexOf("call-a")).toBeLessThan(prompt.indexOf("RESULT_A"));
      expect(prompt.indexOf("RESULT_A")).toBeLessThan(prompt.indexOf("RECENT_DECISION"));
    }
  } finally {
    await pool.close();
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
});

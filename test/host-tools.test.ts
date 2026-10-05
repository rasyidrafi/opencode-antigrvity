import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startProxy, stopProxy, getProxyBaseUrl } from "../src/proxy.js";
import { closeHostBridges, hostResults, parseHostTools } from "../src/host-tools.js";
import { SESSION_HEADER } from "../src/constants.js";

const directory = await mkdtemp(join(tmpdir(), "agy-host-tools-"));
const env = { ...process.env };
const schema = [{ name: "shell", description: "OpenCode shell", input_schema: { type: "object", properties: { index: { type: "integer", description: "Exact schema" } }, required: ["index"] } }];
beforeAll(async () => {
  process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = join(import.meta.dir, "fixtures/fake-acp.mjs");
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.GEMINI_HOME = join(directory, "gemini");
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  await chmod(process.env.OPENCODE_ANTIGRAVITY_ACP_PATH, 0o755);
  await startProxy(directory);
});
afterAll(async () => {
  await stopProxy();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  await rm(directory, { recursive: true, force: true });
});
const send = (session: string, messages: any[], extra: Record<string, unknown> = {}) => fetch(getProxyBaseUrl() + "/messages", {
  method: "POST", headers: { "content-type": "application/json", "x-api-key": "opencode-antigravity-local", [SESSION_HEADER]: session },
  body: JSON.stringify({ model: "gemini-3.8-flash", tools: schema, system: "HOST_INSTRUCTIONS_UNTRUNCATED", messages, ...extra }),
});
const result = (id: string, text: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, content: text, is_error });

test("parallel host calls park, partial results retain the whole group, then continue the same ACP prompt", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL" }];
  const first = await (await send("parallel", messages)).json();
  expect(first.stop_reason).toBe("tool_use"); expect(first.content).toHaveLength(2);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "ONE")] });
  const partial = await (await send("parallel", messages)).json();
  expect(partial.content).toEqual(first.content);
  messages.at(-1).content.push(result(first.content[1].id, "DENIED", true));
  const final = await (await send("parallel", messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(JSON.stringify(final.content)).toContain("ONE"); expect(JSON.stringify(final.content)).toContain("DENIED");
  expect(JSON.stringify(final.content)).toContain("isError");
  const prompts = (await readFile(join(directory, "prompts.jsonl"), "utf8")).split("\n").filter((line) => line.includes("FAKE_MCP_PARALLEL"));
  expect(prompts).toHaveLength(1); expect(prompts[0]).toContain("HOST_INSTRUCTIONS_UNTRUNCATED");
});

test("sequential tool steps preserve error/media results and expose valid Anthropic SSE", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_SEQUENCE" }];
  const first = await (await send("sequence", messages)).json();
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "FIRST")] });
  const second = await (await send("sequence", messages)).json();
  expect(second.stop_reason).toBe("tool_use");
  const call = second.content.find((part: any) => part.type === "tool_use");
  messages.push({ role: "assistant", content: second.content }, { role: "user", content: [result(call.id, "SECOND")] });
  const final = await send("sequence", messages, { stream: true });
  const text = await final.text(); expect(text).toContain("SECOND"); expect(text).toContain('"stop_reason":"end_turn"');
});

test("cross-session results cannot resolve another session's tools; stopped calls cannot resume", async () => {
  const messages = [{ role: "user", content: "FAKE_MCP" }];
  const a = await (await send("a", messages)).json();
  const b = await (await send("b", messages)).json();
  const wrong = await send("b", [...messages, { role: "assistant", content: b.content }, { role: "user", content: [result(a.content[0].id, "WRONG")] }]);
  expect(wrong.status).toBe(409);
  const good = await (await send("a", [...messages, { role: "assistant", content: a.content }, { role: "user", content: [result(a.content[0].id, "RIGHT")] }])).json();
  expect(JSON.stringify(good)).toContain("RIGHT");
  const stopped = await (await send("stop", messages)).json();
  await closeHostBridges("stop");
  const orphan = await send("stop", [...messages, { role: "assistant", content: stopped.content }, { role: "user", content: [result(stopped.content[0].id, "LATE")] }]);
  expect(orphan.status).toBe(409);
});

test("tool schema and media conversion retain the native host contract", () => {
  expect(parseHostTools(schema)).toEqual(schema);
  expect(() => parseHostTools([...schema, ...schema])).toThrow();
  const results = hostResults([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "image", source: { type: "base64", data: "AA==", media_type: "image/png" } }] }] }]);
  expect(results.get("a")?.content).toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
});

test("MCP tools render only as host calls while thinking and compaction notices survive", async () => {
  for (const stream of [false, true]) {
    const session = `activity-${stream}`;
    const messages: any[] = [{ role: "user", content: "FAKE_MCP_ACTIVITY" }];
    const firstResponse = await send(session, messages, { stream });
    const firstText = await firstResponse.text();
    expect(firstText).not.toContain("Antigravity ACP tool");
    expect(firstText).not.toContain("duplicate-command");
    let call: any;
    if (stream) {
      expect(firstText).toContain("GENUINE_THOUGHT_BEFORE");
      const events = firstText.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      const starts = events.filter((event) => event.type === "content_block_start" && event.content_block.type === "tool_use");
      expect(starts).toHaveLength(1);
      call = starts[0].content_block;
      call.input = JSON.parse(events.find((event) => event.index === starts[0].index && event.delta?.type === "input_json_delta").delta.partial_json);
    } else {
      const first = JSON.parse(firstText);
      expect(first.stop_reason).toBe("tool_use");
      expect(first.content.filter((part: any) => part.type === "tool_use")).toHaveLength(1);
      call = first.content.find((part: any) => part.type === "tool_use");
    }
    messages.push({ role: "assistant", content: [call] }, { role: "user", content: [result(call.id, "HOST_TOOL_DENIED", true)] });
    const finalText = await (await send(session, messages, { stream })).text();
    expect(finalText).not.toContain("Antigravity ACP tool");
    expect(finalText).toContain("GENUINE_THOUGHT_AFTER");
    expect(finalText).toContain("context compacted");
    expect(finalText).toContain("HOST_TOOL_DENIED");
    expect(finalText).toContain('"stop_reason":"end_turn"');
  }
});

test("waiting for host approval suspends the ACP stall watchdog and forwards changed instructions", async () => {
  const previous = process.env.OPENCODE_ANTIGRAVITY_TURN_STALL_MS;
  process.env.OPENCODE_ANTIGRAVITY_TURN_STALL_MS = "1000";
  try {
    const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
    const first = await (await send("waiting", messages)).json();
    expect(first.stop_reason).toBe("tool_use");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "APPROVED"), { type: "text", text: "USER_STEERING" }] });
    const final = await (await send("waiting", messages, { system: "UPDATED_INSTRUCTIONS" })).json();
    expect(final.stop_reason).toBe("end_turn");
    expect(JSON.stringify(final)).toContain("UPDATED_INSTRUCTIONS");
    expect(JSON.stringify(final)).toContain("USER_STEERING");
  } finally { if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_TURN_STALL_MS; else process.env.OPENCODE_ANTIGRAVITY_TURN_STALL_MS = previous; }
});

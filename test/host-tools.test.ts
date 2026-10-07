import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startProxy, stopProxy, getProxyBaseUrl } from "../src/proxy.js";
import { closeHostBridges, hostBridge, hostResults, parseHostTools } from "../src/host-tools.js";
import { protocol as anthropicProtocol } from "@opencode/ai/protocols/anthropic-messages";
const Effect = await import(Bun.resolveSync("effect/Effect", dirname(import.meta.resolve("@opencode/ai"))));
import { SESSION_HEADER } from "../src/constants.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
let compatibility: ReturnType<typeof fixtureCompatibility>;

const directory = await mkdtemp(join(tmpdir(), "agy-host-tools-"));
const env = { ...process.env };
const schema = [{ name: "shell", description: "OpenCode shell", input_schema: { type: "object", properties: { index: { type: "integer", description: "Exact schema" } }, required: ["index"] } }];
beforeAll(async () => {
  compatibility = fixtureCompatibility();
  process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = join(import.meta.dir, "fixtures/fake-acp.mjs");
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  process.env.GEMINI_HOME = join(directory, "gemini");
  process.env.FAKE_ACP_PROMPT_LOG = join(directory, "prompts.jsonl");
  await chmod(process.env.OPENCODE_ANTIGRAVITY_ACP_PATH, 0o755);
  await startProxy(directory);
});
afterAll(async () => {
  await stopProxy();
  compatibility.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  await rm(directory, { recursive: true, force: true });
});
const send = (session: string, messages: any[], extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => fetch(getProxyBaseUrl() + "/messages", {
  method: "POST", headers: { "content-type": "application/json", "x-api-key": "opencode-antigravity-local", [SESSION_HEADER]: session, ...headers },
  body: JSON.stringify({ model: "gemini-3.8-flash", tools: schema, system: "HOST_INSTRUCTIONS_UNTRUNCATED", messages, ...extra }),
});
const result = (id: string, text: string, is_error = false) => ({ type: "tool_result", tool_use_id: id, content: text, is_error });

test("installed host encoder preserves inline/promoted result images and image steering through proxy/MCP", async () => {
  // Sanitized synthetic payloads, >90 KiB decoded each; no private screenshots.
  const resultImage = Buffer.alloc(96 * 1024, 17).toString("base64");
  const steeringImage = Buffer.alloc(100 * 1024, 23).toString("base64");
  const initial = [{ role: "user", content: "FAKE_MCP ENCODER_MEDIA" }];
  const first = await (await send("encoder-media", initial)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const body: any = await Effect.runPromise(anthropicProtocol.body.from({
    model: { id: "gemini-3.8-flash", provider: "antigravity-cli", route: {} }, system: [], tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: initial[0].content }] },
      { role: "assistant", content: [{ type: "tool-call", id: call.id, name: call.name, input: call.input }] },
      { role: "tool", content: [{ type: "tool-result", id: call.id, name: call.name, result: { type: "content", value: [{ type: "text", text: "ENCODER_RESULT" }, { type: "file", uri: `data:image/png;base64,${resultImage}`, mime: "image/png" }] } }] },
      { role: "user", content: [{ type: "text", text: "IMAGE_STEERING" }, { type: "media", media: { mediaType: "image/png", source: { type: "base64" }, inline: () => ({ mime: "image/png", base64: steeringImage }) } }] },
    ],
  } as any));
  const encodedResult = body.messages.find((m: any) => m.content.some((p: any) => p.type === "tool_result"));
  const resultPart = encodedResult.content[0];
  expect(resultPart.content[1].type).toBe("image");
  // Exercise the host's promoted adjacent representation as well as its real
  // encoder's inline result representation, without inventing another codec.
  encodedResult.content.push(resultPart.content.pop());
  const final = await (await send("encoder-media", body.messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  const content = JSON.stringify(final.content);
  expect(content).toContain("ENCODER_RESULT");
  expect(content).toContain("IMAGE_STEERING");
  expect(content).toContain(resultImage);
  expect(content).toContain(steeringImage);

  const recoveredInitial = [{ role: "user", content: "FAKE_MCP IMAGE_RECOVERY" }];
  const lost = await (await send("encoder-image-recovery", recoveredInitial)).json();
  const lostCall = lost.content.find((part: any) => part.type === "tool_use");
  const recovery = structuredClone(body.messages);
  recovery[0] = recoveredInitial[0];
  recovery[1] = { role: "assistant", content: lost.content };
  recovery[2].content[0].tool_use_id = lostCall.id;
  await closeHostBridges("encoder-image-recovery");
  const recoveredResponse = await send("encoder-image-recovery", recovery);
  const recoveredBody = await recoveredResponse.json();
  expect(recoveredBody.error).toBeUndefined();
  expect(recoveredResponse.status).toBe(200);
  const rebuilt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  expect(rebuilt.prompt.filter((part: any) => part.type === "image").map((part: any) => part.data)).toEqual([resultImage, steeringImage]);
});

test("MCP cancellation request IDs interrupt their bridge without a successful empty result", async () => {
  const first = await (await send("mcp-cancel-id", [{ role: "user", content: "FAKE_MCP" }])).json();
  expect(first.stop_reason).toBe("tool_use");
  const { sessionStore } = await import("../src/session-store.js");
  const { sessionPool } = await import("../src/session-pool.js");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === "mcp-cancel-id")!;
  const bridge = hostBridge(key, "mcp-cancel-id", directory);
  const url = getProxyBaseUrl().replace(/\/v1$/, "") + `/mcp/${bridge.token}/${bridge.catalogID}`;
  const rpc = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const pending = rpc({ jsonrpc: "2.0", id: "cancel-me", method: "tools/call", params: { name: "shell", arguments: { index: 3 } } });
  await Bun.sleep(20);
  expect((await rpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancel-me" } })).status).toBe(202);
  const response = await (await pending).json();
  expect(response.error.message).toMatch(/cancel/i);
  expect(response.result).toBeUndefined();
  for (let i = 0; i < 100 && (await sessionPool.status(key)).active; i++) await Bun.sleep(10);
  expect((await sessionPool.status(key)).active).toBe(false);
});

test("MCP negotiates opted-in SSE progress and reports cancellation as a terminal error", async () => {
  const host = "mcp-negotiated-progress";
  const first = await (await send(host, [{ role: "user", content: "FAKE_MCP" }])).json();
  expect(first.stop_reason).toBe("tool_use");
  const { sessionStore } = await import("../src/session-store.js");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === host)!;
  const bridge = hostBridge(key, host, directory);
  const url = getProxyBaseUrl().replace(/\/v1$/, "") + `/mcp/${bridge.token}/${bridge.catalogID}`;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: "progress-request", method: "tools/call", params: { name: "shell", arguments: { index: 5 }, _meta: { progressToken: "token-progress" } } }) });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("token-progress");
  expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "progress-request" } }) })).status).toBe(202);
  let terminal = "";
  while (true) { const next = await reader.read(); if (next.done) break; terminal += new TextDecoder().decode(next.value); }
  expect(terminal).toContain('"error":');
  expect(terminal).toMatch(/cancel/i);
  expect(terminal).not.toContain('"result":');
});

test("parallel host calls park, partial results retain waiters without re-emission, then continue the same ACP prompt", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL" }];
  const first = await (await send("parallel", messages)).json();
  expect(first.stop_reason).toBe("tool_use"); expect(first.content).toHaveLength(2);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "ONE")] });
  const partialResponse = await send("parallel", messages);
  expect(partialResponse.status).toBe(400);
  const partial = await partialResponse.json();
  expect(partial.content).toBeUndefined();
  expect(partial.error.message).toContain("pending results");
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

test("cross-session results cannot resolve tools; stopped calls rebuild with accepted late results", async () => {
  const messages = [{ role: "user", content: "FAKE_MCP" }];
  const a = await (await send("a", messages)).json();
  const b = await (await send("b", messages)).json();
  const wrong = await send("b", [...messages, { role: "assistant", content: b.content }, { role: "user", content: [result(a.content[0].id, "WRONG")] }]);
  expect(wrong.status).toBe(400);
  const good = await (await send("a", [...messages, { role: "assistant", content: a.content }, { role: "user", content: [result(a.content[0].id, "RIGHT")] }])).json();
  expect(JSON.stringify(good)).toContain("RIGHT");
  const stopped = await (await send("stop", messages)).json();
  await closeHostBridges("stop");
  const orphan = await send("stop", [...messages, { role: "assistant", content: stopped.content }, { role: "user", content: [result(stopped.content[0].id, "LATE")] }]);
  expect(orphan.status).toBe(200);
  const recovered = await orphan.json();
  expect(recovered.stop_reason).toBe("end_turn");
  expect(recovered.content.some((part: any) => part.type === "tool_use")).toBe(false);
});

test("compaction retires parked calls and imports their completed results into the committed epoch", async () => {
  const { sessionStore } = await import("../src/session-store.js");
  const host = "parked-compaction";
  const original = [{ role: "user", content: "FAKE_MCP_PARALLEL" }];
  const first = await (await send(host, original)).json();
  const calls = first.content.filter((part: any) => part.type === "tool_use");
  expect(calls).toHaveLength(2);
  const partialMessages = [...original, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "COMPLETED_ONCE")] }];
  const partialResponse = await send(host, partialMessages);
  expect(partialResponse.status).toBe(400);
  expect((await partialResponse.json()).content).toBeUndefined();
  const oldBinding = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  expect((await sessionStore.toolCall(oldBinding[0], calls[0].id))!.delivery).toBe("result-persisted");
  const summary = await send(host, [...partialMessages, { role: "user", content: "Summarize the selected prefix." }], { system: "Keep exact identifiers", tools: undefined }, { "x-opencode-antigravity-request-kind": "compaction" });
  expect(summary.status).toBe(200);
  await sessionStore.compaction(host, "parked-compaction-commit", "committed");
  const continued = await (await send(host, [{ role: "user", content: "COMMITTED_CHECKPOINT" }, { role: "assistant", content: first.content }, { role: "user", content: [result(calls[0].id, "COMPLETED_ONCE"), result(calls[1].id, "COMPLETED_SECOND_ONCE")] }])).json();
  expect(continued.stop_reason).toBe("end_turn");
  expect(continued.content.some((part: any) => part.type === "tool_use")).toBe(false);
  const binding = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
  expect(binding[1].conversation!.hostEpoch).toBe(1);
  for (const call of calls) expect((await sessionStore.toolCall(binding[0], call.id))!.delivery).toBe("result-persisted");
  const rebuilt = JSON.parse((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!).text;
  for (const call of calls) {
    expect(rebuilt).toContain(`[tool shell ${call.id}]`);
    expect(rebuilt).toContain(`[tool result ${call.id}]`);
    expect(rebuilt.indexOf(`[tool shell ${call.id}]`)).toBeLessThan(rebuilt.indexOf(`[tool result ${call.id}]`));
  }
  expect(rebuilt).toContain("COMPLETED_ONCE");
  expect(rebuilt).toContain("COMPLETED_SECOND_ONCE");
});

test("tool schema and media conversion retain the native host contract", () => {
  expect(parseHostTools(schema)).toEqual(schema);
  expect(() => parseHostTools([...schema, ...schema])).toThrow();
  const results = hostResults([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "image", source: { type: "base64", data: "AA==", media_type: "image/png" } }] }] }]);
  expect(results.get("a")?.content).toEqual([{ type: "image", data: "AA==", mimeType: "image/png" }]);
});

test("restart recovers independently persisted parallel results without reexecuting calls", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL" }];
  const first = await (await send("restart-parallel", messages)).json();
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "DURABLE_FIRST")] });
  await send("restart-parallel", messages);
  await closeHostBridges("restart-parallel");
  // Simulate a restart continuation containing only the newly completed half.
  messages.at(-1).content = [result(first.content[1].id, "DURABLE_SECOND")];
  const final = await (await send("restart-parallel", messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(final.content.some((p: any) => p.type === "tool_use")).toBe(false);
  const prompts = (await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).text);
  const rebuilt = prompts.at(-1)!;
  expect(rebuilt).toContain("DURABLE_FIRST");
  expect(rebuilt).toContain("DURABLE_SECOND");
});

test("lost result after both calls executed cannot cause recovery to execute either again", async () => {
  const executions = new Map<string, number>();
  const execute = (calls: any[]) => calls.map(call => {
    executions.set(call.id, (executions.get(call.id) ?? 0) + 1);
    return result(call.id, `EXECUTED_${call.id}`);
  });
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_PARALLEL SIDE_EFFECT_COUNTS" }];
  const first = await (await send("execution-counts", messages)).json();
  // Both host side effects happened, but only A's result reached the adapter.
  const completed = execute(first.content);
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [completed[0]] });
  const partialResponse = await send("execution-counts", messages);
  expect(partialResponse.status).toBe(400);
  const partial = await partialResponse.json();
  execute((partial.content ?? []).filter((p: any) => p.type === "tool_use"));
  expect(partial.content).toBeUndefined();
  await closeHostBridges("execution-counts");
  for (const stream of [false, true]) {
    const context = stream ? [...messages, { role: "assistant", content: "host interruption status" }, { role: "user", content: "recover pending work" }] : messages;
    const response = await send("execution-counts", context, { stream });
    expect(response.status).toBe(400);
    const recovered = await response.json();
    // Model a host executor: any executable calls would repeat the side effect.
    execute((recovered.content ?? []).filter((p: any) => p.type === "tool_use"));
    expect(recovered.error.message).toContain("execution is uncertain");
    expect(recovered.content).toBeUndefined();
  }
  for (const call of first.content) expect(executions.get(call.id)).toBe(1);
  // Reconcile B's original stored host result; never execute B to reconstruct it.
  messages.at(-1).content = [completed[1]];
  // The authoritative stored result need not be in the trailing result group.
  messages.push({ role: "assistant", content: "host stored completion status" }, { role: "user", content: "continue from stored results" });
  const final = await (await send("execution-counts", messages)).json();
  expect(final.stop_reason).toBe("end_turn");
  for (const call of first.content) expect(executions.get(call.id)).toBe(1);
});

test("catalog descriptions and schema ordering preserve the parked profile; changed schemas rebuild", async () => {
  for (const changed of [false, true]) {
    const session = `profile-${changed}`;
    const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
    const first = await (await send(session, messages)).json();
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "ORIGIN_RESULT")] });
    const tools = structuredClone(schema);
    tools[0].description = "new description";
    if (changed) tools[0].input_schema.required = [];
    const final = await (await send(session, messages, { tools })).json();
    expect(final.stop_reason).toBe("end_turn");
    if (!changed) expect(JSON.stringify(final)).toContain("ORIGIN_RESULT");
    else expect((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!).toContain("ORIGIN_RESULT");
    expect(final.content.some((p: any) => p.type === "tool_use")).toBe(false);
  }
});

test("conflicting persisted results are terminal and private to their conversation", async () => {
  const { SessionStore } = await import("../src/session-store.js");
  const store = new SessionStore();
  await store.saveToolCall("durable-test", "call", { call: { id: "call", name: "shell", input: {} }, emitted: true });
  const completed = { content: [{ type: "text", text: "ONCE" }], isError: false };
  await Promise.all([store.saveToolResult("durable-test", "call", completed), store.saveToolResult("durable-test", "call", completed)]);
  await expect(store.saveToolResult("durable-test", "call", { content: [{ type: "text", text: "CONFLICT" }], isError: false })).rejects.toThrow("Conflicting");
  await expect(store.saveToolResult("another-session", "call", completed)).rejects.toThrow("originating");
});

test("terminal acceptance is durable, call-scoped and independent of fabricated results", async () => {
  const { SessionStore } = await import("../src/session-store.js");
  const store = new SessionStore();
  await store.saveToolCall("terminal-durable", "terminal-call", { call: { id: "terminal-call", name: "StructuredOutput", input: { answer: 42 } }, hostSessionID: "terminal-host", profile: '{"model":"model","tools":[{"input_schema":{},"name":"StructuredOutput"}]}' });
  expect(await store.acceptTerminalCall("terminal-durable", "wrong-host", "terminal-call", "wrong-event")).toBe(false);
  expect(await store.acceptTerminalCall("terminal-durable", "terminal-host", "wrong-call", "wrong-event")).toBe(false);
  expect(await store.acceptTerminalCall("terminal-durable", "terminal-host", "terminal-call", "accepted-event")).toBe(true);
  const restarted = new SessionStore();
  expect((await restarted.toolCall("terminal-durable", "terminal-call"))?.terminalAcceptance).toMatchObject({ hostSessionID: "terminal-host", eventID: "accepted-event" });
  expect(await restarted.acceptTerminalCall("terminal-durable", "terminal-host", "terminal-call", "duplicate-event")).toBe(true);
  expect((await restarted.toolCall("terminal-durable", "terminal-call"))?.terminalAcceptance).toMatchObject({ eventID: "accepted-event" });
  expect((await restarted.toolCall("terminal-durable", "terminal-call"))?.result).toBeUndefined();
});

test("failed durable file sync cannot acknowledge a tool result", async () => {
  const { SessionStore } = await import("../src/session-store.js");
  const store = new SessionStore();
  await store.saveToolCall("sync-failure", "sync-call", { call: { id: "sync-call", name: "shell", input: {} } });
  const handle = await open(join(directory, "sync-probe"), "w", 0o600);
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const sync = spyOn(prototype, "sync").mockImplementation(async () => { throw new Error("injected fsync failure"); });
  try {
    await expect(store.saveToolResult("sync-failure", "sync-call", { content: [{ type: "text", text: "NOT_ACKNOWLEDGED" }], isError: false })).rejects.toThrow("injected fsync failure");
  } finally { sync.mockRestore(); }
  expect((await store.toolCall("sync-failure", "sync-call"))?.result).toBeUndefined();
});

test("runtime retains proxy until the last same-workspace owner releases", async () => {
  const port = getProxyBaseUrl();
  await startProxy(directory);
  await stopProxy(directory);
  expect(getProxyBaseUrl()).toBe(port);
  expect((await fetch(port + "/health")).status).toBe(200);
});

test("compatible module reload shares proxy, pool and live bridge ownership", async () => {
  const proxyPath = "../src/proxy.ts?phase5-reload";
  const poolPath = "../src/session-pool.ts?phase5-reload";
  const bridgePath = "../src/host-tools.ts?phase5-reload";
  const reloadedProxy = await import(proxyPath);
  const reloadedPool = await import(poolPath);
  const reloadedBridge = await import(bridgePath);
  const { sessionPool } = await import("../src/session-pool.js");
  const { hostBridge } = await import("../src/host-tools.js");
  expect(reloadedPool.sessionPool).toBe(sessionPool);
  expect(reloadedBridge.hostBridge("reload-test", "reload-test", directory)).toBe(hostBridge("reload-test", "reload-test", directory));
  await reloadedProxy.startProxy(directory);
  expect(reloadedProxy.getProxyBaseUrl()).toBe(getProxyBaseUrl());
  await reloadedProxy.stopProxy(directory);
  expect((await fetch(getProxyBaseUrl() + "/health")).status).toBe(200);
  await closeHostBridges("reload-test");
});

test("model switch settles the old parked profile through a fresh binding", async () => {
  const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
  const first = await (await send("model-switch", messages)).json();
  const { sessionStore } = await import("../src/session-store.js");
  const [key, before] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === "model-switch")!;
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(first.content[0].id, "MODEL_SWITCH_RESULT")] });
  const final = await (await send("model-switch", messages, { model: "gemini-3.8-flash-low" })).json();
  expect(final.stop_reason).toBe("end_turn");
  const after = await sessionStore.get(key);
  // Fake ACP numbers sessions per process, so epoch is the rebuild evidence.
  expect(after?.conversation?.epoch).toBeGreaterThan(before.conversation!.epoch);
  expect(after?.model).toBe("gemini-3.8-flash-low");
  expect((await sessionStore.toolCall(key, first.content[0].id))?.resultDigest).toBeString();
  expect((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!).toContain("MODEL_SWITCH_RESULT");
  expect((await readFile(join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!).toContain("have already executed in OpenCode");
});

test("generic host idle expiry retires a pending tool without fabricating success", async () => {
  process.env.OPENCODE_ANTIGRAVITY_HOST_IDLE_MS = "1000";
  try {
    const first = await (await send("terminal-output", [{ role: "user", content: "FAKE_MCP" }], { tools: [{ name: "StructuredOutput", input_schema: { type: "object" } }] })).json();
    expect(first.stop_reason).toBe("tool_use");
    const { sessionStore } = await import("../src/session-store.js");
    const [key] = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === "terminal-output")!;
    await new Promise(resolve => setTimeout(resolve, 1300));
    const saved = await sessionStore.toolCall(key, first.content[0].id);
    expect(saved?.result).toBeUndefined();
    expect(saved?.terminalAcceptance).toBeUndefined();
    const { sessionPool } = await import("../src/session-pool.js");
    expect((await sessionPool.status(key)).active).toBe(false);
  } finally { delete process.env.OPENCODE_ANTIGRAVITY_HOST_IDLE_MS; }
});

test("StructuredOutput success events cannot abort ordinary result delivery or a newer call", async () => {
  const { recordHostToolSuccess } = await import("../src/host-tools.js");
  const { sessionStore } = await import("../src/session-store.js");
  const session = "ordinary-structured-output";
  const tools = [{ name: "StructuredOutput", input_schema: { type: "object" } }];
  const messages: any[] = [{ role: "user", content: "FAKE_MCP" }];
  const first = await (await send(session, messages, { tools })).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === session)!;
  await recordHostToolSuccess(session, call.id, "original-success");
  await recordHostToolSuccess(session, call.id, "duplicate-success");
  expect((await sessionStore.toolCall(key, call.id))?.result).toBeUndefined();
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "ORIGINAL_STRUCTURED_RESULT")] });
  const completed = await (await send(session, messages, { tools })).json();
  expect(completed.stop_reason).toBe("end_turn");
  expect(JSON.stringify(completed)).toContain("ORIGINAL_STRUCTURED_RESULT");
  expect((await sessionStore.toolCall(key, call.id))?.delivery).toBe("locally-handed-off");
  messages.push({ role: "assistant", content: completed.content }, { role: "user", content: "FAKE_MCP SECOND" });
  const second = await (await send(session, messages, { tools })).json();
  const next = second.content.find((part: any) => part.type === "tool_use");
  expect(next.id).not.toBe(call.id);
  await recordHostToolSuccess(session, call.id, "delayed-old-success");
  await recordHostToolSuccess(session, next.id, "new-success");
  await recordHostToolSuccess(session, next.id, "duplicate-new-success");
  messages.push({ role: "assistant", content: second.content }, { role: "user", content: [result(next.id, "SECOND_STRUCTURED_RESULT")] });
  const final = await (await send(session, messages, { tools })).json();
  expect(final.stop_reason).toBe("end_turn");
  expect(JSON.stringify(final)).toContain("SECOND_STRUCTURED_RESULT");
  expect((await sessionStore.toolCall(key, next.id))?.delivery).toBe("locally-handed-off");
});

test("MCP tools render only as host calls while thinking and compaction notices survive", async () => {
  for (const stream of [false, true]) {
    const session = `activity-${stream}`;
    const messages: any[] = [{ role: "user", content: "FAKE_MCP_ACTIVITY" }];
    const firstResponse = await send(session, messages, { stream });
    const firstText = await firstResponse.text();
    expect(firstText).toContain("GENUINE_THOUGHT_BEFORE");
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

test("quota rejection evidence cannot erase already emitted and completed host calls", async () => {
  const { sessionStore } = await import("../src/session-store.js");
  const messages: any[] = [{ role: "user", content: "FAKE_MCP_QUOTA" }];
  const first = await (await send("quota-after-tools", messages)).json();
  const call = first.content.find((part: any) => part.type === "tool_use");
  const [key] = (await sessionStore.entries()).find(([, record]) => record.conversation?.hostSessionID === "quota-after-tools")!;
  const saved = (await sessionStore.toolCall(key, call.id))!;
  expect((await sessionStore.receipt(key, String(saved.requestId)))?.state).toBe("parked");
  const response = await send("quota-after-tools", [...messages, { role: "assistant", content: first.content }, { role: "user", content: [result(call.id, "EXECUTED_ONCE")] }]);
  expect(response.status).toBe(429);
  expect((await sessionStore.receipt(key, String(saved.requestId)))?.state).toBe("uncertain");
  expect((await sessionStore.toolCall(key, call.id))?.resultDigest).toBeString();
  const repeated = await send("quota-after-tools", messages);
  expect(repeated.status).toBe(400);
  expect((await repeated.json()).error.message).toContain("already started");
  const logged = (await readFile(process.env.FAKE_ACP_PROMPT_LOG!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(logged.filter(entry => entry.text.includes("FAKE_MCP_QUOTA"))).toHaveLength(1);
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

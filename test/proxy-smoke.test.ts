import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REQUEST_KIND_HEADER, SESSION_HEADER } from "../src/constants.js";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { emitAcpCatalog } from "../src/catalog-events.js";
import { acpModelCatalog } from "../src/models.js";
import { getProxyRuntime } from "../src/proxy.js";
let compatibility: ReturnType<typeof fixtureCompatibility>;

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "opencode-antigravity-test-"));
process.env.GEMINI_HOME = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR, "gemini-home");
delete process.env.OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD;
delete process.env.FAKE_ACP_STATE_FILE;
const promptLog = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR, "prompts.jsonl");
process.env.FAKE_ACP_PROMPT_LOG = promptLog;
const secondWorkspace = await mkdtemp(join(tmpdir(), "opencode-antigravity-workspace-"));
const outsideWorkspace = await mkdtemp(join(tmpdir(), "opencode-antigravity-outside-"));
const { getProxyBaseUrl, startProxy, stopProxy } = await import("../src/proxy.js");

const authHeaders = { "content-type": "application/json", "x-api-key": "opencode-antigravity-local" };
const message = (content: unknown, extra: Record<string, unknown> = {}) => ({ model: "gemini-3.8-flash", max_tokens: 4096, messages: [{ role: "user", content }], ...extra });

describe("loopback Anthropic proxy", () => {
  beforeAll(async () => { compatibility = fixtureCompatibility(); await chmod(fixture, 0o755); await startProxy(process.cwd()); });
  afterAll(async () => {
    await stopProxy();
    compatibility.mockRestore();
    await Promise.all([rm(secondWorkspace, { recursive: true, force: true }), rm(outsideWorkspace, { recursive: true, force: true })]);
  });

  test("routine Gemini/Claude output budgets do not exhaust chat byte caps", async () => {
    const oldExtra = process.env.FAKE_ACP_EXTRA_MODEL;
    const oldLimit = process.env.OPENCODE_ANTIGRAVITY_UTILITY_MAX_CHARS;
    process.env.FAKE_ACP_EXTRA_MODEL = "claude-sonnet-4-6";
    process.env.OPENCODE_ANTIGRAVITY_UTILITY_MAX_CHARS = "24576";
    const runtime = getProxyRuntime()!;
    emitAcpCatalog(runtime.manager.scope, acpModelCatalog(fixture, "test", [...runtime.catalog.exactModels.map(m => [m.id, m.name] as [string, string]), ["claude-sonnet-4-6", "Claude Sonnet"]]));
    try {
      for (const [model, max_tokens] of [["gemini-3.8-flash", 65536], ["claude-sonnet-4-6", 128000]] as const) {
        const headers = { ...authHeaders, [SESSION_HEADER]: `routine-budget-${model}` };
        const messages: any[] = [{ role: "user", content: "Tiny chat request." }];
        const first = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify({ model, max_tokens, messages }) });
        expect(first.status).toBe(200);
        const result = await first.json();
        messages.push({ role: "assistant", content: result.content }, { role: "user", content: "A second tiny request." });
        expect((await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify({ model, max_tokens, messages }) })).status).toBe(200);
      }
    } finally {
      if (oldExtra === undefined) delete process.env.FAKE_ACP_EXTRA_MODEL; else process.env.FAKE_ACP_EXTRA_MODEL = oldExtra;
      if (oldLimit === undefined) delete process.env.OPENCODE_ANTIGRAVITY_UTILITY_MAX_CHARS; else process.env.OPENCODE_ANTIGRAVITY_UTILITY_MAX_CHARS = oldLimit;
    }
  });

  test("serves Anthropic messages and ordered streaming", async () => {
    const base = getProxyBaseUrl();
    expect((await fetch(base.replace(/\/v1$/, "") + "/health")).status).toBe(200);
    const models = await (await fetch(base + "/models", { headers: { "x-api-key": "opencode-antigravity-local" } })).json();
    expect(models.data.some((model: { id: string }) => model.id === "gemini-3.8-flash")).toBe(true);
    const sessionHeaders = { ...authHeaders, "x-opencode-antigravity-session": "smoke" };
    const first = await fetch(base + "/messages", { method: "POST", headers: sessionHeaders, body: JSON.stringify(message("remember FAKE_MEMORY")) });
    expect(first.status).toBe(200);
    const firstContent = (await first.json()).content;
    expect(firstContent[0].text).toContain("FAKE_OK");
    const second = await fetch(base + "/messages", { method: "POST", headers: sessionHeaders, body: JSON.stringify(message("what did you remember", { stream: true, messages: [{ role: "user", content: "remember FAKE_MEMORY" }, { role: "assistant", content: firstContent }, { role: "user", content: "what did you remember" }] })) });
    const text = await second.text();
    expect(second.status).toBe(200);
    expect(text).toContain("FAKE_MEMORY");
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");
  });

  test("keeps thinking, plans, tools, and text in separate ordered blocks", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: authHeaders, body: JSON.stringify(message("FAKE_PROGRESS", { stream: true })) });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text.indexOf("thinking about the request")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Inspect the workspace")).toBeGreaterThan(text.indexOf("thinking about the request"));
    expect(text.indexOf("Read files")).toBeGreaterThan(text.indexOf("Inspect the workspace"));
    expect(text.indexOf("progressive answer")).toBeGreaterThan(text.indexOf("Read files"));
    expect(text).toContain('"type":"content_block_start"');
    expect(text).toContain('"type":"message_stop"');
  });

  test("requires the local marker", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message("x")) });
    expect(response.status).toBe(401);
  });

  test("real V2 stream decoder and HTTP classifier preserve overflow, rate hints, refusal, and max-token stops", async () => {
    const { protocol } = await import("@opencode/ai/protocols/anthropic-messages");
    const { classifyProviderFailure } = await import("@opencode/ai/provider-error");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { Effect, Schema } = await import(Bun.resolveSync("effect", dirname(fileURLToPath(import.meta.resolve("@opencode/ai/protocols/anthropic-messages")))));
    for (const stream of [false, true]) {
      for (const [prompt, tag] of [["FAKE_OVERFLOW", "InvalidRequest"], ["FAKE_LATE_RATE", "RateLimit"]]) {
        const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, [SESSION_HEADER]: `classifier-${prompt}-${stream}` }, body: JSON.stringify(message(prompt, { stream })) });
        const text = await response.text();
        if (!stream || response.status !== 200) {
          const payload = JSON.parse(text);
          const failure = classifyProviderFailure({ message: payload.error.message, rawBody: text, status: response.status });
          expect(failure._tag).toBe(tag);
          if (prompt === "FAKE_OVERFLOW") expect(failure.classification).toBe("context-overflow");
          else expect(response.headers.get("Retry-After")).toBe("120");
        } else {
          expect(text).not.toContain('"type":"message_stop"');
          const error = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(event => event.type === "error");
          const decoded = Schema.decodeUnknownSync(protocol.stream.event)(JSON.stringify(error));
          expect(decoded.error.message).toContain("retry after 120 seconds");
          await expect(Effect.runPromise(protocol.stream.step(protocol.stream.initial({ model: { provider: "antigravity", route: {} } } as any), decoded))).rejects.toMatchObject({ reason: { _tag: tag } });
        }
      }
      for (const [prompt, stop] of [["FAKE_REFUSAL", "refusal"], ["FAKE_MAX_TOKENS", "max_tokens"]]) {
        const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, [SESSION_HEADER]: `finish-${prompt}-${stream}` }, body: JSON.stringify(message(prompt, { stream })) });
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(`"stop_reason":"${stop}"`);
        if (stream) {
          let state = protocol.stream.initial({ model: { provider: "antigravity", route: {} } } as any);
          const lowered: any[] = [];
          for (const frame of text.split("\n").filter(line => line.startsWith("data: "))) {
            const [next, events] = await Effect.runPromise(protocol.stream.step(state, Schema.decodeUnknownSync(protocol.stream.event)(frame.slice(6))));
            state = next; lowered.push(...events);
          }
          expect(JSON.stringify(lowered)).toContain(stop === "refusal" ? "content-filter" : "length");
        }
      }
    }
  });

  test("utility refusal is a policy failure, never a successful checkpoint", async () => {
    const { sessionStore } = await import("../src/session-store.js");
    const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, [SESSION_HEADER]: "utility-policy", [REQUEST_KIND_HEADER]: "generate" }, body: JSON.stringify(message("FAKE_REFUSAL")) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe("content_policy_violation");
  });

  test("replayed host-visible activity stays aligned in streaming and collected responses", async () => {
    const { sessionStore } = await import("../src/session-store.js");
    for (const stream of [false, true]) {
      const host = `visible-boundary-${stream}`;
      const headers = { ...authHeaders, [SESSION_HEADER]: host };
      const initial = [{ role: "user", content: "FAKE_PROGRESS INITIAL_ACTIVITY_CONTEXT" }];
      const first = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify(message("", { messages: initial, stream })) });
      expect(first.status).toBe(200);
      let content: any[];
      if (!stream) content = (await first.json()).content;
      else {
        content = [];
        for (const line of (await first.text()).split("\n").filter(line => line.startsWith("data: "))) {
          const e = JSON.parse(line.slice(6));
          if (e.type === "content_block_start") content[e.index] = { ...e.content_block };
          if (e.delta?.type === "text_delta") content[e.index].text += e.delta.text;
          if (e.delta?.type === "thinking_delta") content[e.index].thinking += e.delta.thinking;
        }
      }
      expect(content.some(part => part.type === "thinking" && part.thinking.includes("Inspect the workspace"))).toBe(true);
      const before = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
      const next = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify(message("", { messages: [...initial, { role: "assistant", content }, { role: "user", content: "ACTIVITY_FOLLOWUP_ONLY" }] })) });
      expect(next.status).toBe(200);
      await next.json();
      expect((await sessionStore.get(before[0]))!.conversation!.epoch).toBe(before[1].conversation!.epoch);
      const last = JSON.parse((await readFile(promptLog, "utf8")).trim().split("\n").at(-1)!).text;
      expect(last).toContain("ACTIVITY_FOLLOWUP_ONLY");
      expect(last).not.toContain("INITIAL_ACTIVITY_CONTEXT");
      expect(last).not.toContain("Inspect the workspace");
    }
  });

  test("allows registered workspaces and rejects unknown ones", async () => {
    await startProxy(secondWorkspace);
    const accepted = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, "x-opencode-antigravity-directory": secondWorkspace }, body: JSON.stringify(message("x")) });
    expect(accepted.status).toBe(200);
    const rejected = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, "x-opencode-antigravity-directory": outsideWorkspace }, body: JSON.stringify(message("x")) });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.message).toContain("outside");
  });

  test("accepts Anthropic image blocks with host tools", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", {
      method: "POST",
      headers: { ...authHeaders, [SESSION_HEADER]: "image-with-tools" },
      body: JSON.stringify(message([{ type: "text", text: "x" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }], { tools: [{ name: "host_tool", input_schema: { type: "object" } }], tool_choice: { type: "auto" } })),
    });
    expect(response.status).toBe(200);
  });

  test("does not terminate a failed stream as success", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: authHeaders, body: JSON.stringify(message("FAKE_AUTH_ERROR", { stream: true })) });
    const text = await response.text();
    expect(response.status).toBe(401);
    expect(text).toContain('"type":"error"');
    expect(text).not.toContain('"type":"message_stop"');
  });
  test("preserves ACP limit finish reasons with and without streaming", async () => {
    for (const marker of ["FAKE_MAX_TOKENS", "FAKE_MAX_TURNS"]) {
      for (const stream of [false, true]) {
        const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: authHeaders,
          body: JSON.stringify(message(marker, { stream })) });
        expect(response.status).toBe(200);
        if (stream) expect(await response.text()).toContain('"stop_reason":"max_tokens"');
        else expect((await response.json()).stop_reason).toBe("max_tokens");
      }
    }
  });

  test("uses the forwarded message ID to replay HTTP retries", async () => {
    const headers = { ...authHeaders, "x-opencode-antigravity-session": "http-retry", "x-opencode-antigravity-message": "same-message" };
    const send = (text: string) => fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify(message(text)) });
    const first = await (await send("FAKE_STREAM")).json();
    const retry = await (await send("changed request serialization")).json();
    expect(retry.content).toEqual(first.content);
    expect(retry.content[0].text).toContain("FAKE_STREAM_OK");
  });

  test("replays identical V2 requests without a message ID", async () => {
    const headers = { ...authHeaders, "x-opencode-antigravity-session": "v2-hash-retry" };
    const body = message("V2_REPLAY_IDENTITY");
    const send = () => fetch(getProxyBaseUrl() + "/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const first = await (await send()).json();
    const retry = await (await send()).json();
    expect(retry.content).toEqual(first.content);
    const prompts = (await readFile(promptLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { text: string })
      .filter((entry) => entry.text.includes("V2_REPLAY_IDENTITY"));
    expect(prompts).toHaveLength(1);
  });

  test("routes transient V2 generate requests through a disposable ACP session", async () => {
    const { createHash } = await import("node:crypto");
    const { sessionPool } = await import("../src/session-pool.js");
    const send = (sessionID: string, text: string, kind: string) => fetch(getProxyBaseUrl() + "/messages", {
      method: "POST",
      headers: {
        ...authHeaders,
        [SESSION_HEADER]: sessionID,
        [REQUEST_KIND_HEADER]: kind,
      },
      body: JSON.stringify(message(text)),
    });
    const { getProxyRuntime } = await import("../src/proxy.js");
    const sessionKey = (sessionID: string) => `${getProxyRuntime()!.manager.scope}:` + createHash("sha256")
      .update(`workspace:${process.cwd()}:session:${sessionID}`)
      .digest("hex");

    const transientSession = "v2-generate-isolated";
    const oversizedRequest = `${"current generate request ".repeat(3_500)}FAKE_GENERATE_TRANSIENT GENERATE_REQUEST_TAIL`;
    const oversized = await send(transientSession, oversizedRequest, "generate");
    expect(oversized.status).not.toBe(200);
    const transient = await (await send(transientSession, "FAKE_GENERATE_TRANSIENT GENERATE_REQUEST_TAIL", "generate")).json();
    expect(transient.content[0].text).toContain("FAKE_OK");
    expect((await sessionPool.status(sessionKey(transientSession))).hasSession).toBe(false);
    const generatedPrompts = (await readFile(promptLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { text: string })
      .filter((entry) => entry.text.includes("GENERATE_REQUEST_TAIL"));
    expect(generatedPrompts).toHaveLength(1);

    const primarySession = "v2-generate-primary";
    const firstPrimary = await (await send(primarySession, "remember FAKE_MEMORY", "chat")).json();
    expect(firstPrimary.content[0].text).toContain("FAKE_OK");
    const generated = await (await send(primarySession, "FAKE_GENERATE_TRANSIENT", "generate")).json();
    expect(generated.content[0].text).toContain("FAKE_OK");
    const continued = await (await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, [SESSION_HEADER]: primarySession, [REQUEST_KIND_HEADER]: "chat" }, body: JSON.stringify(message("what did you remember", { messages: [{ role: "user", content: "remember FAKE_MEMORY" }, { role: "assistant", content: firstPrimary.content }, { role: "user", content: "what did you remember" }] })) })).json();
    expect(continued.content[0].text).toContain("FAKE_MEMORY");
    expect((await sessionPool.status(sessionKey(primarySession))).hasSession).toBe(true);
  });

  test("host compaction is declined without prompting or changing the live session", async () => {
    const { sessionStore } = await import("../src/session-store.js");
    const host = "summary-transaction-runtime";
    const headers = { ...authHeaders, [SESSION_HEADER]: host, [REQUEST_KIND_HEADER]: "chat" };
    const initial = await (await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify(message("SUMMARY_BASELINE")) })).json();
    expect(initial.stop_reason).toBe("end_turn");
    const binding = (await sessionStore.entries()).find(([, r]) => r.conversation?.hostSessionID === host)!;
    const before = await readFile(process.env.FAKE_ACP_PROMPT_LOG!, "utf8");
    for (const stream of [false, true]) {
      const summaryHeaders: Record<string, string> = { ...headers };
      summaryHeaders[REQUEST_KIND_HEADER] = "compaction";
      const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: summaryHeaders, body: JSON.stringify(message("FAKE_MAX_TOKENS", { stream, system: "You are tasked with summarizing conversations." })) });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("agy_internal_compaction");
      expect(await sessionStore.get(binding[0])).toEqual(binding[1]);
    }
    expect(await readFile(process.env.FAKE_ACP_PROMPT_LOG!, "utf8")).toBe(before);
    const continued = await (await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify(message("continue", { messages: [{ role: "user", content: "SUMMARY_BASELINE" }, { role: "assistant", content: initial.content }, { role: "user", content: "continue" }] })) })).json();
    expect(continued.stop_reason).toBe("end_turn");
    expect((await sessionStore.get(binding[0]))!.sessionId).toBe(binding[1].sessionId);
  });

  test("utility success and failure clean their real ACP homes", async () => {
    const data = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const before = await readdir(join(data, "host-acp"));
    for (const [kind, prompt, status] of [["title", "short title", 200], ["generate", "FAKE_REFUSAL", 400]] as const) {
      const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: { ...authHeaders, [REQUEST_KIND_HEADER]: kind }, body: JSON.stringify(message(prompt)) });
      expect(response.status).toBe(status);
      await response.text();
      expect(await readdir(join(data, "utilities"))).toEqual([]);
      expect(await readdir(join(data, "host-acp"))).toEqual(before);
    }
  });

  test("summary and title phrases without a routing header remain ordinary chat", async () => {
    const response = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: authHeaders, body: JSON.stringify(message("NORMAL_CHAT", { system: "You are a title generator. You are tasked with summarizing conversations. Write like a pull request description." })) });
    expect(response.status).toBe(200);
    expect((await response.json()).stop_reason).toBe("end_turn");
    const sent = JSON.parse((await readFile(promptLog, "utf8")).trim().split("\n").at(-1)!);
    expect(sent.text).toContain("NORMAL_CHAT");
    expect(sent.text).not.toContain("Generate a concise 3-7 word session title");
  });

  test("session config updates change picker inventory and request validation together", async () => {
    const { refreshModels, onModelCatalogChange } = await import("../src/proxy.js");
    let changes = 0;
    const unsubscribe = onModelCatalogChange(() => { changes++; });
    try {
      const updated = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: authHeaders, body: JSON.stringify(message("FAKE_CATALOG_UPDATE")) });
      expect(updated.status).toBe(200);
      await updated.text();
      const catalog = await (await fetch(getProxyBaseUrl() + "/models", { headers: authHeaders })).json();
      expect(catalog.data.map((model: any) => model.id)).toEqual(["new-server-model"]);
      expect(changes).toBeGreaterThan(0);
      const unavailable = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers: authHeaders, body: JSON.stringify(message("old model")) });
      expect(unavailable.status).toBe(400);
    } finally { unsubscribe(); await refreshModels(); }
  });
});

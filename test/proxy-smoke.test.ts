import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REQUEST_KIND_HEADER, SESSION_HEADER } from "../src/constants.js";

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
  beforeAll(async () => { await chmod(fixture, 0o755); await startProxy(process.cwd()); });
  afterAll(async () => {
    await stopProxy();
    await Promise.all([rm(secondWorkspace, { recursive: true, force: true }), rm(outsideWorkspace, { recursive: true, force: true })]);
  });

  test("serves Anthropic messages and ordered streaming", async () => {
    const base = getProxyBaseUrl();
    expect((await fetch(base.replace(/\/v1$/, "") + "/health")).status).toBe(200);
    const models = await (await fetch(base + "/models", { headers: { "x-api-key": "opencode-antigravity-local" } })).json();
    expect(models.data.some((model: { id: string }) => model.id === "gemini-3.8-flash")).toBe(true);
    const sessionHeaders = { ...authHeaders, "x-opencode-antigravity-session": "smoke" };
    const first = await fetch(base + "/messages", { method: "POST", headers: sessionHeaders, body: JSON.stringify(message("remember FAKE_MEMORY")) });
    expect(first.status).toBe(200);
    expect((await first.json()).content[0].text).toContain("FAKE_OK");
    const second = await fetch(base + "/messages", { method: "POST", headers: sessionHeaders, body: JSON.stringify(message("what did you remember", { stream: true })) });
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
    const transient = await (await send(transientSession, oversizedRequest, "generate")).json();
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
    const continued = await (await send(primarySession, "what did you remember", "chat")).json();
    expect(continued.content[0].text).toContain("FAKE_MEMORY");
    expect((await sessionPool.status(sessionKey(primarySession))).hasSession).toBe(true);
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

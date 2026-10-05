import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityCliPlugin, AUTH_METHOD_ID, INTEGRATION_ID, PLUGIN_ID } from "../src/index.js";
import {
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MESSAGE_HEADER,
  MODEL_HEADER,
  PROVIDER_ID,
  REQUEST_KIND_HEADER,
  SESSION_HEADER,
} from "../src/constants.js";
import { getProxyPort, getProxyRuntime } from "../src/proxy.js";
import { emitAcpCatalog } from "../src/catalog-events.js";
import { acpModelCatalog } from "../src/models.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const temporaryDirectories: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];
const savedEnvironment = new Map<string, string | undefined>();
const environmentKeys = ["OPENCODE_ANTIGRAVITY_ACP_PATH", "OPENCODE_ANTIGRAVITY_DATA_DIR", "GEMINI_HOME", "OPENCODE_ANTIGRAVITY_MODELS_DEV"];

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  for (const key of environmentKeys) {
    const value = savedEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test("V2 setup registers provider models, integration auth, request hook, and cleanup", async () => {
  for (const key of environmentKeys) savedEnvironment.set(key, process.env[key]);
  const root = await temporaryDirectory("agy-v2-plugin-");
  const sessionDirectory = await temporaryDirectory("agy-v2-session-");
  const concurrentDirectory = await temporaryDirectory("agy-v2-concurrent-session-");
  const geminiHome = await temporaryDirectory("agy-v2-gemini-");
  process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(root, "data");
  process.env.GEMINI_HOME = geminiHome;
  process.env.OPENCODE_ANTIGRAVITY_MODELS_DEV = "0";
  await chmod(fixture, 0o755);

  const providers: any[] = [];
  let providerTransform: ((editor: any) => void) | undefined;
  const methods: any[] = [];
  const savedMarkers: any[] = [];
  let marker: any;
  const sessionDirectories = new Map<string, string>();
  const hooks = new Map<string, { callback: (event: any) => Promise<void>; options?: unknown }>();
  const context = {
    location: { directory: root },
    options: {},
    integration: {
      connection: {
        active: async () => marker ? { id: "local-marker" } : undefined,
        resolve: async () => marker,
      },
      connect: { key: async (input: any) => { savedMarkers.push(input); marker = { type: "key", key: input.key }; } },
      transform: async (callback: (editor: any) => void) => {
        callback({
          update: () => undefined,
          method: { update: (input: any) => methods.push(input) },
        });
        return { dispose: async () => undefined };
      },
    },
    provider: {
      reload: async () => { providerTransform?.({ add: (input: any) => providers.push(input) }); },
      transform: async (callback: (editor: any) => void) => {
        providerTransform = callback;
        callback({ add: (input: any) => providers.push(input) });
        return { dispose: async () => undefined };
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void>, options?: unknown) => {
        hooks.set(name, { callback, options });
        return { dispose: async () => hooks.delete(name) };
      },
      get: async ({ sessionID }: { sessionID: string }) => ({
        location: { directory: sessionDirectories.get(sessionID) ?? sessionDirectory },
      }),
    },
  };

  const cleanup = await (AntigravityCliPlugin as any).setup(context);
  cleanupTasks.push(cleanup);
  expect(PLUGIN_ID).toBe("opencode-antigravity");
  expect(INTEGRATION_ID).toBe(PROVIDER_ID);
  expect(savedMarkers).toEqual([{ integrationID: PROVIDER_ID, key: LOCAL_API_KEY }]);
  expect(typeof cleanup).toBe("function");

  const provider = providers[0];
  expect(provider.info).toMatchObject({
    id: PROVIDER_ID,
    name: "Antigravity ACP",
    activation: "enabled",
    integrationID: INTEGRATION_ID,
    package: "@opencode/ai/providers/anthropic",
    settings: { baseURL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1$/), apiKey: LOCAL_API_KEY },
  });
  const flash = provider.models.find((model: { id: string }) => model.id === "gemini-3.8-flash");
  expect(flash.variants.map((variant: { id: string }) => variant.id)).toEqual(["high", "medium", "low"]);
  expect(flash.capabilities.tools).toBe(false);
  expect(flash.limit).toEqual({ context: 1_048_576, output: 65_536 });

  expect(methods.some((method) => method.integrationID === PROVIDER_ID && method.method.type === "key")).toBe(true);
  const auth = methods.find((method) => method.integrationID === INTEGRATION_ID && method.method.type === "oauth");
  expect(auth.method).toMatchObject({ id: AUTH_METHOD_ID, type: "oauth" });
  expect(auth.method.form[0].options.map((option: { value: string }) => option.value)).toContain("gemini-api-key");
  const authorization = await auth.authorize({ method: "oauth-personal" });
  expect(authorization.mode).toBe("auto");
  const credential = await authorization.callback;
  expect(credential).toMatchObject({
    type: "oauth",
    methodID: AUTH_METHOD_ID,
    access: LOCAL_API_KEY,
    refresh: LOCAL_API_KEY,
  });
  expect(JSON.stringify(credential)).not.toContain("access_token");
  expect(JSON.stringify(credential)).not.toContain("refresh_token");

  for (const kind of ["context", "compaction", "generate", "title"]) {
    const hook = hooks.get(kind)!;
    expect(hook.options).toEqual({ providerID: PROVIDER_ID });
    const request = { options: { temperature: 0.5, reasoningEffort: "high", maxTokens: 1024 } };
    await hook.callback(request);
    expect(request.options).toEqual({ maxTokens: 1024 });
  }

  const modelRequest = hooks.get("model.request")!;
  expect(modelRequest.options).toEqual({ providerID: PROVIDER_ID });
  const event = {
    sessionID: "session-v2",
    agent: "build",
    model: { providerID: PROVIDER_ID, id: "gemini-3.8-flash", variant: "high" },
    kind: "primary",
    baseURL: "http://old.invalid/v1",
    headers: { Authorization: "must-not-forward", authorization: "must-not-forward" },
  };
  await modelRequest.callback(event);
  expect(event.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  expect(event.headers["x-api-key"]).toBe(LOCAL_API_KEY);
  expect(event.headers[MODEL_HEADER]).toBe("gemini-3.8-flash");
  expect(event.headers[EFFORT_HEADER]).toBe("high");
  expect(event.headers[DIRECTORY_HEADER]).toBe(sessionDirectory);
  expect(event.headers[SESSION_HEADER]).toBe("session-v2");
  expect(event.headers[REQUEST_KIND_HEADER]).toBe("chat");
  expect(event.headers).not.toHaveProperty("Authorization");
  expect(event.headers).not.toHaveProperty("authorization");
  expect(event.headers).not.toHaveProperty(MESSAGE_HEADER);

  const titleEvent = { ...event, kind: "title", headers: {} };
  await modelRequest.callback(titleEvent);
  expect(titleEvent.headers[REQUEST_KIND_HEADER]).toBe("title");
  const compactionEvent = { ...event, kind: "compaction", headers: {} };
  await modelRequest.callback(compactionEvent);
  expect(compactionEvent.headers[REQUEST_KIND_HEADER]).toBe("summary");
  const generateEvent = { ...event, kind: "generate", headers: {} };
  await modelRequest.callback(generateEvent);
  expect(generateEvent.headers[REQUEST_KIND_HEADER]).toBe("generate");
  const defaultVariantEvent = { ...event, model: { ...event.model, variant: "default" }, headers: {} };
  await modelRequest.callback(defaultVariantEvent);
  expect(defaultVariantEvent.headers).not.toHaveProperty(EFFORT_HEADER);

  sessionDirectories.set("concurrent-session-a", concurrentDirectory);
  sessionDirectories.set("concurrent-session-b", concurrentDirectory);
  await Promise.all(["concurrent-session-a", "concurrent-session-b"].map((sessionID) =>
    modelRequest.callback({ ...event, sessionID, headers: {} }),
  ));

  const runtime = getProxyRuntime()!;
  emitAcpCatalog(runtime.manager.scope, acpModelCatalog(fixture, "test", [["future-opaque", "Future model"]]));
  expect(providers.at(-1).models.map((model: any) => model.id)).toEqual(["future-opaque"]);
  expect(runtime.catalog.exactModels.map((model) => model.id)).toEqual(["future-opaque"]);

  await Promise.all([cleanup(), cleanup()]);
  cleanupTasks.pop();
  expect(getProxyPort()).toBeNull();

  // Reloading a location reuses the automatic local marker, not another account.
  const secondCleanup = await (AntigravityCliPlugin as any).setup(context);
  cleanupTasks.push(secondCleanup);
  expect(savedMarkers).toHaveLength(1);
});

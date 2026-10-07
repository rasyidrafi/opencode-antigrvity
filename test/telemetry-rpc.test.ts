import { afterAll, beforeAll, expect, test } from "bun:test";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
let compatibility: ReturnType<typeof fixtureCompatibility>;
beforeAll(() => { compatibility = fixtureCompatibility(); });
afterAll(() => { compatibility.mockRestore(); });
import { chmod, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AntigravityPlugin } from "../src/index.js";
import { ContextTelemetry } from "@rasyid_rafi/opencode-antigravity/rpc";
import { sessionStore } from "../src/session-store.js";
import { AsyncEventQueue } from "../src/acp-process.js";
import { getProxyBaseUrl } from "../src/proxy.js";
import { LOCAL_API_KEY, SESSION_HEADER } from "../src/constants.js";

// Resolve the exact client shipped with the installed plugin, not a separately
// upgraded SDK. The wire fixture implements the published V2 HTTP RPC/event
// envelopes; the real plugin registers its actual handlers into it.
const clientPath = Bun.resolveSync("@opencode/client", dirname(fileURLToPath(import.meta.resolve("@opencode/plugin"))));
const { OpenCode } = await import(clientPath);

test("installed V2 client reads telemetry, consumes change events, resyncs, and enforces RPC/location/auth schemas", async () => {
  const keys = ["OPENCODE_ANTIGRAVITY_DATA_DIR", "OPENCODE_ANTIGRAVITY_ACP_PATH", "GEMINI_HOME", "OPENCODE_ANTIGRAVITY_MODELS_DEV", "FAKE_ACP_NO_USAGE"];
  const old = keys.map(key => process.env[key]);
  const root = await mkdtemp(`${process.env.TMPDIR || "/tmp/opencode"}/rpc-wire-`);
  const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(root, "data");
  process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
  process.env.GEMINI_HOME = join(root, "gemini");
  process.env.OPENCODE_ANTIGRAVITY_MODELS_DEV = "0";
  await chmod(fixture, 0o755);
  let definition: any;
  let handlers: any;
  let registered = false;
  let cleaned = false;
  const eventControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const hostEvents = new AsyncEventQueue<any>();
  const encoder = new TextEncoder();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/event") {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; eventControllers.add(c); c.enqueue(encoder.encode(": connected\n\n")); }, cancel() { eventControllers.delete(controller); } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path === `/api/rpc/${ContextTelemetry.id}/read`) {
      if (!registered) return Response.json({ _tag: "RpcError", type: "rpc.unavailable", message: "disposed" }, { status: 400 });
      const { input } = await request.json();
      if (!z.fromJSONSchema(definition.methods.read.input).safeParse(input).success) return Response.json({ _tag: "RpcError", type: "rpc.invalid_input", message: "Invalid input" }, { status: 400 });
      const output = await handlers.read(input, { error: (type: string, message: string, data: unknown) => ({ fixtureError: true, type, message, data }) });
      if (output.fixtureError) return Response.json({ _tag: "RpcError", type: output.type, message: output.message, data: output.data }, { status: 400 });
      z.fromJSONSchema(definition.methods.read.output).parse(output);
      return Response.json({ output });
    }
    return new Response("Not found", { status: 404 });
  } });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const ctx: any = {
      location: { directory: root }, options: {},
      rpc: { register: async (d: any, h: any) => { definition = d; handlers = h; registered = true; return {
        dispose: async () => { registered = false; },
        events: { emit: async (name: string, data: unknown) => {
          z.fromJSONSchema(definition.events[name].schema).parse(data);
          const payload = { id: `evt_${Date.now()}`, type: `rpc.${definition.id}.${name}`, durable: false, location: { directory: root }, data };
          for (const controller of eventControllers) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } },
      }; } },
      event: { subscribe: ({ signal }: { signal: AbortSignal }) => { signal.addEventListener("abort", () => hostEvents.close(), { once: true }); return { async *[Symbol.asyncIterator]() { while (true) { const next = await hostEvents.next(); if (next.done) return; yield next.value; } } }; } },
      session: { hook: async () => ({ dispose: async () => {} }), get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: sessionID === "foreign" ? root + "-foreign" : root } }) },
      integration: { connection: { active: async () => ({}), resolve: async () => ({ type: "key", key: LOCAL_API_KEY }) }, transform: async (fn: any) => { fn({ update() {}, method: { update() {} } }); } },
      provider: { reload: async () => {}, transform: async (fn: any) => { fn({ add() {} }); } },
    };
    cleanup = await (AntigravityPlugin as any).setup(ctx);
    const client = OpenCode.make({ baseUrl: server.url.toString() });
    const rpc = client.rpc(ContextTelemetry);
    const initial = await rpc.read({ sessionID: "host" });
    expect(initial).toMatchObject({ version: 1, epoch: 0, state: "unknown" });
    await expect(rpc.read({})).rejects.toMatchObject({ type: "rpc.invalid_input" });
    await expect(rpc.read({ sessionID: "" })).rejects.toMatchObject({ type: "rpc.invalid_input" });
    await expect(rpc.read({ sessionID: "foreign" })).rejects.toMatchObject({ type: "wrong_location" });
    const changes = rpc.events.subscribe("changed")[Symbol.asyncIterator]();
    const firstEvent = changes.next();
    for (let i = 0; i < 100 && !eventControllers.size; i++) await Bun.sleep(10);
    expect(eventControllers.size).toBe(1);
    const headers = { "x-api-key": LOCAL_API_KEY, [SESSION_HEADER]: "host", "content-type": "application/json" };
    expect((await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "RPC_ACTUAL_PUMP" }] }) })).status).toBe(200);
    const changed = await firstEvent;
    expect(changed.value.type).toBe("rpc.antigravity-context-v1.changed");
    expect(changed.value.location.directory).toBe(root);
    expect(changed.value.data).toMatchObject({ epoch: 0, state: "measured", used: 12, size: 1000 });
    expect(await rpc.read({ sessionID: "host" })).toEqual(changed.value.data);
    expect(await (await fetch(getProxyBaseUrl() + "/usage", { headers })).json()).toEqual(changed.value.data);
    expect((await fetch(getProxyBaseUrl() + "/usage", { headers: { [SESSION_HEADER]: "host" } })).status).toBe(401);
    expect((await fetch(getProxyBaseUrl() + "/usage", { headers: { "x-api-key": LOCAL_API_KEY } })).status).toBe(400);
    // The replacement supplies no usage. Both the actual strict RPC schema
    // and authenticated /v1/usage must resync to unknown, not old occupancy.
    process.env.FAKE_ACP_NO_USAGE = "1";
    const replacementEvent = changes.next();
    expect((await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "EDITED_RPC_BASELINE" }] }) })).status).toBe(200);
    const invalidated = (await replacementEvent).value.data;
    expect(invalidated).toMatchObject({ epoch: 0, state: "unknown" });
    expect(invalidated.sequence).toBeGreaterThan(changed.value.data.sequence);
    expect((await changes.next()).value.data).toMatchObject({ epoch: 0, state: "unknown" });
    const replaced = await rpc.read({ sessionID: "host" });
    expect(replaced.state).toBe("unknown");
    expect(replaced.used).toBeUndefined();
    expect(await (await fetch(getProxyBaseUrl() + "/usage", { headers })).json()).toEqual(replaced);
    delete process.env.FAKE_ACP_NO_USAGE;
    const freshEvent = changes.next();
    expect((await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "FRESH_RPC_BASELINE" }] }) })).status).toBe(200);
    let fresh = await freshEvent;
    for (let i = 0; i < 3 && fresh.value.data.state === "unknown"; i++) fresh = await changes.next();
    expect(fresh.value.data).toMatchObject({ state: "measured", used: 12 });
    expect(await rpc.read({ sessionID: "host" })).toEqual(fresh.value.data);
    expect(await (await fetch(getProxyBaseUrl() + "/usage", { headers })).json()).toEqual(fresh.value.data);
    const persisted = (await sessionStore.contextSnapshot("host"))!;
    await sessionStore.saveContextSnapshot("host", { ...persisted, observedAt: Date.now() - 300_001 });
    expect(await rpc.read({ sessionID: "host" })).toMatchObject({ state: "stale" });
    hostEvents.push({ id: "evt_rpc_commit", type: "session.compaction.ended", data: { sessionID: "host" } });
    await Bun.sleep(20);
    expect(await sessionStore.contextSnapshot("host")).toEqual({ ...persisted, observedAt: expect.any(Number) });
    await changes.return();
    // Read is the authoritative resync after a missed live event.
    expect(await rpc.read({ sessionID: "host" })).toMatchObject({ epoch: persisted.epoch, state: "stale" });
    await cleanup(); cleaned = true;
    await expect(rpc.read({ sessionID: "host" })).rejects.toMatchObject({ type: "rpc.unavailable" });
  } finally {
    if (!cleaned) await cleanup?.();
    for (const controller of eventControllers) { try { controller.close(); } catch {} }
    await server.stop(true);
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  }
}, 15_000);

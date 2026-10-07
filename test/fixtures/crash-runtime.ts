import { test, expect } from "bun:test";
import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureCompatibility } from "./compatibility.js";
import { startProxy, stopProxy, getProxyBaseUrl } from "../../src/proxy.js";
import { sessionStore } from "../../src/session-store.js";
import { HostBridge } from "../../src/host-tools.js";
import { SESSION_HEADER } from "../../src/constants.js";

// This file is run only in a separate test process. No shipped hooks or env bypass.
if (process.env.AGY_CRASH_CHILD) test("integrated crash child", async () => {
  const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
  const point = process.env.AGY_CRASH_POINT!;
  const recovery = process.env.AGY_CRASH_RECOVERY === "1";
  process.env.FAKE_ACP_MCP_RESULT_LOG = join(root, "mcp-results.jsonl");
  fixtureCompatibility();
  const barrier = async (name: string, extra: object = {}) => {
    if (!recovery && point === name) {
      process.send!({ barrier: name, ...extra });
      await new Promise<void>(() => {});
    }
  };
  if (!recovery) {
    const saveCall = sessionStore.saveToolCall.bind(sessionStore);
    sessionStore.saveToolCall = async (key, id, value) => {
      if (!value.resultDigest) await barrier("before-call-persistence");
      await saveCall(key, id, value);
      if (!value.resultDigest) await barrier("after-call-persistence", { call: value.call });
    };
    const saveResult = sessionStore.saveToolResult.bind(sessionStore);
    sessionStore.saveToolResult = async (...args) => {
      await barrier("before-result-persistence");
      await saveResult(...args);
      await barrier("after-result-persistence");
    };
    const delivery = sessionStore.toolDelivery.bind(sessionStore);
    sessionStore.toolDelivery = async (...args) => {
      if (args[2] === "delivery-attempted") await barrier("before-waiter-release");
      await delivery(...args);
      if (args[2] === "delivery-attempted") await barrier("after-delivery-intent");
    };
    const request = HostBridge.prototype.request;
    HostBridge.prototype.request = async function* (input) {
      for await (const event of request.call(this, input)) {
        if (event.event === "host_tools") await barrier("before-exposure", { call: event.calls[0] });
        yield event;
      }
    };
  }
  await startProxy(root);
  const initial = [{ role: "user", content: "FAKE_MCP CRASH_ONCE" }];
  const send = (messages: unknown) => fetch(getProxyBaseUrl() + "/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "opencode-antigravity-local", [SESSION_HEADER]: "crash-host" },
    body: JSON.stringify({ model: "gemini-3.8-flash", tools: [{ name: "shell", input_schema: { type: "object" } }], messages }),
  });
  if (recovery) {
    const exposed = await readFile(join(root, "exposed.json"), "utf8").then(JSON.parse).catch(() => undefined);
    const messages = exposed ? [...initial, { role: "assistant", content: exposed.content }] : initial;
    const response = await send(messages);
    const body = await response.json();
    expect(body.content?.some((p: any) => p.type === "tool_use") ?? false).toBe(false);
    process.send!({ recovered: true, status: response.status, body, bindings: await sessionStore.entries() });
    await stopProxy();
    return;
  }
  const first = await (await send(initial)).json();
  expect(first.stop_reason).toBe("tool_use");
  await writeFile(join(root, "exposed.json"), JSON.stringify(first));
  await barrier("after-exposure");
  // External host effect is durable before its result is submitted.
  const counter = await open(join(root, "external-counter"), "ax", 0o600);
  await counter.writeFile("effect\n"); await counter.sync(); await counter.close();
  const directory = await open(root, "r"); await directory.sync(); await directory.close();
  const continued = send([...initial, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0].id, content: "DURABLE_RESULT_ONCE" }] }]);
  if (point === "after-mcp-handoff") {
    // The test peer actually parsed the MCP HTTP response, rather than merely
    // pausing after its construction inside the handler. Not production ACK.
    for (let attempt = 0; attempt < 2000; attempt++) {
      const received = await readFile(join(root, "mcp-results.jsonl"), "utf8").catch(() => "");
      if (received.includes("DURABLE_RESULT_ONCE")) { await barrier("after-mcp-handoff", { received }); break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("MCP peer did not receive its result");
  }
  await continued;
  throw new Error("Crash barrier was not reached");
}, 60_000);

#!/usr/bin/env node

import readline from "node:readline";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

if (process.env.FAKE_ACP_PID_LOG) fs.appendFileSync(process.env.FAKE_ACP_PID_LOG, `${process.pid}\n`);

let nextRequestId = 100;
let sessionId = "fake-acp-session-1";
const stateFile = process.env.FAKE_ACP_STATE_FILE;
let remembered = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")).remembered ?? "" : "";
let activePrompt;
let mcpServers = [];
const pending = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

function request(method, params) {
  const id = nextRequestId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => pending.set(id, resolve));
}

function textFromPrompt(prompt) {
  return (Array.isArray(prompt) ? prompt : []).map((part) => {
    if (part?.type === "text") return part.text ?? "";
    if (part?.type === "image") return "[image]";
    if (part?.type === "audio") return "[audio]";
    return "";
  }).join("\n");
}

function update(update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

async function handlePrompt(message) {
  const id = message.id;
  const text = textFromPrompt(message.params?.prompt);
  if (process.env.FAKE_ACP_PROMPT_LOG) fs.appendFileSync(process.env.FAKE_ACP_PROMPT_LOG, JSON.stringify({ text, prompt: message.params?.prompt }) + "\n");
  activePrompt = { id, cancelled: false };
  if (text.includes("FAKE_INTERNAL_COMPACTION")) {
    update({ sessionUpdate: "usage_update", used: 950, size: 1000 });
    update({ sessionUpdate: "compaction_update", compactionId: "fake-internal", status: "in_progress" });
    update({ sessionUpdate: "compaction_update", compactionId: "fake-internal", status: "completed" });
    update({ sessionUpdate: "usage_update", used: 100, size: 1000 });
  }
  if (text.includes("FAKE_QUOTA_MESSAGE_ONLY")) { fail(id, -32000, "quota exceeded"); activePrompt = undefined; return; }
  if (text.includes("FAKE_CANCELLED")) { respond(id, { stopReason: "cancelled" }); activePrompt = undefined; return; }
  if (text.includes("FAKE_QUOTA_REJECTED") || text.includes("FAKE_QUOTA_UNCERTAIN")) {
    if (text.includes("FAKE_QUOTA_UNCERTAIN")) update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "accepted work" } });
    fail(id, -32000, "quota exceeded; retry in 120000ms", { retryAfter: "120000ms", execution: "rejected-before-execution" });
    activePrompt = undefined; return;
  }
  if (text.includes("FAKE_OVERFLOW")) { fail(id, -32000, "model_context_window_exceeded"); activePrompt = undefined; return; }
  if (text.includes("FAKE_LATE_RATE")) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial answer" } });
    fail(id, -32000, "rate limit; retry in 2 minutes", { retryAfter: "2 minutes" });
    activePrompt = undefined; return;
  }
  if (text.includes("FAKE_MCP") && !text.includes("[tool result") && !text.includes("[host accepted terminal output")) {
    const url = mcpServers[0]?.url;
    if (!url) { fail(id, -32603, "Missing MCP bridge"); return; }
    const rpc = async (method, params = {}) => (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextRequestId++, method, params }) })).json());
    await rpc("initialize", { protocolVersion: "2025-03-26" });
    const list = await rpc("tools/list");
    const name = list.result.tools[0].name;
    if (text.includes("FAKE_MCP_ACTIVITY")) {
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "GENUINE_THOUGHT_BEFORE" } });
      update({ sessionUpdate: "tool_call", toolCallId: "activity-tool", title: "opencode_shell: duplicate-command", kind: "execute", status: "pending" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "activity-tool", status: "in_progress" });
    }
    const count = text.includes("FAKE_MCP_PARALLEL") ? 2 : 1;
    const results = await Promise.all(Array.from({ length: count }, (_, index) => rpc("tools/call", { name, arguments: { index } })));
    if (process.env.FAKE_ACP_MCP_RESULT_LOG) fs.appendFileSync(process.env.FAKE_ACP_MCP_RESULT_LOG, JSON.stringify(results) + "\n");
    if (text.includes("FAKE_MCP_QUOTA")) {
      fail(id, -32000, "quota exceeded after tool work", { execution: "rejected-before-execution" });
      activePrompt = undefined; return;
    }
    if (text.includes("FAKE_MCP_ACTIVITY")) {
      // Updates often omit MCP metadata and the original title.
      update({ sessionUpdate: "tool_call_update", toolCallId: "activity-tool", status: "failed" });
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "GENUINE_THOUGHT_AFTER" } });
      update({ sessionUpdate: "compaction_update", compactionId: "activity-compaction", status: "completed" });
    }
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(results.map((r) => r.result ?? r.error)) } });
    if (text.includes("FAKE_MCP_SEQUENCE")) {
      const second = await rpc("tools/call", { name, arguments: { index: 2 } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(second) } });
    }
    respond(id, { stopReason: "end_turn" }); activePrompt = undefined; return;
  }
  if (text.includes("FAKE_HANG")) return;
  if (text.includes("FAKE_EXIT")) process.exit(1);
  if (text.includes("FAKE_AUTH_ERROR")) {
    fail(id, -32000, "authentication required");
    activePrompt = undefined;
    return;
  }
  if (text.includes("FAKE_PERMISSION")) {
    const permission = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "fake-tool-1", title: "Run fake tool", kind: "execute", status: "pending" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (activePrompt?.cancelled || permission?.outcome?.outcome === "cancelled" || permission?.outcome?.optionId === "deny") {
      respond(id, { stopReason: "cancelled" });
      activePrompt = undefined;
      return;
    }
    update({ sessionUpdate: "tool_call", toolCallId: "fake-tool-1", title: "Run fake tool", kind: "execute", status: "completed" });
  }
  if (activePrompt?.cancelled) {
    respond(id, { stopReason: "cancelled" });
    activePrompt = undefined;
    return;
  }
  if (text.includes("FAKE_PROGRESS")) {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about the request\n" } });
    update({ sessionUpdate: "plan", entries: [{ content: "Inspect the workspace", priority: "high", status: "in_progress" }] });
    update({ sessionUpdate: "tool_call", toolCallId: "fake-progress-tool", title: "Read files", kind: "read", status: "in_progress" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "fake-progress-tool", title: "Read files", kind: "read", status: "completed", content: [{ type: "content", content: { type: "text", text: "package.json" } }] });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "progressive answer" } });
  }
  if (text.includes("FAKE_SLOW_STREAM")) {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "slow thinking\n" } });
    await sleep(80);
    update({ sessionUpdate: "tool_call", toolCallId: "fake-slow-tool", title: "Read more files", kind: "read", status: "in_progress" });
    await sleep(80);
    update({ sessionUpdate: "tool_call_update", toolCallId: "fake-slow-tool", title: "Read more files", kind: "read", status: "completed" });
    await sleep(80);
  }
  if (text.includes("FAKE_PAUSE_STREAM")) {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "paused thinking\n" } });
    await sleep(250);
  }
  if (text.includes("remember FAKE_MEMORY")) {
    remembered = "FAKE_MEMORY";
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ remembered }));
  }
  let response = "FAKE_OK\n";
  if (text.includes("what did you remember")) response = `${remembered || "NOT_REMEMBERED"}\n`;
  if (text.includes("FAKE_STREAM")) response = "FAKE_STREAM_OK\n";
  if (text.includes("FAKE_SLOW_STREAM")) response = "FAKE_SLOW_STREAM_OK\n";
  if (text.includes("[image]")) response = "IMAGE_OK\n";
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: response.slice(0, -1) } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n" } });
  if (text.includes("FAKE_FALLBACK_AVAILABLE")) update({ sessionUpdate: "config_option_update", configOptions: [{ id: "model", category: "model", type: "select", name: "Model", currentValue: "gemini-3.8-flash-low", options: [
    { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }, { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  ] }] });
  if (!process.env.FAKE_ACP_NO_USAGE) update({ sessionUpdate: "usage_update", used: 12, size: 1000 });
  if (text.includes("FAKE_CATALOG_UPDATE")) {
    update({ sessionUpdate: "config_option_update", configOptions: [{
      id: "model", category: "model", type: "select", name: "Model", currentValue: "new-server-model",
      options: [{ value: "new-server-model", name: "Server-added model" }],
    }] });
  }
  respond(id, { stopReason: text.includes("FAKE_REFUSAL") ? "refusal" : text.includes("FAKE_MAX_TOKENS") ? "max_tokens" : text.includes("FAKE_MAX_TURNS") ? "max_turn_requests" : "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, thoughtTokens: 0 } });
  activePrompt = undefined;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(1); }
  if (message?.id !== undefined && message?.result !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
    return;
  }
  if (message?.method === "initialize") {
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: process.env.FAKE_ACP_LOAD_MODE !== "unsupported", promptCapabilities: { image: true, audio: true, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {} }, auth: { logout: {} } },
      authMethods: [{ id: "oauth-personal", name: "Fake Google" }],
      agentInfo: { name: "fake-antigravity-acp", title: "Fake ACP", version: "test" },
    });
  } else if (message?.method === "authenticate") {
    respond(message.id, {});
  } else if (message?.method === "session/new") {
    mcpServers = message.params.mcpServers;
    if (!Array.isArray(message.params?.mcpServers)) {
      fail(message.id, -32602, "mcpServers is required");
      return;
    }
    // Distinct sessions must not alias one private trajectory across unrelated
    // host owners. session/load below still preserves its requested identity.
    sessionId = `fake-acp-session-${randomUUID()}`;
    respond(message.id, {
      sessionId,
      configOptions: [
        { id: "model", category: "model", name: "Model", type: "select", currentValue: "gemini-3.8-flash-high", options: [
          { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
          { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
          { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
          { value: "fake-model-low", name: "Fake Model" },
          ...(process.env.FAKE_ACP_EXTRA_MODEL ? [{ value: process.env.FAKE_ACP_EXTRA_MODEL, name: process.env.FAKE_ACP_EXTRA_MODEL }] : []),
        ] },
        { id: "mode", name: "Mode", type: "select", currentValue: "code", options: [{ value: "code", name: "Code" }, { value: "plan", name: "Plan" }, { value: "default", name: "Default" }] },
      ],
    });
  } else if (message?.method === "session/load") {
    if (process.env.FAKE_ACP_LOAD_MODE === "missing") { remembered = ""; fail(message.id, -32000, "Session not found"); return; }
    if (process.env.FAKE_ACP_LOAD_MODE === "not-resumable") { remembered = ""; fail(message.id, -32000, "Session is not resumable"); return; }
    if (process.env.FAKE_ACP_LOAD_MODE === "method-unsupported") { fail(message.id, -32601, "Method not found"); return; }
    if (process.env.FAKE_ACP_LOAD_MODE === "auth") { fail(message.id, -32000, "Cannot load session: authentication required"); return; }
    if (process.env.FAKE_ACP_LOAD_MODE === "rejected") { fail(message.id, -32000, "Cannot load session: permission denied"); return; }
    mcpServers = message.params.mcpServers;
    sessionId = String(message.params?.sessionId ?? sessionId);
    respond(message.id, { configOptions: [] });
  } else if (message?.method === "session/set_config_option") {
    respond(message.id, { configOptions: [] });
  } else if (message?.method === "session/prompt") {
    void handlePrompt(message);
  } else if (message?.method === "session/cancel") {
    if (activePrompt) {
      activePrompt.cancelled = true;
      if (activePrompt.id && !String(activePrompt.id).startsWith("permission")) {
        respond(activePrompt.id, { stopReason: "cancelled" });
        activePrompt = undefined;
      }
    }
  }
});

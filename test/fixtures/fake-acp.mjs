#!/usr/bin/env node

import readline from "node:readline";
import fs from "node:fs";

let nextRequestId = 100;
let sessionId = "fake-acp-session-1";
const stateFile = process.env.FAKE_ACP_STATE_FILE;
let remembered = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")).remembered ?? "" : "";
let activePrompt;
const pending = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
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
  if (process.env.FAKE_ACP_PROMPT_LOG) fs.appendFileSync(process.env.FAKE_ACP_PROMPT_LOG, JSON.stringify({ text }) + "\n");
  activePrompt = { id, cancelled: false };
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
  update({ sessionUpdate: "usage_update", used: 12, size: 1000 });
  respond(id, { stopReason: text.includes("FAKE_MAX_TOKENS") ? "max_tokens" : text.includes("FAKE_MAX_TURNS") ? "max_turn_requests" : "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, thoughtTokens: 0 } });
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
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, sessionCapabilities: { list: {}, resume: {} }, auth: { logout: {} } },
      authMethods: [{ id: "oauth-personal", name: "Fake Google" }],
      agentInfo: { name: "fake-antigravity-acp", title: "Fake ACP", version: "test" },
    });
  } else if (message?.method === "authenticate") {
    respond(message.id, {});
  } else if (message?.method === "session/new") {
    if (!Array.isArray(message.params?.mcpServers)) {
      fail(message.id, -32602, "mcpServers is required");
      return;
    }
    sessionId = "fake-acp-session-1";
    respond(message.id, {
      sessionId,
      configOptions: [
        { id: "model", name: "Model", type: "select", currentValue: "gemini-3.8-flash-high", options: [{ value: "gemini-3.8-flash-high", name: "Fake Gemini" }, { value: "fake-model-low", name: "Fake Model" }] },
        { id: "mode", name: "Mode", type: "select", currentValue: "code", options: [{ value: "code", name: "Code" }, { value: "plan", name: "Plan" }, { value: "default", name: "Default" }] },
      ],
    });
  } else if (message?.method === "session/load") {
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

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncEventQueue } from "./acp-process.js";
import { AgyAbortError, AgyBusyError, AgyError } from "./errors.js";
import { sessionPool, type SessionSettings, type SessionTurnRequest } from "./session-pool.js";
import type { AcpEvent } from "./protocol.js";
import { extractTextContent, normalizePrompt, type HostMessage } from "./prompt.js";
import { envNumber } from "./constants.js";

export type HostTool = { name: string; description?: string; input_schema: Record<string, unknown> };
export type HostCall = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ToolResult = { content: Record<string, unknown>[]; isError: boolean };
type Pending = { call: HostCall; resolve: (result: ToolResult) => void; reject: (error: Error) => void; result?: ToolResult };
export type BridgeEvent = AcpEvent | { event: "host_tools"; calls: HostCall[] };
type Wake = AcpEvent | { event: "park" };

export function parseHostTools(value: unknown): HostTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AgyError("invalid_request", "tools must be an array");
  const names = new Set<string>();
  return value.map((tool) => {
    if (!tool || typeof tool.name !== "string" || !/^[\w.-]{1,128}$/.test(tool.name) || names.has(tool.name) ||
      !tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema)) {
      throw new AgyError("invalid_request", "Invalid or duplicate OpenCode tool definition");
    }
    names.add(tool.name);
    return { name: tool.name, description: typeof tool.description === "string" ? tool.description : tool.name, input_schema: tool.input_schema };
  });
}

function resultContent(value: unknown): Record<string, unknown>[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [{ type: "text", text: "" }];
  return value.map((part) => {
    if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part?.type === "image" && part.source?.type === "base64") return { type: "image", data: part.source.data, mimeType: part.source.media_type };
    throw new AgyError("unsupported", "Unsupported OpenCode tool-result content");
  });
}

/** Only the trailing result group belongs to the currently parked turn. */
export function hostResults(messages: unknown): Map<string, ToolResult> {
  const result = new Map<string, ToolResult>();
  if (!Array.isArray(messages)) return result;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant") break;
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
      if (result.has(part.tool_use_id)) throw new AgyError("invalid_request", "Duplicate tool result");
      result.set(part.tool_use_id, { content: resultContent(part.content), isError: part.is_error === true });
    }
  }
  return result;
}

export function hostInstructions(system: unknown, cwd: string): string {
  return [
    "<opencode-agent-instructions>",
    "OpenCode owns tool execution and permissions. Use only the opencode MCP tools advertised for this turn.",
    "The ACP working directory is private adapter storage. The actual task workspace is: " + cwd,
    "Follow the host's agent and project instructions below for the current task:",
    extractTextContent(system),
    "</opencode-agent-instructions>",
  ].join("\n");
}

const bridges = new Map<string, HostBridge>();
const tokens = new Map<string, HostBridge>();

export class HostBridge {
  readonly token = randomBytes(32).toString("hex");
  tools: HostTool[] = [];
  catalogID = "";
  private pending = new Map<string, Pending>();
  private reported = new Set<string>();
  private settled = new Set<string>();
  private queue = new AsyncEventQueue<Wake>();
  private controller = new AbortController();
  private pumping?: Promise<void>;
  private active = false;
  private consuming = false;
  private closed = false;
  private signature = "";
  private idle?: ReturnType<typeof setTimeout>;
  private instructions = "";
  private closing?: Promise<void>;

  constructor(readonly key: string, readonly sessionID: string | undefined, readonly cwd: string) { tokens.set(this.token, this); }
  get waiting(): boolean { return this.pending.size > 0; }

  async call(name: string, args: unknown): Promise<ToolResult> {
    if (!this.active || this.closed || !this.tools.some((tool) => tool.name === name)) throw new AgyError("unsupported", "Tool is unavailable in this OpenCode turn");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new AgyError("invalid_request", "Tool arguments must be an object");
    if (this.pending.size >= 128) throw new AgyBusyError("Too many pending OpenCode tool calls");
    const call: HostCall = { type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "")}`, name, input: args as Record<string, unknown> };
    const result = new Promise<ToolResult>((resolve, reject) => { this.pending.set(call.id, { call, resolve, reject }); });
    this.queue.push({ event: "park" });
    return result;
  }

  async *request(input: { messages: unknown; system?: unknown; tools?: unknown; settings: SessionSettings; baseURL: string; requestId?: string; signal?: AbortSignal }): AsyncGenerator<BridgeEvent> {
    if (this.closed) throw new AgyAbortError();
    if (this.consuming) throw new AgyBusyError("An OpenCode request is already consuming this turn");
    this.consuming = true;
    clearTimeout(this.idle);
    let parked = false;
    let finished = false;
    const abort = () => { void this.close(); };
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal?.aborted) throw new AgyAbortError();
      const results = hostResults(input.messages);
      const tools = parseHostTools(input.tools);
      const signature = JSON.stringify({ tools, model: input.settings.model, effort: input.settings.effort });
      if (this.active) {
        if (signature !== this.signature) throw new AgyError("invalid_request", "Tool catalog or model changed while a tool call was pending; cancel this turn first", { status: 409 });
        // Validate the whole group before releasing any MCP handler.
        for (const id of results.keys()) if (!this.reported.has(id) && !this.settled.has(id)) throw new AgyError("invalid_request", "Tool result does not belong to this session's pending calls", { status: 409 });
        for (const [id, result] of results) { const pending = this.pending.get(id); if (pending) pending.result = result; }
        if (this.reported.size && [...this.reported].every((id) => this.pending.get(id)?.result)) {
          const nextInstructions = hostInstructions(input.system, this.cwd);
          // Preserve instruction changes and user steering without starting a second ACP prompt.
          const trailing: HostMessage[] = [];
          if (Array.isArray(input.messages)) for (let i = input.messages.length - 1; i >= 0; i--) {
            if (input.messages[i]?.role === "assistant") break;
            trailing.unshift(input.messages[i]);
          }
          const steering = trailing.flatMap((m) => m.role !== "user" ? [] : typeof m.content === "string" ? [m.content] :
            Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === "text").map((p: any) => p.text) : []);
          const append = [nextInstructions !== this.instructions ? nextInstructions : "", ...steering].filter(Boolean).join("\n");
          const last = [...this.reported].at(-1);
          for (const id of this.reported) {
            const pending = this.pending.get(id)!;
            const result = pending.result!;
            if (id === last && append) result.content.push({ type: "text", text: append });
            this.pending.delete(id); this.settled.add(id); pending.resolve(result);
          }
          this.reported.clear(); this.instructions = nextInstructions;
        }
      } else {
        if (results.size) throw new AgyError("invalid_request", "The ACP turn for these tool results is no longer active. Send a new user message.", { status: 409 });
        const normalized = await normalizePrompt(input.messages, { allowedRoots: [this.cwd], hostTools: true });
        this.tools = tools; this.signature = signature;
        this.queue = new AsyncEventQueue<Wake>(); this.controller = new AbortController();
        this.settled.clear(); this.reported.clear(); this.active = true;
        this.instructions = hostInstructions(input.system, this.cwd);
        const schema = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
        this.catalogID = schema;
        const settings: SessionSettings = { ...input.settings, hostTools: true,
          mcpServers: tools.length ? [{ type: "http", name: "opencode", url: `${input.baseURL}/mcp/${this.token}/${schema}`, headers: [] }] : [],
          waitingForTools: () => this.waiting };
        const turn: SessionTurnRequest = { key: this.key, requestId: input.requestId, prompt: normalized.blocks,
          priorMessages: normalized.priorMessages.filter((m) => m.role !== "system"), instructions: this.instructions, settings, signal: this.controller.signal };
        this.pumping = (async () => {
          try {
            for await (const event of sessionPool.turn(turn)) this.queue.push(event);
            this.queue.close();
          } catch (error) { this.queue.close(error); }
        })();
      }
      if (this.reported.size) {
        parked = true;
        yield { event: "host_tools", calls: [...this.reported].map((id) => this.pending.get(id)!.call) };
        return;
      }
      while (true) {
        const next = await this.queue.next({ signal: this.controller.signal });
        if (next.done) throw new AgyError("process", "ACP turn ended without a terminal result");
        if (next.value.event === "park") {
          if (!this.pending.size) continue;
          // Short coalescing window; late arrivals are delivered on the next host step.
          await new Promise((resolve) => setTimeout(resolve, 25));
          this.reported = new Set(this.pending.keys());
          parked = true;
          yield { event: "host_tools", calls: [...this.pending.values()].map((p) => p.call) };
          return;
        }
        // ACP already processed these updates for activity/lifecycle tracking.
        // OpenCode renders the actual call and result through the MCP bridge;
        // replaying ACP tool telemetry as thinking would duplicate that UI.
        if (next.value.event === "update" &&
            (next.value.update.sessionUpdate === "tool_call" || next.value.update.sessionUpdate === "tool_call_update")) continue;
        yield next.value;
        if (next.value.event === "result") { finished = true; this.active = false; await this.pumping; return; }
      }
    } finally {
      this.consuming = false;
      input.signal?.removeEventListener("abort", abort);
      if (!parked && !finished) await this.close();
      else this.idle = setTimeout(() => { void this.close(); }, envNumber("OPENCODE_ANTIGRAVITY_HOST_IDLE_MS", 2 * 60 * 60_000, 1000));
      this.idle?.unref?.();
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.active = false; clearTimeout(this.idle);
    tokens.delete(this.token); if (bridges.get(this.key) === this) bridges.delete(this.key);
    this.controller.abort();
    // Interrupt ACP before rejecting MCP results, so rejection cannot start another model step.
    return this.closing = (async () => {
      await this.pumping;
      for (const pending of this.pending.values()) pending.reject(new AgyAbortError());
      this.pending.clear(); this.queue.close(new AgyAbortError());
      await sessionPool.forgetWorker(this.key);
    })();
  }
}

export function hostBridge(key: string, sessionID: string | undefined, cwd: string): HostBridge {
  let bridge = bridges.get(key);
  if (!bridge) {
    if (bridges.size >= 128) throw new AgyBusyError("Too many active OpenCode tool bridges");
    bridge = new HostBridge(key, sessionID, cwd); bridges.set(key, bridge);
  }
  return bridge;
}

export async function closeHostBridges(sessionID?: string): Promise<void> {
  await Promise.all([...bridges.values()].filter((b) => !sessionID || b.sessionID === sessionID).map((b) => b.close()));
}

/** Stateless Streamable HTTP MCP. Each unguessable endpoint belongs to one host
 * session; schemas and results never cross session boundaries. */
export async function handleHostMcp(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.split("/");
  const token = path[2];
  const bridge = tokens.get(token);
  if (!bridge || path[3] !== bridge.catalogID || request.headers.has("origin")) return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: request.method === "DELETE" ? 204 : 405 });
  const max = 8 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > max) return new Response(null, { status: 413 });
  let id: unknown = null;
  try {
    // Request bodies are bounded even when the peer uses chunked encoding.
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) try {
      while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
        if (bytes > max) throw new Error("MCP request too large"); chunks.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")); id = rpc.id ?? null;
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") throw new Error("Invalid JSON-RPC request");
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: ["2025-06-18", "2025-03-26", "2024-11-05"].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "opencode", version: "1" } };
    else if (rpc.method === "ping") result = {};
    else if (rpc.method === "tools/list") result = { tools: bridge.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) };
    else if (rpc.method === "tools/call") result = await bridge.call(rpc.params?.name, rpc.params?.arguments ?? {});
    else return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    return Response.json({ jsonrpc: "2.0", id, result });
  } catch (error) { return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "MCP request failed" } }); }
}

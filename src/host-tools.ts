import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AsyncEventQueue } from "./acp-process.js";
import { AgyAbortError, AgyBusyError, AgyError } from "./errors.js";
import { sessionPool, type SessionSettings, type SessionTurnRequest } from "./session-pool.js";
import type { AcpEvent } from "./protocol.js";
import { extractTextContent, messageContentToAcp, normalizePrompt, type HostMessage } from "./prompt.js";
import { envNumber } from "./constants.js";
import { sessionStore } from "./session-store.js";
import { canonical } from "./coordinator.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { MAX_MEDIA_BYTES, validateMediaBlocks } from "./attachments.js";
import { blockBudget } from "./budget.js";

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
  const content = value.map((part) => {
    if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part?.type === "image" && part.source?.type === "base64" && typeof part.source.data === "string" && typeof part.source.media_type === "string" && part.source.media_type.startsWith("image/")) return { type: "image", data: part.source.data, mimeType: part.source.media_type };
    throw new AgyError("unsupported", "Unsupported OpenCode tool-result content");
  });
  validateMediaBlocks(content as ContentBlock[], Number.POSITIVE_INFINITY);
  return content;
}

function promotedImages(content: unknown): Map<any, string> {
  const images = new Map<any, string>();
  if (!Array.isArray(content)) return images;
  const results = content.filter(p => p?.type === "tool_result" && typeof p.tool_use_id === "string");
  let preceding: string | undefined;
  for (const part of content) {
    if (part?.type === "tool_result") { preceding = part.tool_use_id; continue; }
    if (part?.type !== "image") { preceding = undefined; continue; }
    const explicit = part.tool_use_id;
    const id = typeof explicit === "string" && results.some(p => p.tool_use_id === explicit) ? explicit : results.length === 1 ? preceding : undefined;
    if (id) images.set(part, id);
  }
  return images;
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
    for (const [image, id] of promotedImages(message.content)) result.get(id)?.content.push(...resultContent([image]));
  }
  // Aggregate admission belongs to the actual delivery, including pending
  // results and steering, not historical result inspection/recovery.
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

// Reloaded modules must keep live MCP waiters and endpoint tokens together.
const owner = globalThis as typeof globalThis & { __agyBridgeV1?: { bridges: Map<string, HostBridge>; tokens: Map<string, HostBridge>; mcpRequests?: Map<string, () => void>; localDeliveries?: WeakMap<object, { key: string; id: string }> } };
const bridgeRuntime = owner.__agyBridgeV1 ??= { bridges: new Map<string, HostBridge>(), tokens: new Map<string, HostBridge>(), mcpRequests: new Map<string, () => void>() };
const { bridges, tokens } = bridgeRuntime;
const mcpRequests = bridgeRuntime.mcpRequests ??= new Map<string, () => void>();
const localDeliveries = bridgeRuntime.localDeliveries ??= new WeakMap<object, { key: string; id: string }>();
async function locallyHandedOff(result: unknown): Promise<void> {
  const identity = result && typeof result === "object" ? localDeliveries.get(result) : undefined;
  if (identity) await sessionStore.toolDelivery(identity.key, identity.id, "locally-handed-off");
}

/** MCP progress is opt-in via progressToken and a negotiated SSE response.
 * A waiting notification reports zero completed work; comments are transport
 * keepalive, never fabricated increasing work progress or successful results. */
export function mcpProgressResponse(id: unknown, progressToken: string | number, result: Promise<unknown>, cancel: () => void, intervalMs = 15_000): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: 0, message: "Waiting for OpenCode tool execution" } });
      timer = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n")); }, intervalMs);
      timer.unref?.();
      const finish = (payload: unknown) => { clearInterval(timer); if (closed) return false; send(payload); controller.close(); closed = true; return true; };
      void result.then(async value => { if (finish({ jsonrpc: "2.0", id, result: value })) await locallyHandedOff(value); }, error => finish({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "MCP request failed" } })).catch(() => { /* Durable intent remains; no remote acknowledgement is inferred. */ });
    },
    cancel() { closed = true; clearInterval(timer); cancel(); },
  }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

export async function readMcpBody(request: Request, max = 8 * 1024 * 1024, deadlineMs = 15_000): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(new AgyError("timeout", "MCP body read deadline exceeded")); void reader.cancel().catch(() => {});
  }, deadlineMs); });
  try {
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) throw new AgyError("invalid_request", "MCP request too large");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

function profile(tools: HostTool[], settings: SessionSettings): string {
  return canonical({ tools: tools.map(({ name, input_schema }) => ({ name, input_schema })).sort((a, b) => a.name.localeCompare(b.name)), model: settings.model, effort: settings.effort });
}

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
  private turn?: SessionTurnRequest;
  private callCount = 0;

  constructor(readonly key: string, readonly sessionID: string | undefined, readonly cwd: string) { tokens.set(this.token, this); }
  get waiting(): boolean { return this.pending.size > 0; }
  get evictable(): boolean { return !this.active && !this.consuming && !this.waiting; }

  async call(name: string, args: unknown): Promise<ToolResult> {
    if (!this.active || this.closed || !this.tools.some((tool) => tool.name === name)) throw new AgyError("unsupported", "Tool is unavailable in this OpenCode turn");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new AgyError("invalid_request", "Tool arguments must be an object");
    if (this.pending.size >= 128) throw new AgyBusyError("Too many pending OpenCode tool calls");
    const call: HostCall = { type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "")}`, name, input: args as Record<string, unknown> };
    const record = await sessionStore.get(this.key);
    await sessionStore.saveToolCall(this.key, call.id, { call, hostSessionID: this.sessionID, argumentsDigest: createHash("sha256").update(canonical(args)).digest("hex"), epoch: record?.conversation?.epoch, requestId: this.turn?.identity?.value ?? this.turn?.requestId, profile: this.signature, emitted: true });
    if (this.closed) throw new AgyAbortError();
    this.callCount++;
    const requestID = this.turn?.identity?.value ?? this.turn?.requestId;
    if (requestID) await sessionStore.saveReceipt(this.key, requestID, { state: "parked" });
    if (this.closed) throw new AgyAbortError();
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
      // The ID alone is not authority to replace the originating arguments.
      for (const id of results.keys()) {
        const saved = await sessionStore.toolCall(this.key, id);
        if (!saved) throw new AgyError("invalid_request", "Tool result has no originating call in this conversation");
        const calls = Array.isArray(input.messages) ? input.messages.flatMap(m => m?.role === "assistant" && Array.isArray(m.content) ? m.content : []) : [];
        const call = calls.find(p => p?.type === "tool_use" && p.id === id);
        if (call && canonical(saved.call) !== canonical(call)) throw new AgyError("invalid_request", "Tool call conflicts with its originating record");
      }
      const tools = parseHostTools(input.tools);
      const signature = profile(tools, input.settings);
      if (this.active) {
        // Only this batch is operative. Admit its accumulated partial results
        // before persistence, not unrelated historical/settled result groups.
        validateMediaBlocks([...this.reported].flatMap(id => (results.get(id) ?? this.pending.get(id)?.result)?.content ?? []) as ContentBlock[]);
      }
      if (this.active && signature !== this.signature) {
        // Accept under the originating profile before retiring its waiter. The
        // replacement prompt imports host calls/results; it never reissues them.
        for (const id of results.keys()) if (!this.reported.has(id) && !this.settled.has(id)) throw new AgyError("invalid_request", "Tool result does not belong to this session's pending calls");
        for (const [id, result] of results) await sessionStore.saveToolResult(this.key, id, result);
        if ([...this.reported].every(id => results.has(id) || this.pending.get(id)?.result)) {
          await this.close();
          yield* hostBridge(this.key, this.sessionID, this.cwd).request(input);
          finished = true;
          return;
        }
      }
      if (this.active) {
        // Validate the whole group before releasing any MCP handler.
        for (const id of results.keys()) if (!this.reported.has(id) && !this.settled.has(id)) throw new AgyError("invalid_request", "Tool result does not belong to this session's pending calls");
        for (const [id, result] of results) await sessionStore.saveToolResult(this.key, id, result);
        for (const [id, result] of results) { const pending = this.pending.get(id); if (pending) pending.result = result; }
        if (this.turn?.messages && Array.isArray(input.messages)) this.turn.messages.splice(0, this.turn.messages.length, ...input.messages);
        if (this.turn?.responseCursor) this.turn.responseCursor.start = this.turn.responseCursor.events;
        if (this.reported.size && [...this.reported].every((id) => this.pending.get(id)?.result)) {
          const nextInstructions = hostInstructions(input.system, this.cwd);
          // Preserve instruction changes and user steering without starting a second ACP prompt.
          const trailing: HostMessage[] = [];
          if (Array.isArray(input.messages)) for (let i = input.messages.length - 1; i >= 0; i--) {
            if (input.messages[i]?.role === "assistant") break;
            trailing.unshift(input.messages[i]);
          }
          // Include results accepted on earlier partial continuations as well
          // as this request; parallel deliveries share one aggregate allowance.
          const deliveryContent = [...this.reported].flatMap(id => this.pending.get(id)!.result!.content) as ContentBlock[];
          const steeringBudget = { remaining: MAX_MEDIA_BYTES - validateMediaBlocks(deliveryContent), signal: input.signal };
          const steering: ContentBlock[] = [];
          for (const m of trailing.filter(m => m.role === "user")) {
            const promoted = promotedImages(m.content);
            steering.push(...await messageContentToAcp(Array.isArray(m.content) ? m.content.filter((p: any) => p?.type !== "tool_result" && !promoted.has(p)) : m.content, [this.cwd], steeringBudget));
          }
          const append = nextInstructions !== this.instructions ? nextInstructions : "";
          const delivery = [...deliveryContent, ...steering, ...(append ? [{ type: "text" as const, text: append }] : [])];
          validateMediaBlocks(delivery);
          blockBudget(input.settings.model, delivery, input.settings.outputBudget);
          const last = [...this.reported].at(-1);
          const requestID = this.turn?.identity?.value ?? this.turn?.requestId;
          if (requestID) await sessionStore.saveReceipt(this.key, requestID, { state: "running" });
          for (const id of this.reported) {
            const pending = this.pending.get(id)!;
            const result = structuredClone(pending.result!);
            if (id === last && append) result.content.push({ type: "text", text: append });
            if (id === last) result.content.push(...steering as Record<string, unknown>[]);
            await sessionStore.toolDelivery(this.key, id, "delivery-attempted");
            localDeliveries.set(result, { key: this.key, id });
            this.pending.delete(id); this.settled.add(id); pending.resolve(result);
          }
          this.reported.clear(); this.instructions = nextInstructions;
        }
      } else {
        for (const [id, result] of results) {
          if (!(await sessionStore.toolCall(this.key, id))) throw new AgyError("invalid_request", "Tool result has no originating call in this conversation");
          await sessionStore.saveToolResult(this.key, id, result);
        }
        // A dead MCP transport cannot be resumed. Recover its last host batch
        // from private receipts and host results. Missing results do not prove
        // missing execution: never expose those calls again after transport loss.
        const messages = structuredClone(input.messages) as HostMessage[];
        if (Array.isArray(messages)) {
          // Tool success (including a tool named StructuredOutput) is not
          // turn completion. Preserve originating calls and deliver their
          // actual results through the same reconciliation path as every tool.
          const assistant = [...messages].reverse().find(m => m.role === "assistant");
          const calls = messages.flatMap(message => message.role === "assistant" && Array.isArray(message.content) ? message.content.filter((p: any) => p?.type === "tool_use") as HostCall[] : []);
          const seen = new Set<string>();
          const missing: HostCall[] = [];
          const restored: Record<string, unknown>[] = [];
          for (const call of calls) {
            const saved = await sessionStore.toolCall(this.key, call.id);
            if (!saved) {
              // Earlier history may belong to another provider, but the current
              // continuation must have an originating adapter call record.
              if (Array.isArray(assistant?.content) && assistant.content.includes(call)) throw new AgyError("invalid_request", "Tool call has no originating record in this conversation");
              continue;
            }
            if (canonical(saved.call) !== canonical(call)) throw new AgyError("invalid_request", "Tool call conflicts with its originating record");
            if (seen.has(call.id)) continue;
            seen.add(call.id);
            // Host context may already contain a result outside the trailing
            // continuation group. Reconcile that evidence before declaring the
            // original execution uncertain; do not ask the host to execute it.
            let hasHostResult = false;
            for (const message of messages) {
              if (message.role !== "user" || !Array.isArray(message.content)) continue;
              const result = hostResults([message]).get(call.id);
              if (!result) continue;
              hasHostResult = true;
              await sessionStore.saveToolResult(this.key, call.id, result);
            }
            const reconciled = await sessionStore.toolCall(this.key, call.id);
            if (!reconciled?.result) missing.push(call);
            else if (!hasHostResult) {
              const result = reconciled.result as ToolResult;
              restored.push({ type: "tool_result", tool_use_id: call.id, is_error: result.isError, content: result.content.map(p => p.type === "image" ? { type: "image", source: { type: "base64", data: p.data, media_type: p.mimeType } } : p) });
            }
          }
          if (missing.length) throw new AgyError("invalid_request", "Previously exposed tool calls have no recorded result. Their execution is uncertain; reconcile the original host results before continuing. They cannot be executed again automatically.", { code: "agy_tool_execution_uncertain", retryable: false });
          if (restored.length) messages.push({ role: "user", content: restored });
        }
        const normalized = await normalizePrompt(messages, { allowedRoots: [this.cwd], hostTools: true, signal: input.signal });
        this.tools = tools; this.signature = signature;
        this.queue = new AsyncEventQueue<Wake>(); this.controller = new AbortController();
        this.settled.clear(); this.reported.clear(); this.active = true;
        this.callCount = 0;
        this.instructions = hostInstructions(input.system, this.cwd);
        const schema = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
        this.catalogID = schema;
        const settings: SessionSettings = { ...input.settings, hostTools: true,
          mcpServers: tools.length ? [{ type: "http", name: "opencode", url: `${input.baseURL}/mcp/${this.token}/${schema}`, headers: [] }] : [],
          waitingForTools: () => this.waiting, hasToolActivity: () => this.callCount > 0 };
        const turn: SessionTurnRequest = { key: this.key, requestId: input.requestId, prompt: normalized.blocks,
          messages: normalized.messages, hostSessionID: this.sessionID,
          responseCursor: { start: 0, events: 0 },
          identity: {},
          suppressToolTelemetry: true,
          priorMessages: normalized.priorMessages.filter((m) => m.role !== "system"), instructions: this.instructions, settings, signal: this.controller.signal };
        this.turn = turn;
        this.pumping = (async () => {
          try {
            for await (const event of sessionPool.turn(turn)) this.queue.push(event);
            this.queue.close();
          } catch (error) { this.queue.close(error); }
        })();
      }
      if (this.reported.size) {
        parked = true;
        // The original host batch is already exposed. Even a live MCP waiter
        // cannot prove its missing result means the host has not executed it.
        throw new AgyError("invalid_request", "The original host tool batch still has pending results. Deliver those results before continuing; previously exposed calls cannot be executed again automatically.", { code: "agy_tool_results_pending", retryable: false });
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
          yield { event: "host_tools", calls: [...this.pending.values()].filter(p => !p.result).map((p) => p.call) };
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
      else if (!this.closed) this.idle = setTimeout(() => { void this.close(); }, envNumber("OPENCODE_ANTIGRAVITY_HOST_IDLE_MS", 2 * 60 * 60_000, 1000));
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
      for (const pending of this.pending.values()) pending.reject(new AgyAbortError());
      this.pending.clear(); this.queue.close(new AgyAbortError());
      await this.pumping;
      await sessionPool.forgetWorker(this.key);
    })();
  }
}

export function hostBridge(key: string, sessionID: string | undefined, cwd: string): HostBridge {
  let bridge = bridges.get(key);
  if (!bridge) {
    const capacity = sessionPool.capacity;
    if (bridges.size >= capacity) {
      const idle = [...bridges.values()].find(value => value.evictable);
      // close removes endpoint ownership synchronously before joining its pump.
      if (idle) void idle.close();
    }
    if (bridges.size >= capacity) throw new AgyBusyError("Too many active OpenCode tool bridges");
    bridge = new HostBridge(key, sessionID, cwd); bridges.set(key, bridge);
  }
  return bridge;
}

export async function closeHostBridges(sessionID?: string): Promise<void> {
  await Promise.all([...bridges.values()].filter((b) => !sessionID || b.sessionID === sessionID).map((b) => b.close()));
}
export async function closeHostBridgesForScope(scope: string): Promise<void> {
  await Promise.all([...bridges.values()].filter(bridge => bridge.key.startsWith(`host-v1:${scope}:`)).map(bridge => bridge.close()));
}

export async function recordHostToolSuccess(sessionID: string, callID: string, eventID: string): Promise<void> {
  const keys = new Set((await sessionStore.entries()).filter(([, r]) => r.conversation?.hostSessionID === sessionID).map(([key]) => key));
  for (const bridge of bridges.values()) if (bridge.sessionID === sessionID) keys.add(bridge.key);
  for (const key of keys) {
    // Retain the existing call-correlated receipt for durable compatibility.
    // Its legacy terminalAcceptance name conveys no turn-completion authority.
    // Never abort a pump or release a waiter on a tool-success event.
    await sessionStore.acceptTerminalCall(key, sessionID, callID, eventID);
  }
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
    const rpc = JSON.parse(await readMcpBody(request, max)); id = rpc.id ?? null;
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") throw new Error("Invalid JSON-RPC request");
    if (rpc.id === undefined) {
      if (rpc.method === "notifications/cancelled") mcpRequests.get(`${token}:${JSON.stringify(rpc.params?.requestId)}`)?.();
      return new Response(null, { status: 202 });
    }
    let result: unknown;
    if (rpc.method === "initialize") result = { protocolVersion: ["2025-06-18", "2025-03-26", "2024-11-05"].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "opencode", version: "1" } };
    else if (rpc.method === "ping") result = {};
    else if (rpc.method === "tools/list") result = { tools: bridge.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) };
    else if (rpc.method === "tools/call") {
      const key = `${token}:${JSON.stringify(id)}`;
      if (mcpRequests.has(key)) throw new AgyError("invalid_request", "Duplicate in-flight MCP request ID");
      let rejectCancel!: (error: Error) => void;
      const cancelled = new Promise<never>((_, reject) => { rejectCancel = reject; });
      mcpRequests.set(key, () => { rejectCancel(new AgyAbortError()); void bridge.close(); });
      const running = Promise.race([bridge.call(rpc.params?.name, rpc.params?.arguments ?? {}), cancelled]).finally(() => { mcpRequests.delete(key); });
      const progressToken = rpc.params?._meta?.progressToken;
      const acceptsSse = request.headers.get("accept")?.split(",").some(value => value.trim().split(";")[0] === "text/event-stream" && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(value));
      if ((typeof progressToken === "string" || typeof progressToken === "number") && acceptsSse) return mcpProgressResponse(id, progressToken, running, () => mcpRequests.get(key)?.());
      result = await running;
    }
    else return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    const response = Response.json({ jsonrpc: "2.0", id, result });
    await locallyHandedOff(result);
    return response;
  } catch (error) { return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : "MCP request failed" } }); }
}

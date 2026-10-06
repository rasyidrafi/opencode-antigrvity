import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve as resolvePath, sep } from "node:path";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_REQUEST_READ_TIMEOUT_MS,
  DEFAULT_SSE_HEARTBEAT_MS,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MODEL_HEADER,
  MESSAGE_HEADER,
  REQUEST_KIND_HEADER,
  REQUEST_TOKEN_HEADER,
  SESSION_HEADER,
  envNumber,
} from "./constants.js";
import { AgyError, AgyProtocolError, asAgyError, retryAfterSeconds } from "./errors.js";
import { error as logError, info, warn } from "./log.js";
import { fallbackAcpModelCatalog, resolveAcpModelSelection, type AcpModelCatalog } from "./models.js";
import { ModelCatalog } from "./model-catalog.js";
import { normalizePrompt } from "./prompt.js";
import { detectMetaRequestKind } from "./request-kind.js";
import { buildGenerateUtilityPrompt, buildUtilityPrompt, runAcpOneShot, runSummary, type OneShotResult } from "./utility.js";
import { sessionStore } from "./session-store.js";
import { readContextSnapshot } from "./telemetry.js";
import { sessionPool } from "./session-pool.js";
import type { AcpEvent } from "./protocol.js";
import { hostBridge, handleHostMcp, closeHostBridges, closeHostBridgesForScope, hostInstructions, type BridgeEvent } from "./host-tools.js";
import {
  appendResultWithoutDuplication,
  collectTurn,
  hostVisibleContent,
  createAcpTranslationState,
  isMeaningfulEvent,
  mapAcpEvent,
  replay,
  type AnthropicUsage,
} from "./translate.js";

export type AnthropicMessageRequest = {
  model?: unknown;
  messages?: unknown;
  system?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  stop_sequences?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

type RuntimeState = {
  directory: string;
  catalog: AcpModelCatalog;
  manager: ModelCatalog;
};

type ProbeResult = { replay: AsyncIterable<BridgeEvent> } | { error: AgyError };

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

let server: ReturnType<typeof Bun.serve> | null = null;
let proxyPort: number | null = null;
let runtime: RuntimeState | null = null;
let startPromise: Promise<number> | null = null;
let warnedTemperature = false;
const workspaceRoots = new Set<string>();
const catalogListeners = new Set<() => void>();

function localModelCatalogChange(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}

function requestedPort(): number {
  const value = Number(process.env.OPENCODE_ANTIGRAVITY_PROXY_PORT);
  return Number.isInteger(value) && value >= 0 && value < 65_536 ? value : 0;
}

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value ? value : undefined;
}

function sessionKey(request: Request, messages: unknown, cwd: string): string {
  const header = readHeader(request, SESSION_HEADER);
  const seed = header ? `workspace:${cwd}:session:${header}` : `workspace:${cwd}:request:${JSON.stringify(messages)}`;
  return createHash("sha256").update(seed).digest("hex");
}

async function workspaceContains(root: string, candidate: string): Promise<boolean> {
  const [realRoot, realCandidate] = await Promise.all([
    realpath(root).catch(() => resolvePath(root)),
    realpath(candidate).catch(() => resolvePath(candidate)),
  ]);
  const relativePath = relative(realRoot, realCandidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

async function registeredWorkspaceContains(candidate: string): Promise<boolean> {
  const checks = await Promise.all([...workspaceRoots].map((root) => workspaceContains(root, candidate)));
  return checks.some(Boolean);
}

function localAuthorizationIsValid(request: Request): boolean {
  const bearer = request.headers.get("authorization")?.trim();
  const apiKey = request.headers.get("x-api-key")?.trim();
  const token = readHeader(request, REQUEST_TOKEN_HEADER);
  return bearer === `Bearer ${LOCAL_API_KEY}` || apiKey === LOCAL_API_KEY || token === LOCAL_API_KEY;
}

async function readJson(request: Request): Promise<AnthropicMessageRequest> {
  const max = envNumber("OPENCODE_ANTIGRAVITY_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES, 1_024);
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > max) throw new AgyError("invalid_request", "The request body is too large", { code: "agy_request_too_large", status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    const deadline = Date.now() + envNumber("OPENCODE_ANTIGRAVITY_REQUEST_READ_TIMEOUT_MS", DEFAULT_REQUEST_READ_TIMEOUT_MS, 1_000);
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AgyError("timeout", "Timed out while reading the request body", { code: "agy_request_read_timeout" });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const next = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new AgyError("timeout", "Timed out while reading the request body", { code: "agy_request_read_timeout" })), remaining);
              timer.unref?.();
            }),
          ]);
          if (next.done) break;
          total += next.value.byteLength;
          if (total > max) throw new AgyError("invalid_request", "The request body is too large", { code: "agy_request_too_large", status: 413 });
          chunks.push(next.value);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
    return parsed as AnthropicMessageRequest;
  } catch (error) {
    throw new AgyError("invalid_request", "The request body is not valid JSON", { code: "agy_invalid_json", cause: error });
  }
}

export function errorType(error: AgyError): string {
  if (error.kind === "context_overflow") return "context_length_exceeded";
  if (error.kind === "auth") return "authentication_error";
  if (error.kind === "quota") return "insufficient_quota";
  if (error.kind === "rate_limit") return "rate_limit_error";
  if (error.kind === "overload") return "overloaded_error";
  if (error.kind === "refusal") return "content_policy_violation";
  if (error.code === "agy_cancelled" || error.code === "agy_client_cancelled") return "invalid_request_error";
  if (error.kind === "invalid_request" || error.kind === "unsupported" || error.kind === "unknown_model") return "invalid_request_error";
  return "api_error";
}

function errorPayload(error: AgyError): { type: "error"; error: { type: string; message: string; code: string; retry_after?: number } } {
  const retryAfter = retryAfterSeconds(error);
  // The installed Anthropic stream decoder keeps only error.type/message.
  // Include the normalized hint in message as well as the HTTP/body fields.
  return { type: "error", error: { type: errorType(error), message: retryAfter === undefined ? error.message : `${error.message} (retry after ${retryAfter} seconds)`, code: error.code, ...(retryAfter !== undefined ? { retry_after: retryAfter } : {}) } };
}

function errorResponse(error: unknown): Response {
  const failure = asAgyError(error);
  const retryAfter = retryAfterSeconds(failure);
  return Response.json(errorPayload(failure), {
    status: failure.status,
    headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
  });
}

function completionId(): string { return `msg_${randomUUID().replace(/-/g, "")}`; }
function responseModel(bodyModel: unknown, selected: string): string { return typeof bodyModel === "string" && bodyModel ? bodyModel : selected; }
function ssePayload(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, payload: unknown): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function anthropicUsage(usage: AnthropicUsage | undefined): Record<string, unknown> {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    ...(usage?.output_tokens_details ? { output_tokens_details: usage.output_tokens_details } : {}),
  };
}

async function probeTurn(events: AsyncIterable<BridgeEvent>): Promise<ProbeResult> {
  const iterator = events[Symbol.asyncIterator]();
  const buffered: BridgeEvent[] = [];
  const resume = async function* () { try { yield* buffered; while (true) { const next = await iterator.next(); if (next.done) return; yield next.value; } } finally { await iterator.return?.(); } };
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      buffered.push(event);
      if (event.event === "host_tools") return { replay: resume() };
      if (event.event === "result") {
        const mapped = mapAcpEvent(event);
        if (mapped.kind === "error") { await iterator.return?.(); return { error: mapped.error }; }
        return { replay: resume() };
      }
      if (isMeaningfulEvent(event)) return { replay: resume() };
    }
  } catch (error) {
    await iterator.return?.();
    return { error: asAgyError(error, "The ACP agent ended before producing a response") };
  }
  return { error: new AgyProtocolError("The ACP agent ended without a response") };
}

function contentBlock(kind: "text" | "thinking", text = ""): Record<string, unknown> {
  return kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text };
}

function streamAnthropic(
  events: AsyncIterable<BridgeEvent>,
  model: string,
  signal?: AbortSignal,
): Response {
  const id = completionId();
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let iterator: AsyncIterator<BridgeEvent> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      iterator = events[Symbol.asyncIterator]();
      const send = (payload: unknown) => { if (!closed) ssePayload(controller, encoder, payload); };
      let nextBlockIndex = 0;
      let active: { index: number; kind: "text" | "thinking" } | undefined;
      let streamedText = "";
      let finishReason = "end_turn";
      let resultUsage: AnthropicUsage | undefined;
      let sawResult = false;
      const translation = createAcpTranslationState();
      const closeBlock = () => {
        if (!active) return;
        if (active.kind === "thinking") send({ type: "content_block_delta", index: active.index, delta: { type: "signature_delta", signature: `agy-${id}-${active.index}` } });
        send({ type: "content_block_stop", index: active.index });
        active = undefined;
      };
      const openBlock = (kind: "text" | "thinking") => {
        if (active?.kind === kind) return;
        closeBlock();
        active = { index: nextBlockIndex++, kind };
        send({ type: "content_block_start", index: active.index, content_block: contentBlock(kind) });
      };
      const emitBlock = (kind: "text" | "thinking", text: string, separate = false) => {
        if (!text) return;
        if (separate) closeBlock();
        openBlock(kind);
        send({ type: "content_block_delta", index: active!.index, delta: kind === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text } });
        if (separate) closeBlock();
      };
      heartbeat = setInterval(() => { if (!closed) send({ type: "ping" }); }, envNumber("OPENCODE_ANTIGRAVITY_SSE_HEARTBEAT_MS", DEFAULT_SSE_HEARTBEAT_MS, 1_000));
      heartbeat.unref?.();
      try {
        send({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: anthropicUsage(undefined) } });
        while (true) {
          if (signal?.aborted) throw new AgyError("timeout", "The client cancelled the ACP request", { status: 499, code: "agy_client_cancelled" });
          const next = await iterator!.next();
          if (next.done) break;
          if (next.value.event === "host_tools") {
            closeBlock();
            for (const call of next.value.calls) {
              const index = nextBlockIndex++;
              send({ type: "content_block_start", index, content_block: { ...call, input: {} } });
              send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
              send({ type: "content_block_stop", index });
            }
            finishReason = "tool_use";
            continue;
          }
          const mapped = mapAcpEvent(next.value, translation);
          if (mapped.kind === "text") { streamedText += mapped.text; emitBlock("text", mapped.text); }
          else if (mapped.kind === "reasoning") emitBlock("thinking", mapped.text);
          else if (mapped.kind === "activity") emitBlock("thinking", mapped.text, true);
          else if (mapped.kind === "result") {
            sawResult = true;
            resultUsage = mapped.usage;
            finishReason = mapped.finishReason;
            const suffix = appendResultWithoutDuplication(streamedText, mapped.response);
            if (suffix === undefined) throw new AgyProtocolError("ACP message chunks did not match the terminal response");
            if (suffix) { streamedText += suffix; emitBlock("text", suffix, true); }
          } else if (mapped.kind === "error") {
            closeBlock();
            send(errorPayload(mapped.error));
            if (!closed) controller.close();
            return;
          }
        }
        if (!sawResult && finishReason !== "tool_use") throw new AgyProtocolError("The ACP agent ended a turn without a result");
        closeBlock();
        send({ type: "message_delta", delta: { stop_reason: finishReason, stop_sequence: null }, usage: anthropicUsage(resultUsage) });
        send({ type: "message_stop" });
        if (!closed) controller.close();
      } catch (error) {
        const failure = asAgyError(error);
        closeBlock();
        send(errorPayload(failure));
        if (!closed) controller.close();
      } finally {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        await iterator?.return?.();
      }
    },
    async cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await iterator?.return?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

function utilityMessage(result: OneShotResult, model: string): Response {
  return Response.json({ id: completionId(), type: "message", role: "assistant", model, content: [{ type: "text", text: result.response }], stop_reason: "end_turn", stop_sequence: null, usage: anthropicUsage(result.usage) });
}

function collectedMessage(collected: Awaited<ReturnType<typeof collectTurn>>, model: string): Response {
  const content = hostVisibleContent(collected.segments).map((part, index) => part.type === "thinking" ? { ...part, signature: `agy-${index}` } : part);
  return Response.json({ id: completionId(), type: "message", role: "assistant", model, content, stop_reason: collected.finishReason, stop_sequence: null, usage: anthropicUsage(collected.usage) });
}

function utilityStream(result: OneShotResult, model: string): Response {
  const id = completionId();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      send({ type: "message_start", message: { id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: anthropicUsage(undefined) } });
      send({ type: "content_block_start", index: 0, content_block: contentBlock("text") });
      if (result.response) send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: result.response } });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: anthropicUsage(result.usage) });
      send({ type: "message_stop" });
      controller.close();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

async function handleMessages(request: Request, body: AnthropicMessageRequest): Promise<Response> {
  const hostID = readHeader(request, SESSION_HEADER);
  if (hostID && await sessionStore.isHostDeleted(hostID)) throw new AgyError("invalid_request", "This host session was deleted; late requests cannot recreate it");
  if ((body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || body.stop_sequences.length > 0)) || body.top_p !== undefined || body.top_k !== undefined || body.output_config !== undefined || body.response_format !== undefined) throw new AgyError("unsupported", "ACP does not enforce native sampling, stop sequences or JSON-schema output. Use host structured-output tools instead.", { code: "agy_unsupported_control" });
  if (body.temperature !== undefined && !warnedTemperature) { warnedTemperature = true; warn("Ignoring temperature: sampling is owned by ACP", { reason: "unsupported_temperature" }); }
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== "number" || !Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)) throw new AgyError("invalid_request", "max_tokens must be a positive integer budget");
  if (body.tool_choice !== undefined && body.tool_choice !== "auto" && !(body.tool_choice && typeof body.tool_choice === "object" && (body.tool_choice as any).type === "auto")) throw new AgyError("unsupported", "ACP currently supports automatic OpenCode tool selection only");
  if (!runtime) throw new AgyError("internal", "The Antigravity ACP proxy runtime is not initialized", { code: "agy_runtime_uninitialized" });
  await runtime.manager.refresh();
  if (runtime.catalog.source === "empty") throw runtime.manager.lastError ?? new AgyError("unknown_model", "Antigravity model discovery is unavailable");
  const cwd = resolvePath(readHeader(request, DIRECTORY_HEADER) || runtime.directory);
  if (!(await registeredWorkspaceContains(cwd))) throw new AgyError("unsupported", "The requested OpenCode workspace is outside the plugin workspace", { code: "agy_workspace_boundary" });
  const requestMessages = body.system === undefined ? body.messages : [{ role: "system", content: body.system }, ...(Array.isArray(body.messages) ? body.messages : [])];
  const key = `${runtime.manager.scope}:${sessionKey(request, requestMessages, cwd)}`;
  const requestedModel = readHeader(request, MODEL_HEADER) || (typeof body.model === "string" ? body.model : undefined);
  const requestedEffort = readHeader(request, EFFORT_HEADER);
  const selected = resolveAcpModelSelection(requestedModel, requestedEffort, runtime.catalog);
  const mode: "accept-edits" | "plan" | undefined = process.env.OPENCODE_ANTIGRAVITY_MODE === "accept-edits" || process.env.OPENCODE_ANTIGRAVITY_MODE === "plan" ? process.env.OPENCODE_ANTIGRAVITY_MODE : undefined;
  const settings = { cwd, model: selected.acpModel, ...(typeof body.max_tokens === "number" ? { outputBudget: body.max_tokens } : {}), ...(selected.effort ? { effort: selected.effort } : {}), ...(mode ? { mode } : {}), cliVersion: runtime.catalog.version, executable: runtime.catalog.executable, catalogScope: runtime.manager.scope, hostTools: true } as const;
  const metaKind = detectMetaRequestKind(Array.isArray(requestMessages) ? requestMessages : [], readHeader(request, REQUEST_KIND_HEADER));
  if (metaKind) {
    try {
      const normalized = await normalizePrompt(requestMessages, { allowedRoots: [cwd], hostTools: true });
      const generated = metaKind === "generate" ? buildGenerateUtilityPrompt(normalized.messages) : undefined;
      const utilityPrompt = generated?.context ?? buildUtilityPrompt(metaKind, normalized.messages);
      const hostSession = readHeader(request, SESSION_HEADER);
      if (metaKind === "summary" && hostSession) {
        await closeHostBridges(hostSession);
        await sessionPool.quiesceHostSession(hostSession);
        await sessionStore.compaction(hostSession, "pending", "generating");
      }
      const utility = await (metaKind === "summary" ? (prompt: string, options: Parameters<typeof runAcpOneShot>[1]) => runSummary(normalized.messages, options) : runAcpOneShot)(utilityPrompt, {
        cwd,
        model: selected.acpModel,
        outputBudget: settings.outputBudget,
        ...(selected.effort ? { effort: selected.effort } : {}),
        executable: settings.executable,
        signal: request.signal,
        ...(generated ? { preserveRequest: generated.request } : {}),
      });
      return body.stream === true ? utilityStream(utility, responseModel(body.model, selected.requestedModel)) : utilityMessage(utility, responseModel(body.model, selected.requestedModel));
    } catch (error) {
      const hostSession = readHeader(request, SESSION_HEADER);
      if (metaKind === "summary" && hostSession) await sessionStore.compaction(hostSession, "pending", "failed");
      return errorResponse(error);
    }
  }
  // The host session header is mandatory for tool continuations: inference
  // request content changes after every result and cannot identify a session.
  const sessionID = readHeader(request, SESSION_HEADER);
  if (body.tools !== undefined && !sessionID) throw new AgyError("invalid_request", "OpenCode tool requests require a session header");
  let events: AsyncIterable<BridgeEvent>;
  if (sessionID && (body.tools !== undefined || readHeader(request, "x-opencode-antigravity-host-tools") === "1")) {
    events = hostBridge(`host-v1:${key}`, sessionID, cwd).request({ messages: body.messages, system: body.system, tools: body.tools, settings,
      baseURL: getProxyBaseUrl().replace(/\/v1$/, ""), requestId: readHeader(request, MESSAGE_HEADER), signal: request.signal });
  } else {
    const normalized = await normalizePrompt(requestMessages, { allowedRoots: [cwd], hostTools: true });
    events = sessionPool.turn({ key, requestId: readHeader(request, MESSAGE_HEADER), prompt: normalized.blocks,
      messages: normalized.messages, hostSessionID: sessionID,
      priorMessages: normalized.priorMessages.filter((m) => m.role !== "system"), instructions: hostInstructions(body.system, cwd), settings, signal: request.signal });
  }
  const probed = await probeTurn(events);
  if ("error" in probed) return errorResponse(probed.error);
  if (body.stream !== true) {
    try {
      const acp: AcpEvent[] = []; const calls: unknown[] = [];
      for await (const event of probed.replay) { if (event.event === "host_tools") calls.push(...event.calls); else acp.push(event); }
      if (calls.length) {
        const state = createAcpTranslationState();
        const content: unknown[] = [];
        for (const event of acp) {
          const mapped = mapAcpEvent(event, state);
          if (mapped.kind === "error") throw mapped.error;
          if (mapped.kind === "text") content.push({ type: "text", text: mapped.text });
          if (mapped.kind === "reasoning" || mapped.kind === "activity") content.push({ type: "thinking", thinking: mapped.text, signature: `agy-${content.length}` });
        }
        return Response.json({ id: completionId(), type: "message", role: "assistant", model: responseModel(body.model, selected.requestedModel),
          content: [...content, ...calls], stop_reason: "tool_use", stop_sequence: null, usage: anthropicUsage(undefined) });
      }
      return collectedMessage(await collectTurn((async function* () { yield* acp; })()), responseModel(body.model, selected.requestedModel));
    }
    catch (error) { return errorResponse(error); }
  }
  return streamAnthropic(probed.replay, responseModel(body.model, selected.requestedModel), request.signal);
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/mcp/")) return handleHostMcp(request);
  const protectedRoute = (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models" || url.pathname === "/v1/usage" || url.pathname === "/usage")) || (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages"));
  if (protectedRoute && !localAuthorizationIsValid(request)) return errorResponse(new AgyError("auth", "Invalid local proxy API key", { code: "agy_local_key" }));
  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    const ready = Boolean(runtime && runtime.catalog.source !== "empty");
    return Response.json({ ok: ready, provider: "antigravity-acp", proxy: "loopback", port: proxyPort,
      acp: { executable: runtime?.catalog.executable, version: runtime?.catalog.version, ready, catalogSource: runtime?.catalog.source } });
  }
  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) return Response.json({ object: "list", data: (runtime?.catalog ?? fallbackAcpModelCatalog()).models.map((model) => ({ id: model.id, object: "model", created: Math.floor(Date.now() / 1_000), owned_by: "antigravity" })) });
  if (request.method === "GET" && (url.pathname === "/v1/usage" || url.pathname === "/usage")) {
    const sessionID = request.headers.get(SESSION_HEADER);
    if (!sessionID) return errorResponse(new AgyError("invalid_request", "Context usage requires a host session header"));
    return Response.json(await readContextSnapshot(sessionID));
  }
  if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
    try { return await handleMessages(request, await readJson(request)); }
    catch (error) { logError("message request failed", { kind: error instanceof AgyError ? error.kind : "internal" }); return errorResponse(error); }
  }
  return new Response("Not Found", { status: 404 });
}

async function startProxyInternal(directory: string): Promise<number> {
  if (server && proxyPort) return proxyPort;
  sessionPool.open();
  const manager = new ModelCatalog(directory, {
    onChange: () => { for (const listener of catalogListeners) listener(); },
    onScopeChange: async previous => {
      await closeHostBridgesForScope(previous);
      await sessionPool.retireCatalogScope(previous);
      info("Retired incompatible ACP authentication scope", { reason: "scope_changed" });
    },
  });
  runtime = { directory, manager, get catalog() { return manager.catalog; } };
  const bound = Bun.serve({ hostname: "127.0.0.1", port: requestedPort(), idleTimeout: 0, fetch: handleRequest });
  server = bound;
  proxyPort = bound.port ?? null;
  if (!proxyPort) throw new AgyError("internal", "The loopback Antigravity ACP proxy did not receive a port", { code: "agy_proxy_no_port" });
  await manager.start();
  info("Antigravity ACP loopback proxy listening", { port: proxyPort, models: manager.catalog.models.length, ready: manager.catalog.source !== "empty" });
  return proxyPort;
}

async function retainProxy(directory = process.cwd()): Promise<number> {
  workspaceRoots.add(resolvePath(directory));
  if (server && proxyPort) return proxyPort;
  if (!startPromise) startPromise = startProxyInternal(resolvePath(directory)).finally(() => { startPromise = null; });
  return startPromise;
}

async function releaseProxy(directory?: string): Promise<void> {
  if (directory) workspaceRoots.delete(resolvePath(directory)); else workspaceRoots.clear();
  if (workspaceRoots.size > 0) return;
  await closeHostBridges();
  if (server) { server.stop(true); server = null; proxyPort = null; }
  const manager = runtime?.manager;
  runtime = null;
  await manager?.close();
  await sessionPool.close();
}

function localProxyPort(): number | null { return proxyPort; }
function localProxyBaseUrl(): string { if (!proxyPort) throw new AgyError("internal", "The Antigravity ACP proxy is not listening", { code: "agy_proxy_not_started" }); return `http://127.0.0.1:${proxyPort}/v1`; }
function localProxyRuntime(): RuntimeState | null { return runtime; }
async function localRefreshModels(): Promise<AcpModelCatalog> {
  return runtime ? runtime.manager.refresh(true) : fallbackAcpModelCatalog();
}

type ProxyOwner = { refs: Map<string, number>; retain: typeof retainProxy; release: typeof releaseProxy; port: typeof localProxyPort; url: typeof localProxyBaseUrl; runtime: typeof localProxyRuntime; refresh: typeof localRefreshModels; listen: typeof localModelCatalogChange };
const processOwner = globalThis as typeof globalThis & { __agyProxyV1?: ProxyOwner };
const sharedProxy = processOwner.__agyProxyV1 ??= { refs: new Map(), retain: retainProxy, release: releaseProxy, port: localProxyPort, url: localProxyBaseUrl, runtime: localProxyRuntime, refresh: localRefreshModels, listen: localModelCatalogChange };
export async function startProxy(directory = process.cwd()): Promise<number> {
  const root = resolvePath(directory);
  sharedProxy.refs.set(root, (sharedProxy.refs.get(root) ?? 0) + 1);
  try { return await sharedProxy.retain(root); }
  catch (error) { await stopProxy(root); throw error; }
}
export async function stopProxy(directory?: string): Promise<void> {
  if (!directory) { sharedProxy.refs.clear(); return sharedProxy.release(); }
  const root = resolvePath(directory);
  const count = sharedProxy.refs.get(root) ?? 0;
  if (count > 1) { sharedProxy.refs.set(root, count - 1); return; }
  sharedProxy.refs.delete(root);
  await sharedProxy.release(root);
}
export const getProxyPort = () => sharedProxy.port();
export const getProxyBaseUrl = () => sharedProxy.url();
export const getProxyRuntime = () => sharedProxy.runtime();
export const refreshModels = () => sharedProxy.refresh();
export const onModelCatalogChange = (listener: () => void) => sharedProxy.listen(listener);

import { AgyAbortError, AgyError } from "./errors.js";
import type { AcpEvent } from "./protocol.js";
import type { ContentBlock, PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { canonical } from "./coordinator.js";

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
};

export type AnthropicFinishReason = "end_turn" | "max_tokens" | "stop_sequence" | "refusal";
export type OrderedSegment = { kind: "text" | "thinking" | "activity"; text: string };

/** The same ordered blocks used by the Anthropic response and durable boundary. */
export function hostVisibleContent(segments: OrderedSegment[]): Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }> {
  return segments.map(segment => segment.kind === "text" ? { type: "text", text: segment.text } : { type: "thinking", thinking: segment.text });
}
export type AcpTranslationState = { tools: Map<string, { title: string; failureShown?: boolean }>; terminal?: string };

export function createAcpTranslationState(): AcpTranslationState {
  return { tools: new Map() };
}

export type MappedAcpEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "activity"; text: string }
  | { kind: "result"; result: PromptResponse; response: string; finishReason: AnthropicFinishReason; usage?: AnthropicUsage }
  | { kind: "error"; error: AgyError; usage?: AnthropicUsage }
  | { kind: "ignore" };

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function usageFromAcp(usage: unknown): AnthropicUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const input = nonNegativeInteger(value.inputTokens ?? value.input_tokens);
  const output = nonNegativeInteger(value.outputTokens ?? value.output_tokens);
  const thinking = nonNegativeInteger(value.thoughtTokens ?? value.thinking_tokens ?? value.reasoning_tokens);
  const cached = nonNegativeInteger(value.cachedReadTokens ?? value.cacheReadTokens ?? value.cache_read_tokens ?? value.cachedInputTokens);
  const created = nonNegativeInteger(value.cachedWriteTokens ?? value.cacheCreationTokens ?? value.cache_creation_input_tokens);
  if (input !== undefined && (cached ?? 0) + (created ?? 0) > input) return undefined;
  if (input === undefined && output === undefined && cached === undefined && created === undefined && thinking === undefined) return undefined;
  // ACP totals are inclusive. Anthropic input_tokens excludes cache reads and
  // writes; otherwise the host encoder would count those tokens twice. Missing
  // totals remain required wire placeholders, not inferred measurements.
  return {
    input_tokens: input === undefined ? 0 : Math.max(0, input - (cached ?? 0) - (created ?? 0)),
    output_tokens: output ?? 0,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    ...(created !== undefined ? { cache_creation_input_tokens: created } : {}),
    ...(thinking !== undefined ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
  };
}

export function addAnthropicUsage(left: AnthropicUsage | undefined, right: AnthropicUsage | undefined): AnthropicUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const cached = (left.cache_read_input_tokens ?? 0) + (right.cache_read_input_tokens ?? 0);
  const created = (left.cache_creation_input_tokens ?? 0) + (right.cache_creation_input_tokens ?? 0);
  const thinking = (left.output_tokens_details?.thinking_tokens ?? 0) + (right.output_tokens_details?.thinking_tokens ?? 0);
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    ...(cached ? { cache_read_input_tokens: cached } : {}),
    ...(created ? { cache_creation_input_tokens: created } : {}),
    ...(thinking ? { output_tokens_details: { thinking_tokens: thinking } } : {}),
  };
}

function contentText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const value = content as { type?: unknown; text?: unknown };
  if (value.type === "text" && typeof value.text === "string") return value.text;
  if (value.type === "resource") {
    const resource = (value as unknown as { resource?: { text?: unknown } }).resource;
    return resource && typeof resource.text === "string" ? resource.text : "";
  }
  return "";
}

function contentTextFromUpdate(update: SessionUpdate): string {
  return update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk"
    ? contentText(update.content) : "";
}

function toolContentText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const value = content as Record<string, unknown>;
  return value.type === "content" ? contentText(value.content) : contentText(content);
}

function compactActivity(text: string, max = 240): string {
  const clean = text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function toolDescription(value: Record<string, unknown>): string | undefined {
  const supplied = typeof value.title === "string" && value.title ? value.title
    : typeof value.name === "string" && value.name ? value.name : undefined;
  const input = value.rawInput && typeof value.rawInput === "object" ? value.rawInput as Record<string, unknown> : {};
  // Include identifying arguments, never file contents, patches, or arbitrary
  // credential fields from rawInput.
  const details = [input.command, input.path, input.file_path, input.query, input.pattern]
    .filter((entry): entry is string => typeof entry === "string" && !!entry);
  if (Array.isArray(value.locations)) {
    for (const location of value.locations) {
      if (location && typeof location === "object" && typeof location.path === "string") {
        details.push(location.path + (typeof location.line === "number" ? `, line ${location.line}` : ""));
      }
    }
  }
  const title = supplied || ({ read: "Read", edit: "Edit", execute: "Shell", search: "Search" } as Record<string, string>)[String(value.kind)];
  if (!title && !details.length) return undefined;
  const unique = [...new Set(details)].filter(detail => !title?.includes(detail));
  return compactActivity(`${title || "tool"}${unique.length ? `: ${unique.join("; ")}` : ""}`);
}

function toolActivity(update: SessionUpdate, state?: AcpTranslationState): string | undefined {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return undefined;
  const value = update as unknown as Record<string, unknown>;
  const id = typeof value.toolCallId === "string" && value.toolCallId ? value.toolCallId : undefined;
  const status = typeof value.status === "string" ? value.status.toLowerCase() : "in_progress";
  const description = toolDescription(value);
  const key = id ?? `title:${description || "tool"}`;
  const known = state?.tools.get(key);
  const title = known?.title ?? description ?? "tool";
  if (status === "failed" || status === "cancelled") {
    if (known?.failureShown) return undefined;
    state?.tools.set(key, { title, failureShown: true });
    const output = Array.isArray(value.content)
      ? compactActivity(value.content.map(toolContentText).filter(Boolean).join("\n"), 2_000) : "";
    return `[Antigravity ACP tool ${status}: ${title}]${output ? `\n${output}` : ""}`;
  }
  if (known) return undefined;
  state?.tools.set(key, { title });
  // Some ACP servers report a call only once, already completed.
  const label = status === "completed" || /^running\b/i.test(title) ? title : `Running ${title}`;
  return `[Antigravity ACP tool: ${label}]`;
}

function planActivity(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate !== "plan" && update.sessionUpdate !== "plan_update") return undefined;
  const value = update as unknown as Record<string, unknown>;
  const plan = update.sessionUpdate === "plan" ? value : value.plan && typeof value.plan === "object" ? value.plan as Record<string, unknown> : value;
  const entries = Array.isArray(plan.entries) ? plan.entries : undefined;
  if (!entries?.length) return "[Antigravity ACP plan updated]";
  const lines = entries.map((entry) => {
    if (!entry || typeof entry !== "object") return "";
    const item = entry as Record<string, unknown>;
    return typeof item.content === "string" ? `- [${typeof item.status === "string" ? item.status : "pending"}] ${item.content}` : "";
  }).filter(Boolean).slice(0, 30);
  return `[Antigravity ACP plan]\n${lines.join("\n")}`;
}

function statusActivity(update: SessionUpdate): string | undefined {
  const value = update as unknown as Record<string, unknown>;
  switch (update.sessionUpdate) {
    case "available_commands_update": return "[Antigravity ACP commands updated]";
    case "current_mode_update": return `[Antigravity ACP mode: ${typeof value.currentModeId === "string" ? value.currentModeId : "updated"}]`;
    case "config_option_update": return "[Antigravity ACP configuration updated]";
    case "session_info_update": return typeof value.title === "string" ? `[Antigravity ACP: ${value.title}]` : "[Antigravity ACP session updated]";
    case "compaction_update": return value.status === "completed" ? "[Antigravity ACP context compacted]" : `[Antigravity ACP compaction: ${typeof value.status === "string" ? value.status : "updated"}]`;
    case "compaction_summary_chunk": return "[Antigravity ACP compaction summary]";
    default: return undefined;
  }
}

export function mapAcpEvent(event: AcpEvent, state?: AcpTranslationState): MappedAcpEvent {
  if (event.event === "update") {
    const update = event.update;
    if (update.sessionUpdate === "agent_thought_chunk") {
      const text = contentTextFromUpdate(update);
      return text ? { kind: "reasoning", text } : { kind: "ignore" };
    }
    const text = contentTextFromUpdate(update);
    if (text) return { kind: "text", text };
    const tool = toolActivity(update, state);
    if (tool) return { kind: "activity", text: tool };
    const plan = planActivity(update);
    if (plan) return { kind: "activity", text: plan };
    const status = statusActivity(update);
    if (status) return { kind: "activity", text: status };
    return { kind: "ignore" };
  }
  if (state) {
    const terminal = canonical(event.result);
    if (state.terminal === terminal) return { kind: "ignore" };
    if (state.terminal) return { kind: "error", error: new AgyError("protocol", "Conflicting terminal ACP responses") };
    state.terminal = terminal;
  }
  const usage = usageFromAcp(event.result.usage);
  if (event.result.stopReason === "cancelled") return { kind: "error", error: new AgyAbortError(), ...(usage ? { usage } : {}) };
  const finishReason: AnthropicFinishReason = event.result.stopReason === "refusal" ? "refusal" : event.result.stopReason === "max_tokens" || event.result.stopReason === "max_turn_requests" ? "max_tokens" : "end_turn";
  return { kind: "result", result: event.result, response: "", finishReason, ...(usage ? { usage } : {}) };
}

export function isMeaningfulEvent(event: AcpEvent): boolean {
  const mapped = mapAcpEvent(event);
  return mapped.kind === "text" || mapped.kind === "reasoning" || mapped.kind === "activity" || mapped.kind === "result" || mapped.kind === "error";
}

export type CollectedTurn = {
  content: string;
  reasoning: string;
  usage?: AnthropicUsage;
  result: PromptResponse;
  finishReason: AnthropicFinishReason;
  segments: OrderedSegment[];
};

export async function collectTurn(events: AsyncIterable<AcpEvent>): Promise<CollectedTurn> {
  let content = "";
  let reasoning = "";
  let resultUsage: AnthropicUsage | undefined;
  let result: PromptResponse | undefined;
  let finishReason: AnthropicFinishReason = "end_turn";
  const segments: OrderedSegment[] = [];
  const translation = createAcpTranslationState();
  for await (const event of events) {
    const mapped = mapAcpEvent(event, translation);
    if (mapped.kind === "text") {
      content += mapped.text;
      const last = segments.at(-1);
      if (last?.kind === "text") last.text += mapped.text;
      else segments.push({ kind: "text", text: mapped.text });
    } else if (mapped.kind === "reasoning") {
      reasoning += mapped.text;
      const last = segments.at(-1);
      if (last?.kind === "thinking") last.text += mapped.text;
      else segments.push({ kind: "thinking", text: mapped.text });
    } else if (mapped.kind === "activity") {
      segments.push({ kind: "activity", text: mapped.text });
    } else if (mapped.kind === "error") throw mapped.error;
    else if (mapped.kind === "result") {
      result = mapped.result;
      resultUsage = mapped.usage;
      finishReason = mapped.finishReason;
    }
  }
  if (!result) throw new AgyError("protocol", "The ACP agent ended a turn without a result", { code: "agy_acp_missing_result" });
  return { content, reasoning, ...(resultUsage ? { usage: resultUsage } : {}), result, finishReason, segments };
}

export function appendResultWithoutDuplication(streamed: string, result: string): string | undefined {
  if (!result) return "";
  if (!streamed) return result;
  if (result === streamed) return "";
  if (result.startsWith(streamed)) return result.slice(streamed.length);
  return undefined;
}

export async function* replay<T>(buffered: T[], rest: AsyncIterator<T>): AsyncGenerator<T> {
  for (const item of buffered) yield item;
  try {
    while (true) {
      const next = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await rest.return?.();
  }
}

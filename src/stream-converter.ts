import type { LanguageModelV3FinishReason, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import type { BridgeEvent, HostCall } from "./host-tools.js";
import type { ContextOccupancy } from "./protocol.js";
import {
  createAcpTranslationState,
  mapAcpEvent,
  type AcpTranslationState,
  type AnthropicFinishReason,
  type AnthropicUsage,
} from "./translate.js";

/**
 * ACP turn events to AI SDK stream parts.
 *
 * OpenCode owns the agent loop, so the adapter only has to keep the text and
 * reasoning block lifecycles balanced and report one finish. Tool calls are
 * emitted by the host bridge, which knows the call id OpenCode will answer.
 */
export function toAIUsage(usage: AnthropicUsage | undefined, context: ContextOccupancy | undefined): LanguageModelV3Usage {
  const input = usage?.input_tokens ?? context?.used;
  const cached = usage?.cache_read_input_tokens;
  const created = usage?.cache_creation_input_tokens;
  const output = usage?.output_tokens ?? 0;
  const reasoning = usage?.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: {
      total: input === undefined ? undefined : input + (cached ?? 0) + (created ?? 0),
      noCache: input,
      cacheRead: cached,
      cacheWrite: created,
    },
    outputTokens: {
      total: output,
      text: reasoning === undefined ? output : Math.max(0, output - reasoning),
      reasoning,
    },
  };
}

export function emptyUsage(): LanguageModelV3Usage {
  return { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: 0, reasoning: undefined } };
}

function finishReason(reason: AnthropicFinishReason): LanguageModelV3FinishReason {
  switch (reason) {
    case "max_tokens":
      return { unified: "length", raw: reason };
    case "refusal":
      return { unified: "content-filter", raw: reason };
    case "stop_sequence":
      return { unified: "stop", raw: reason };
    case "end_turn":
    default:
      return { unified: "stop", raw: reason };
  }
}

export class StreamConverter {
  private readonly state: AcpTranslationState = createAcpTranslationState();
  private textId: string | null = null;
  private reasoningId: string | null = null;
  private textOpen = false;
  private reasoningOpen = false;
  private counter = 0;
  private context?: ContextOccupancy;
  private usageValue?: LanguageModelV3Usage;
  private finishValue: LanguageModelV3FinishReason = { unified: "stop", raw: "end_turn" };

  get usage(): LanguageModelV3Usage | undefined {
    return this.usageValue;
  }

  get finish(): LanguageModelV3FinishReason {
    return this.finishValue;
  }

  get contextValue(): ContextOccupancy | undefined {
    return this.context;
  }

  toolCalls(calls: HostCall[]): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    for (const call of calls) {
      parts.push({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: JSON.stringify(call.input),
      });
    }
    return parts;
  }

  parts(event: BridgeEvent): LanguageModelV3StreamPart[] {
    if (event.event === "host_tools") {
      if (event.contextOccupancy) this.context = event.contextOccupancy;
      return [];
    }
    if ("contextOccupancy" in event && event.contextOccupancy) this.context = event.contextOccupancy;
    const mapped = mapAcpEvent(event, this.state);
    const parts: LanguageModelV3StreamPart[] = [];
    if (mapped.kind === "text") parts.push(...this.text(mapped.text));
    else if (mapped.kind === "reasoning") parts.push(...this.reasoning(mapped.text));
    else if (mapped.kind === "activity") parts.push(...this.reasoning(mapped.text, true));
    else if (mapped.kind === "result") {
      this.usageValue = toAIUsage(mapped.usage, this.context);
      this.finishValue = finishReason(mapped.finishReason);
    } else if (mapped.kind === "error") {
      throw mapped.error;
    }
    return parts;
  }

  closeBlocks(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.textOpen && this.textId) parts.push({ type: "text-end", id: this.textId });
    if (this.reasoningOpen && this.reasoningId) parts.push({ type: "reasoning-end", id: this.reasoningId });
    this.textOpen = false;
    this.reasoningOpen = false;
    this.textId = null;
    this.reasoningId = null;
    return parts;
  }

  finishParts(reason: LanguageModelV3FinishReason, usage = this.usageValue): LanguageModelV3StreamPart[] {
    return [{ type: "finish", finishReason: reason, usage: usage ?? emptyUsage() }];
  }

  private text(delta: string): LanguageModelV3StreamPart[] {
    if (!delta) return [];
    if (!this.textOpen) {
      this.textId = `agy-text-${this.counter++}`;
      this.textOpen = true;
      return [{ type: "text-start", id: this.textId }, { type: "text-delta", id: this.textId, delta }];
    }
    return [{ type: "text-delta", id: this.textId!, delta }];
  }

  private reasoning(delta: string, separate = false): LanguageModelV3StreamPart[] {
    if (!delta) return [];
    const parts: LanguageModelV3StreamPart[] = [];
    if (separate && this.reasoningOpen && this.reasoningId) {
      parts.push({ type: "reasoning-end", id: this.reasoningId });
      this.reasoningOpen = false;
      this.reasoningId = null;
    }
    if (!this.reasoningOpen) {
      this.reasoningId = `agy-reasoning-${this.counter++}`;
      this.reasoningOpen = true;
      parts.push({ type: "reasoning-start", id: this.reasoningId });
    }
    parts.push({ type: "reasoning-delta", id: this.reasoningId!, delta });
    return parts;
  }
}

import type { LanguageModelV3, LanguageModelV3FunctionTool, LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { asAgyError } from "../../src/errors.js";
import { ensureHostBridgeServer, hostBridge, type HostTool } from "../../src/host-tools.js";
import { bridgeKey, AGENT_OPTION, AntigravityLanguageModel } from "../../src/language-model.js";
import { fallbackAcpModelCatalog, resolveAcpModelSelection } from "../../src/models.js";
import { getRuntime } from "../../src/runtime.js";
import { createAcpTranslationState, mapAcpEvent } from "../../src/translate.js";

export type DriveOptions = {
  session: string;
  directory: string;
  messages: unknown;
  system?: string;
  tools?: HostTool[];
  model?: string;
  signal?: AbortSignal;
};

function acpModel(requested: string): string {
  const catalog = getRuntime()?.catalog ?? fallbackAcpModelCatalog();
  try {
    return resolveAcpModelSelection(requested, undefined, catalog).acpModel;
  } catch {
    return "gemini-3.8-flash-high";
  }
}

/**
 * Drive one host-bridge step and collect an Anthropic-shaped response. This is
 * the test boundary for the durable tool-call machinery that the HTTP proxy
 * used to front.
 */
export async function driveBridge(options: DriveOptions): Promise<Response> {
  const requested = options.model ?? "gemini-3.8-flash";
  const bridge = hostBridge(bridgeKey(options.directory, options.session), options.session, options.directory);
  const events = bridge.request({
    messages: options.messages,
    system: options.system,
    tools: options.tools,
    settings: {
      cwd: options.directory,
      model: acpModel(requested),
      hostTools: true,
      catalogScope: getRuntime()?.manager.scope,
    },
    baseURL: await ensureHostBridgeServer(),
    signal: options.signal,
  });
  const content: Array<Record<string, unknown>> = [];
  const state = createAcpTranslationState();
  let stopReason = "end_turn";
  try {
    for await (const event of events) {
      if (event.event === "host_tools") {
        stopReason = "tool_use";
        for (const call of event.calls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        break;
      }
      const mapped = mapAcpEvent(event, state);
      if (mapped.kind === "text") {
        const last = content.at(-1);
        if (last?.type === "text") last.text = String(last.text) + mapped.text;
        else content.push({ type: "text", text: mapped.text });
      } else if (mapped.kind === "reasoning" || mapped.kind === "activity") {
        content.push({ type: "thinking", thinking: mapped.text, signature: `agy-${content.length}` });
      } else if (mapped.kind === "error") {
        return Response.json({ error: { type: mapped.error.kind, message: mapped.error.message, code: mapped.error.code } }, { status: mapped.error.status });
      } else if (mapped.kind === "result") {
        stopReason = mapped.finishReason;
      }
    }
  } catch (error) {
    const agy = asAgyError(error);
    return Response.json({ error: { type: agy.kind, message: agy.message, code: agy.code } }, { status: agy.status });
  }
  return Response.json({ content, stop_reason: stopReason });
}

export type ModelDriveOptions = {
  prompt: LanguageModelV3Prompt;
  headers?: Record<string, string>;
  tools?: LanguageModelV3FunctionTool[];
  agentSystem?: string;
  model?: string;
  abortSignal?: AbortSignal;
  instance?: LanguageModelV3;
};

/** Drive the real LanguageModelV3 boundary and collect its stream parts. */
export async function driveModel(options: ModelDriveOptions): Promise<LanguageModelV3StreamPart[]> {
  const model = options.instance ?? new AntigravityLanguageModel(options.model ?? "gemini-3.8-flash", {});
  const providerOptions = options.agentSystem === undefined
    ? undefined
    : { antigravity: { [AGENT_OPTION]: options.agentSystem } };
  const result = await model.doStream({
    prompt: options.prompt,
    headers: options.headers,
    tools: options.tools,
    providerOptions,
    abortSignal: options.abortSignal,
  });
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of result.stream) parts.push(part);
  return parts;
}

export function textOf(parts: LanguageModelV3StreamPart[]): string {
  return parts.filter((part) => part.type === "text-delta").map((part) => part.type === "text-delta" ? part.delta : "").join("");
}

export function toolCallsOf(parts: LanguageModelV3StreamPart[]): Array<{ toolCallId: string; toolName: string; input: string }> {
  return parts.filter((part) => part.type === "tool-call").map((part) => part.type === "tool-call" ? { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input } : undefined).filter((value): value is { toolCallId: string; toolName: string; input: string } => value !== undefined);
}

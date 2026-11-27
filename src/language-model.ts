import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import { AgyError, AgyProtocolError, asAgyError, errorType, retryAfterSeconds } from "./errors.js";
import { DIRECTORY_HEADER, EFFORT_HEADER, FORK_HEADER, MODEL_HEADER, PROVIDER_ID, REQUEST_KIND_HEADER, SESSION_HEADER } from "./constants.js";
import { sdkPromptToHostMessages } from "./sdk-prompt.js";
import { ensureHostBridgeServer, hostBridge, type BridgeEvent, type HostTool } from "./host-tools.js";
import { getRuntime, workspaceContains } from "./runtime.js";
import { resolveAcpModelSelection } from "./models.js";
import { buildUtilityPrompt, runAcpOneShot } from "./utility.js";
import { TRANSCRIPT_INPUT_BYTE_CAP } from "./budget.js";
import { StreamConverter, toAIUsage } from "./stream-converter.js";
import type { SessionSettings } from "./session-pool.js";

export const AGENT_OPTION = "antigravityAgent";
export const INSTRUCTIONS_OPTION = "antigravityInstructions";

type RequestKind = "primary" | "compaction" | "title" | "generate";

function requestKind(kind: string | undefined): RequestKind {
  if (kind === "compaction" || kind === "title" || kind === "generate") return kind;
  return "primary";
}

function functionTools(options: LanguageModelV3CallOptions): LanguageModelV3FunctionTool[] {
  return (options.tools ?? []).filter((tool): tool is LanguageModelV3FunctionTool => tool.type === "function");
}

function hostTools(tools: LanguageModelV3FunctionTool[]): HostTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    input_schema: tool.inputSchema as Record<string, unknown>,
  }));
}

export function sessionKey(directory: string, sessionID: string): string {
  return createHash("sha256").update(`workspace:${resolvePath(directory)}:session:${sessionID}`).digest("hex");
}

/** Bridge/session key for one OpenCode session, matching the runtime scope. */
export function bridgeKey(directory: string, sessionID: string): string {
  const scope = getRuntime()?.manager.scope ?? "";
  return `host-v1:${scope}:${sessionKey(directory, sessionID)}`;
}

/**
 * Official Antigravity (ACP) as an OpenCode language model.
 *
 * OpenCode owns the agent loop. Each `doStream` call is one step: the prompt
 * carries the conversation, ACP runs its own turn against it, and OpenCode's
 * tools reach ACP through the host tool bridge. There is no HTTP proxy and no
 * Anthropic wire emulation in front of the model.
 */
export class AntigravityLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  readonly provider = PROVIDER_ID;
  readonly supportedUrls = {};

  constructor(
    readonly modelId: string,
    private readonly settings: Record<string, unknown>,
    /**
     * Key OpenCode nests provider options under. It is the model's canonical
     * provider when one is set, so the agent option is read from the same key
     * the session hook wrote under.
     */
    private readonly providerOptionKey = PROVIDER_ID,
  ) {}

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    throw new Error("Antigravity models only support streaming");
  }

  private agentSystem(options: LanguageModelV3CallOptions): string {
    const providerOptions = options.providerOptions?.[this.providerOptionKey] as Record<string, unknown> | undefined;
    return typeof providerOptions?.[AGENT_OPTION] === "string" ? providerOptions[AGENT_OPTION] : "";
  }

  private instructions(options: LanguageModelV3CallOptions): string {
    const providerOptions = options.providerOptions?.[this.providerOptionKey] as Record<string, unknown> | undefined;
    return typeof providerOptions?.[INSTRUCTIONS_OPTION] === "string" ? providerOptions[INSTRUCTIONS_OPTION] : "";
  }

  private providerError(error: AgyError): APICallError {
    const retryAfter = retryAfterSeconds(error);
    return new APICallError({
      message: error.message,
      url: "https://ai-sdk.local/antigravity",
      requestBodyValues: {},
      statusCode: error.status,
      ...(retryAfter === undefined ? {} : { responseHeaders: { "retry-after": String(retryAfter) } }),
      responseBody: JSON.stringify({
        error: {
          type: errorType(error),
          message: error.message,
          code: error.code,
          ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
        },
      }),
      isRetryable: error.retryable,
      cause: error,
    });
  }

  private settingsFor(directory: string, options: LanguageModelV3CallOptions): SessionSettings {
    const runtime = getRuntime();
    if (!runtime) throw new AgyError("internal", "The Antigravity runtime is not initialized", { code: "agy_runtime_uninitialized" });
    const requestedModel = (options.headers?.[MODEL_HEADER] as string | undefined) || this.modelId;
    const effort = options.headers?.[EFFORT_HEADER] as string | undefined;
    const selected = resolveAcpModelSelection(requestedModel, effort, runtime.catalog);
    return {
      cwd: directory,
      model: selected.acpModel,
      ...(selected.effort ? { effort: selected.effort } : {}),
      ...(typeof options.maxOutputTokens === "number" ? { outputBudget: options.maxOutputTokens } : {}),
      executable: runtime.catalog.executable,
      catalogScope: runtime.manager.scope,
      credentialRevision: runtime.manager.credentialRevision,
      hostTools: true,
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    if (options.toolChoice?.type === "required" || options.toolChoice?.type === "tool") {
      throw this.providerError(new AgyError("invalid_request", "Antigravity cannot enforce required or named tool choices", { code: "agy_tool_choice_unsupported", retryable: false }));
    }
    const headers = options.headers ?? {};
    const kind = requestKind(headers[REQUEST_KIND_HEADER] as string | undefined);
    const directory = headers[DIRECTORY_HEADER] ?? process.cwd();

    if (kind === "compaction" || kind === "title" || kind === "generate") {
      return this.runUtility(kind, options, directory);
    }

    const sessionID = headers[SESSION_HEADER];
    if (typeof sessionID !== "string" || sessionID.length === 0) {
      throw this.providerError(new AgyError("invalid_request", "Antigravity model request is missing the session header", { code: "agy_session_required" }));
    }
    const runtime = getRuntime();
    if (!runtime) throw this.providerError(new AgyError("internal", "The Antigravity runtime is not initialized", { code: "agy_runtime_uninitialized" }));
    await runtime.manager.refresh();
    if (runtime.catalog.source === "empty") {
      throw this.providerError(asAgyError(runtime.manager.lastError ?? new AgyError("unknown_model", "Antigravity model discovery is unavailable")));
    }
    if (!(await workspaceContains(directory))) {
      throw this.providerError(new AgyError("unsupported", "The requested OpenCode workspace is outside the plugin workspace", { code: "agy_workspace_boundary" }));
    }

    const settings = this.settingsFor(directory, options);
    const agentSystem = this.agentSystem(options);
    const instructions = this.instructions(options);
    // The agent role and OpenCode's instruction sources travel together as the
    // ACP instruction block; a change to either rebuilds the ACP context.
    const system = [agentSystem, instructions].filter((text) => text.trim()).join("\n\n");
    const messages = sdkPromptToHostMessages(options.prompt, { includeSystem: false });
    // The final step keeps tool definitions for the cached prefix but must not
    // call them; offering none is the portable equivalent for ACP.
    const tools = options.toolChoice?.type === "none" ? [] : hostTools(functionTools(options));
    const bridge = hostBridge(bridgeKey(directory, sessionID), sessionID, directory);
    const baseURL = await ensureHostBridgeServer();
    const fork = headers[FORK_HEADER];
    const cancellation = new AbortController();
    const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, cancellation.signal]) : cancellation.signal;
    const events = bridge.request({
      messages,
      system,
      tools,
      settings,
      baseURL,
      fork: typeof fork === "string" && fork.length > 0,
      signal,
    });
    return this.streamEvents(events, signal, cancellation);
  }

  private async runUtility(
    kind: "title" | "generate" | "compaction",
    options: LanguageModelV3CallOptions,
    directory: string,
  ): Promise<LanguageModelV3StreamResult> {
    const runtime = getRuntime();
    if (!runtime) throw this.providerError(new AgyError("internal", "The Antigravity runtime is not initialized", { code: "agy_runtime_uninitialized" }));
    await runtime.manager.refresh();
    if (runtime.catalog.source === "empty") {
      throw this.providerError(asAgyError(runtime.manager.lastError ?? new AgyError("unknown_model", "Antigravity model discovery is unavailable")));
    }
    const requestedModel = (options.headers?.[MODEL_HEADER] as string | undefined) || this.modelId;
    const effort = options.headers?.[EFFORT_HEADER] as string | undefined;
    const selected = resolveAcpModelSelection(requestedModel, effort, runtime.catalog);
    const messages = sdkPromptToHostMessages(options.prompt, { includeSystem: true });
    const prompt = buildUtilityPrompt(kind, messages);
    let result: Awaited<ReturnType<typeof runAcpOneShot>>;
    try {
      result = await runAcpOneShot(prompt, {
        cwd: directory,
        model: selected.acpModel,
        ...(selected.effort ? { effort: selected.effort } : {}),
        executable: runtime.catalog.executable,
        credentialRevision: runtime.manager.credentialRevision,
        signal: options.abortSignal,
        ...(kind === "compaction" ? { maxChars: TRANSCRIPT_INPUT_BYTE_CAP } : {}),
      });
    } catch (error) {
      throw this.providerError(asAgyError(error));
    }
    const id = "agy-utility-0";
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id });
        if (result.response) controller.enqueue({ type: "text-delta", id, delta: result.response });
        controller.enqueue({ type: "text-end", id });
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: toAIUsage(result.usage, undefined) ,
        });
        controller.close();
      },
    });
    return { stream };
  }

  private streamEvents(events: AsyncIterable<BridgeEvent>, signal: AbortSignal, cancellation: AbortController): LanguageModelV3StreamResult {
    const converter = new StreamConverter();
    let iterator: AsyncIterator<BridgeEvent> | undefined;
    let controller: ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined;
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (value) => {
        controller = value;
        try {
          value.enqueue({ type: "stream-start", warnings: [] });
        } catch {
          return;
        }
        iterator = events[Symbol.asyncIterator]();
        void (async () => {
          try {
            while (true) {
              if (signal?.aborted) throw new AgyError("timeout", "The client cancelled the Antigravity request", { status: 499, code: "agy_client_cancelled" });
              const next = await iterator!.next();
              if (next.done) break;
              const event = next.value;
              if (event.event === "host_tools") {
                // Captures the parked context occupancy for the finish usage.
                for (const part of converter.parts(event)) controller!.enqueue(part);
                for (const part of converter.toolCalls(event.calls)) controller!.enqueue(part);
                for (const part of converter.closeBlocks()) controller!.enqueue(part);
                for (const part of converter.finishParts({ unified: "tool-calls", raw: "tool_use" }, converter.usage ?? toAIUsage(undefined, converter.contextValue))) controller!.enqueue(part);
                controller!.close();
                return;
              }
              for (const part of converter.parts(event)) controller!.enqueue(part);
              if (event.event === "result") {
                for (const part of converter.closeBlocks()) controller!.enqueue(part);
                for (const part of converter.finishParts(converter.finish, converter.usage ?? undefined)) controller!.enqueue(part);
                controller!.close();
                return;
              }
            }
            throw new AgyProtocolError("The ACP agent ended a turn without a result");
          } catch (error) {
            try {
              for (const part of converter.closeBlocks()) controller!.enqueue(part);
              controller!.enqueue({ type: "error", error: this.providerError(asAgyError(error)) });
              controller!.close();
            } catch {
              // The consumer already cancelled the stream.
            }
          } finally {
            // Closing the generator runs the bridge's finally, releasing the
            // turn so the next step can continue the same session.
            try { await iterator?.return?.(); } catch { /* already closed */ }
          }
        })();
      },
      cancel: () => {
        cancellation.abort();
      },
    });
    return { stream };
  }
}

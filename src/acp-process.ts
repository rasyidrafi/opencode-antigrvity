import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type PromptResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { AgyAbortError, AgyError, AgyProcessError, AgyProtocolError, AgyTimeoutError } from "./errors.js";
import { DEFAULT_MAX_STDERR_BYTES, configuredPrintTimeoutMs, configuredTurnStallTimeoutMs, type AcpEffort } from "./constants.js";
import { detectAcpServer, ensureAcpServer } from "./acp-detect.js";
import { bridgeCliAuthentication } from "./auth-bridge.js";
import { debug, info, warn } from "./log.js";
import type { AcpEvent } from "./protocol.js";
import { catalogFromSession, type AcpModelCatalog } from "./models.js";
import { emitAcpCatalog } from "./catalog-events.js";
import { hostEnvironment } from "./host-environment.js";
import { assertHostToolCompatibility } from "./acp-compatibility.js";
export type { AcpEvent } from "./protocol.js";

export type AcpWorkerState = "created" | "starting" | "ready" | "turn_active" | "closing" | "closed" | "failed";

export type AcpWorkerOptions = {
  utilityDirectory?: string;
  cwd: string;
  executable?: string;
  executableArgs?: string[];
  environment?: Record<string, string | undefined>;
  model?: string;
  effort?: AcpEffort;
  sessionId?: string;
  mode?: "accept-edits" | "plan";
  authMethod?: string;
  skipSession?: boolean;
  nonInteractive?: boolean;
  catalogScope?: string;
  printTimeoutMs?: number;
  stallTimeoutMs?: number;
  onActivity?: () => void;
  hostTools?: boolean;
  mcpServers?: Array<{ type: "http"; name: string; url: string; headers: Array<{ name: string; value: string }> }>;
  waitingForTools?: () => boolean;
};

type QueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
};

export class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: QueueWaiter<T>[] = [];
  private closed = false;
  private closeError: unknown;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.cleanup(waiter);
      waiter.resolve({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter);
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined as never });
    }
  }

  next(options: { signal?: AbortSignal } = {}): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.closed) return this.closeError ? Promise.reject(this.closeError) : Promise.resolve({ done: true, value: undefined as never });
    return new Promise<IteratorResult<T>>((resolveResult, reject) => {
      const waiter: QueueWaiter<T> = { resolve: resolveResult, reject };
      const remove = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      if (options.signal) {
        const onAbort = () => {
          remove();
          this.cleanup(waiter);
          reject(new AgyAbortError());
        };
        waiter.abort = () => options.signal?.removeEventListener("abort", onAbort);
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private cleanup(waiter: QueueWaiter<T>): void {
    waiter.abort?.();
  }
}

type TurnActivityWatchdog = {
  touch: () => void;
  stop: () => void;
  lastActivityAt: () => number;
};

function createTurnActivityWatchdog(timeoutMs: number, onTimeout: () => void, paused?: () => boolean): TurnActivityWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let fired = false;
  let lastActivity = performance.now();

  const schedule = () => {
    if (stopped || fired || timeoutMs <= 0) return;
    if (timer) clearTimeout(timer);
    const remaining = timeoutMs - (performance.now() - lastActivity);
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || fired) return;
      if (paused?.()) { lastActivity = performance.now(); schedule(); return; }
      if (performance.now() - lastActivity >= timeoutMs) {
        fired = true;
        onTimeout();
      } else {
        schedule();
      }
    }, Math.min(Math.max(1, remaining), 2_147_483_647));
    timer.unref?.();
  };

  schedule();
  return {
    touch() {
      if (stopped || fired) return;
      lastActivity = performance.now();
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    lastActivityAt: () => lastActivity,
  };
}

function asAcpError(error: unknown, fallback: string): AgyError {
  if (error instanceof AgyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const rpc = error && typeof error === "object" ? error as { code?: unknown; data?: unknown } : {};
  const data = rpc.data && typeof rpc.data === "object" ? rpc.data as Record<string, unknown> : {};
  const inner = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : {};
  const lower = [message, data.type, data.code, inner.type, inner.code].filter(value => typeof value === "string").join(" ").toLowerCase();
  const details = { ...data, ...(rpc.code === -32600 || rpc.code === -32602 ? { execution: "rejected-before-execution" } : {}) };
  if (/context_length_exceeded|model_context_window_exceeded|request_too_large|context (?:window|length).*(?:exceed|overflow)|too many tokens/.test(lower)) {
    return new AgyError("context_overflow", message, { code: "context_length_exceeded", details });
  }
  if (/auth|login|authenticate|credential/.test(lower)) {
    return new AgyError("auth", `${message}. Authenticate the official ACP server with the provider auth action or OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD.`, { code: "agy_acp_auth", details });
  }
  if (/rate.?limit|too many requests/.test(lower)) return new AgyError("rate_limit", message, { code: "agy_acp_rate_limit", details });
  if (/quota|resource[ _]exhausted/.test(lower)) return new AgyError("quota", message, { code: "agy_acp_quota", details });
  if (/overload|temporarily unavailable/.test(lower)) return new AgyError("overload", message, { details });
  if (/refusal|content.policy/.test(lower)) return new AgyError("refusal", message, { details });
  if (rpc.code === -32600 || rpc.code === -32602) return new AgyError("invalid_request", message, { details });
  if (/cancel|abort/.test(lower)) return new AgyAbortError(message);
  return new AgyProcessError(message || fallback, error);
}

function timeoutMsOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : value;
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Loading is pre-inference, but an authorization rejection is never proof
  // of an unavailable cache. Deny precedence also covers mixed messages.
  if (/auth|permission|forbidden|access denied|unauthorized|credentials|login/i.test(message)) return false;
  return /session.{0,200}not found|unknown session|invalid session|no such session|cannot load (?:stored )?session|method not found|session (?:cannot be resumed|is not resumable|has expired)|resume (?:is )?not supported/i.test(message);
}

function isAuthenticationRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /authentication required|auth required|not authenticated|login required/i.test(message);
}

function terminateProcess(child: ChildProcess, force = false): void {
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

export class AcpWorker {
  readonly options: AcpWorkerOptions;
  readonly executable: string;
  readonly startedAt = Date.now();
  private child: ChildProcess | null = null;
  private connection: ClientConnection | null = null;
  private stateValue: AcpWorkerState = "created";
  private initValue: InitializeResponse | null = null;
  private sessionIdValue: string | undefined;
  private resumedValue = false;
  private activeTurn = false;
  private stopping = false;
  private closePromise: Promise<void> | null = null;
  private turnEvents: AsyncEventQueue<AcpEvent> | null = null;
  private turnWatchdog: TurnActivityWatchdog | null = null;
  private stderrDiagnostic = "";
  private actualModelValue?: string;
  private executionActivity = false;

  constructor(options: AcpWorkerOptions, executable: string) {
    this.options = { ...options };
    this.executable = executable;
    this.sessionIdValue = options.sessionId;
  }

  get state(): AcpWorkerState { return this.stateValue; }
  get resumed(): boolean { return this.resumedValue; }
  get sessionId(): string | undefined { return this.sessionIdValue; }
  get init(): InitializeResponse | null { return this.initValue; }
  get actualModel(): string | undefined { return this.actualModelValue; }
  get hasExecutionActivity(): boolean { return this.executionActivity; }
  catalog: AcpModelCatalog | undefined;

  private recordModels(response: unknown): void {
    if (response && typeof response === "object") {
      const value = response as { configOptions?: Array<{ id?: string; category?: string; currentValue?: unknown }>; models?: { currentModelId?: unknown } };
      const selector = value.configOptions?.find(option => option.category === "model" || option.id === "model");
      const current = selector?.currentValue ?? value.models?.currentModelId;
      if (typeof current === "string" && current) this.actualModelValue = current;
    }
    const catalog = catalogFromSession(response, this.executable, this.initValue?.agentInfo?.version ?? null);
    if (!catalog) return;
    this.catalog = catalog;
    emitAcpCatalog(this.options.catalogScope, catalog);
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.stateValue === "ready") return;
    if (this.stateValue !== "created") throw new AgyProcessError(`Cannot start ACP worker from state ${this.stateValue}`);
    this.stateValue = "starting";
    try {
      const args = this.options.executableArgs ?? (await detectAcpServer(this.executable)).args;
      this.child = spawn(this.executable, args, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.environment },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const child = this.child as ChildProcessWithoutNullStreams;
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (this.stderrDiagnostic.length >= DEFAULT_MAX_STDERR_BYTES) return;
        this.stderrDiagnostic += (typeof chunk === "string" ? chunk : chunk.toString("utf8")).slice(0, DEFAULT_MAX_STDERR_BYTES - this.stderrDiagnostic.length);
      });
      child.once("error", (error) => {
        if (!this.stopping) this.connection?.close(error);
      });
      const input = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
      const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
      const stream = ndJsonStream(output, input);
      const app = client({ name: "opencode-antigravity" });
      app.onNotification(methods.client.session.update, ({ params }) => this.onSessionUpdate(params));
      app.onRequest(methods.client.session.requestPermission, ({ params }) => this.requestPermission(params));
      this.connection = app.connect(stream);
      void this.connection.closed.then(() => {
        if (!this.stopping) this.turnEvents?.close(new AgyProcessError("The ACP agent connection closed unexpectedly", this.stderrDiagnostic));
      });
      const agent = this.connection.agent;
      const init = await this.withSignal(agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "opencode-antigravity", version: "0.6.0" },
      }), signal);
      this.initValue = init;
      const authMethod = this.options.authMethod?.trim() || process.env.OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD?.trim();
      if (authMethod && !this.options.nonInteractive) {
        const advertised = init.authMethods?.find((method) => method.id === authMethod);
        if (!advertised) throw new AgyError("auth", `The ACP server did not advertise authentication method "${authMethod}"`, { code: "agy_acp_auth_method" });
        if ((advertised as { type?: unknown }).type === "terminal") throw new AgyError("unsupported", `Authentication method "${authMethod}" requires a terminal ACP flow`, { code: "agy_acp_terminal_auth" });
        await this.withSignal(agent.request(methods.agent.authenticate, { methodId: authMethod }), signal);
      }
      if (!this.options.skipSession) {
        try {
          await this.openSession(agent, signal);
        } catch (error) {
          const explicitMethod = this.options.authMethod?.trim() || process.env.OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD?.trim();
          if (explicitMethod || this.options.nonInteractive || !isAuthenticationRequired(error)) throw error;
          const method = init.authMethods?.find((entry) => entry.id === "oauth-personal") ?? init.authMethods?.find((entry) => (entry as { type?: unknown }).type !== "terminal");
          if (!method) throw error;
          await this.withSignal(agent.request(methods.agent.authenticate, { methodId: method.id }), signal);
          await this.openSession(agent, signal);
        }
      }
      this.stateValue = "ready";
      info("official Antigravity worker ready", { protocol: init.protocolVersion, session: Boolean(this.sessionIdValue) });
    } catch (error) {
      await this.stop(true);
      this.stateValue = "failed";
      throw asAcpError(error, "The official Antigravity server could not be started");
    }
  }

  private async openSession(agent: ClientConnection["agent"], signal?: AbortSignal): Promise<void> {
    const request = {
      cwd: this.options.cwd,
      mcpServers: this.options.mcpServers ?? [],
      _meta: { agy: { enabledTools: [] } },
    };
    if (this.options.sessionId && this.initValue?.agentCapabilities?.loadSession === true) {
      try {
        const loaded = await this.withSignal(agent.request(methods.agent.session.load, { sessionId: this.options.sessionId, ...request }), signal) as { configOptions?: unknown; modes?: unknown } | void;
        this.recordModels(loaded);
        this.sessionIdValue = this.options.sessionId;
        this.resumedValue = true;
        await this.configureSession(agent, loaded && typeof loaded === "object" ? loaded.configOptions : undefined, loaded && typeof loaded === "object" ? loaded.modes : undefined, signal);
        return;
      } catch (error) {
        if (!isMissingSessionError(error)) throw error;
        warn("stored ACP session could not be loaded; creating a new session", { kind: error instanceof Error ? error.name : "unknown" });
      }
    }
    const created = await this.withSignal(agent.request(methods.agent.session.new, request), signal) as { sessionId: string; configOptions?: unknown; modes?: unknown };
    this.recordModels(created);
    this.sessionIdValue = created.sessionId;
    this.resumedValue = false;
    await this.configureSession(agent, created.configOptions, created.modes, signal);
  }

  private async configureSession(agent: ClientConnection["agent"], configOptions: unknown, modes: unknown, signal?: AbortSignal): Promise<void> {
    if (!this.sessionIdValue) return;
    const modeState = modes && typeof modes === "object" ? modes as { currentModeId?: unknown; availableModes?: Array<{ id?: unknown }> } : undefined;
    if (this.options.mode && Array.isArray(modeState?.availableModes)) {
      const requested = this.options.mode === "accept-edits" ? ["auto_edit", "accept-edits", "code", "yolo"] : ["plan", "architect", "default"];
      const mode = modeState.availableModes.find((entry) => requested.includes(String(entry.id)));
      if (mode?.id) {
        await this.withSignal(agent.request(methods.agent.session.setMode, { sessionId: this.sessionIdValue, modeId: String(mode.id) }), signal);
      }
    }
    const hasModelSelector = Array.isArray(configOptions) && configOptions.some((option) => option?.category === "model" || option?.id === "model");
    if (this.options.model && this.catalog && !hasModelSelector && this.options.model !== this.catalog.currentModel) {
      throw new AgyError("unsupported", "This ACP server lists models but does not expose session model configuration", { code: "agy_acp_model_selection" });
    }
    if (!Array.isArray(configOptions)) return;
    const options = configOptions as Array<{ id?: unknown; category?: unknown; options?: Array<{ value?: unknown }>; currentValue?: unknown }>;
    const desired: Array<{ ids: string[]; value: string | undefined }> = [
      { ids: ["model"], value: this.options.model },
      { ids: ["effort", "thought_level", "reasoning_effort"], value: this.options.effort },
      { ids: ["mode"], value: this.options.mode === "accept-edits" ? "auto_edit" : this.options.mode === "plan" ? "default" : this.options.mode },
    ];
    for (const item of desired) {
      if (!item.value) continue;
      const option = options.find((candidate) => item.ids.includes(String(candidate.id)) || item.ids[0] === "model" && candidate.category === "model");
      if (!option) continue;
      const values = item.ids[0] === "model" && this.catalog ? this.catalog.exactModels.map((model) => model.id)
        : Array.isArray(option.options) ? option.options.map((entry) => String(entry.value)) : [];
      const value = values.length
        ? values.find((entry) => entry === item.value)
        : item.value;
      if (!value || (values.length > 0 && !values.includes(value))) {
        throw new AgyError("unknown_model", `The ACP session does not support the requested ${String(option.id)} value`, {
          code: "agy_acp_config_value",
          details: { configId: String(option.id), available: values },
        });
      }
      if (item.ids[0] === "model") this.actualModelValue = undefined;
      const updated = await this.withSignal(agent.request(methods.agent.session.setConfigOption, {
        sessionId: this.sessionIdValue,
        configId: String(option.id),
        value,
      }), signal);
      this.recordModels(updated);
    }
  }

  private onSessionUpdate(params: SessionNotification): void {
    if (params.sessionId === this.sessionIdValue && params.update.sessionUpdate === "config_option_update") {
      this.recordModels(params.update);
    }
    if (!this.sessionIdValue || params.sessionId !== this.sessionIdValue || !this.turnEvents) return;
    // A turn may legitimately run for longer than the setup/RPC timeout. Only
    // reset the turn watchdog when the ACP transport actually delivers an
    // update, so a busy stream cannot be mistaken for a hung turn.
    this.turnWatchdog?.touch();
    this.options.onActivity?.();
    this.turnEvents.push({ event: "update", sessionId: params.sessionId, update: params.update });
  }

  async *runTurn(content: ContentBlock[] | string, signal?: AbortSignal): AsyncGenerator<AcpEvent> {
    if (this.stateValue !== "ready") throw new AgyProcessError(`Cannot run an ACP turn from state ${this.stateValue}`);
    if (!this.sessionIdValue) throw new AgyProcessError("The ACP session has no session id");
    if (this.activeTurn) throw new AgyProcessError("The ACP worker already has an active turn");
    if (signal?.aborted) throw new AgyAbortError();
    this.activeTurn = true;
    this.executionActivity = false;
    this.stateValue = "turn_active";
    this.turnEvents = new AsyncEventQueue<AcpEvent>();
    let result: PromptResponse | undefined;
    let requestPromise: Promise<PromptResponse> | undefined;
    let externalAborted = false;
    let timedOut = false;
    let turnWatchdog: TurnActivityWatchdog | undefined;
    let timeoutIdleMs = 0;
    const turnController = new AbortController();
    const cancel = () => this.connection?.agent.notify(methods.agent.session.cancel, { sessionId: this.sessionIdValue! }).catch(() => undefined);
    const stallMs = timeoutMsOrDefault(this.options.stallTimeoutMs, configuredTurnStallTimeoutMs());
    try {
      const prompt = typeof content === "string" ? [{ type: "text", text: content } satisfies ContentBlock] : content;
      this.validatePromptCapabilities(prompt);
      const abort = () => {
        externalAborted = true;
        void cancel();
        turnController.abort();
      };
      signal?.addEventListener("abort", abort, { once: true });
      /*
       * printTimeoutMs belongs to setup RPCs such as initialize and session
       * creation. It is deliberately not a wall-clock limit for a streamed
      * turn. Long ACP tasks stay alive while session/update notifications
      * arrive; this watchdog only fires after a quiet period.
      */
      turnWatchdog = createTurnActivityWatchdog(stallMs, () => {
        timeoutIdleMs = performance.now() - (turnWatchdog?.lastActivityAt() ?? performance.now());
        debug("ACP turn idle watchdog fired", { stallMs, idleMs: Math.round(timeoutIdleMs) });
        timedOut = true;
        void cancel();
        turnController.abort();
        // The generator may be suspended at `yield`, with no pending
        // `next()` for the abort signal to reject. Stop the worker here too
        // so an abandoned stream cannot leave an ACP process running.
        void this.stop(true).catch(() => undefined);
      }, this.options.waitingForTools);
      this.turnWatchdog = turnWatchdog;
      requestPromise = this.connection!.agent.request(methods.agent.session.prompt, {
        sessionId: this.sessionIdValue,
        prompt,
      });
      const events = this.turnEvents;
      void requestPromise.then(
        (response) => {
          // A terminal response is activity too. Stop the idle timer before
          // queueing it so a paused consumer cannot turn a completed prompt
          // into a timeout while it is waiting to read the result.
          turnWatchdog?.stop();
          events.push({ event: "result", sessionId: this.sessionIdValue!, result: response });
        },
        (error) => {
          turnWatchdog?.stop();
          events.close(error);
          // A rejected prompt is terminal even if the consumer is paused at
          // an earlier update. Do not leave the ACP child alive waiting for a
          // future `next()` call that may never happen.
          void this.stop(true).catch(() => undefined);
        },
      );
      try {
        while (true) {
          const next = await this.turnEvents.next({ signal: turnController.signal });
          if (next.done) break;
          if (next.value.event === "result") {
            result = next.value.result;
            break;
          }
          yield next.value;
        }
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      if (!result) throw new AgyProtocolError("The ACP prompt ended without a response");
      turnWatchdog?.stop();
      if (this.turnWatchdog === turnWatchdog) this.turnWatchdog = null;
      this.stateValue = "ready";
      yield { event: "result", sessionId: this.sessionIdValue, result };
    } catch (error) {
      if (externalAborted || timedOut || turnController.signal.aborted) {
        await cancel();
        await Promise.race([
          requestPromise?.catch(() => undefined),
          new Promise<void>((resolveResult) => {
            const timer = setTimeout(resolveResult, 1_000);
            timer.unref?.();
          }),
        ]);
        await this.stop(true);
        if (timedOut) {
          throw new AgyTimeoutError(`The ACP prompt timed out after ${Math.ceil(Math.max(timeoutIdleMs, stallMs) / 1_000)} seconds without receiving an ACP stream update`);
        }
        throw new AgyAbortError();
      }
      await this.stop(true).catch(() => undefined);
      throw asAcpError(error, "The ACP prompt failed");
    } finally {
      turnWatchdog?.stop();
      if (this.turnWatchdog === turnWatchdog) this.turnWatchdog = null;
      if (!result && !this.stopping && this.connection && this.sessionIdValue) {
        await cancel();
        await this.stop(true);
      }
      this.turnEvents?.close();
      this.turnEvents = null;
      this.activeTurn = false;
      if (this.stateValue === "turn_active") this.stateValue = "failed";
    }
  }

  private validatePromptCapabilities(prompt: ContentBlock[]): void {
    const capabilities = this.initValue?.agentCapabilities?.promptCapabilities;
    for (const block of prompt) {
      if (block.type === "image" && capabilities?.image !== true) {
        throw new AgyError("unsupported", "The official ACP server did not advertise image prompt support", { code: "agy_acp_image_unsupported" });
      }
      if (block.type === "audio" && capabilities?.audio !== true) {
        throw new AgyError("unsupported", "The official ACP server did not advertise audio prompt support", { code: "agy_acp_audio_unsupported" });
      }
    }
  }

  async stop(force = false): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopping = true;
    this.stateValue = "closing";
    this.closePromise = (async () => {
      this.turnEvents?.close(new AgyProcessError("The ACP worker stopped"));
      this.connection?.close();
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.stdin?.end(); } catch { /* continue */ }
        await new Promise<void>((resolveResult) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = () => { if (timer) clearTimeout(timer); resolveResult(); };
          child.once("close", finish);
          timer = setTimeout(() => {
            terminateProcess(child, force);
            resolveResult();
          }, force ? 500 : 3_000);
          timer.unref?.();
        });
      }
      this.stateValue = "closed";
      debug("official Antigravity worker stopped", { force });
    })();
    return this.closePromise;
  }

  private async requestPermission(params: import("@agentclientprotocol/sdk").RequestPermissionRequest): Promise<import("@agentclientprotocol/sdk").RequestPermissionResponse> {
    this.executionActivity = true;
    const meta = (params.toolCall as { _meta?: { mcp?: { server?: string } } })._meta;
    // The isolated harness contains only our session-bound MCP endpoint.
    const dispatcher = params.toolCall.title === "Run call_mcp_tool?";
    const allowed = (meta?.mcp?.server === "opencode" || dispatcher) && Boolean(this.options.mcpServers?.length);
    const option = params.options.find((item) => item.kind === (allowed ? "allow_once" : "reject_once"));
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private async withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    const timeoutMs = timeoutMsOrDefault(this.options.printTimeoutMs, configuredPrintTimeoutMs());
    if (!signal && timeoutMs <= 0) return promise;
    if (signal?.aborted) throw new AgyAbortError();
    return new Promise<T>((resolveResult, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolveResult(value as T);
      };
      const abort = () => finish(new AgyAbortError());
      signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(new AgyTimeoutError(`ACP request timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`)), timeoutMs);
        timer.unref?.();
      }
      promise.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }
}

export async function createAcpWorker(options: AcpWorkerOptions, signal?: AbortSignal): Promise<AcpWorker> {
  const detection = options.executable
    ? { executable: options.executable, args: options.executableArgs }
    : await ensureAcpServer();
  if (options.hostTools) await assertHostToolCompatibility(detection.executable);
  if (options.hostTools) {
    const isolated = await hostEnvironment({ ...process.env, ...options.environment,
      ...(options.authMethod ? { OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD: options.authMethod } : {}) },
      options.catalogScope, options.utilityDirectory);
    options = { ...options, ...isolated };
  }
  await bridgeCliAuthentication({
    ...process.env,
    ...options.environment,
    ...(options.authMethod ? { OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD: options.authMethod } : {}),
  });
  const worker = new AcpWorker({
    ...options,
    executableArgs: options.executableArgs ?? detection.args,
    printTimeoutMs: options.printTimeoutMs ?? configuredPrintTimeoutMs(),
  }, detection.executable);
  await worker.start(signal);
  return worker;
}

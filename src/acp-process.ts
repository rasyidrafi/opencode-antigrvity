import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type PermissionOptionKind,
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
export type { AcpEvent } from "./protocol.js";

export type AcpWorkerState = "created" | "starting" | "ready" | "turn_active" | "closing" | "closed" | "failed";

export type AcpWorkerOptions = {
  cwd: string;
  executable?: string;
  executableArgs?: string[];
  addDirs?: string[];
  environment?: Record<string, string | undefined>;
  model?: string;
  effort?: AcpEffort;
  sessionId?: string;
  mode?: "accept-edits" | "plan";
  authMethod?: string;
  skipSession?: boolean;
  permissionPolicy?: "allow-always" | "allow-once" | "deny";
  printTimeoutMs?: number;
  stallTimeoutMs?: number;
  onActivity?: () => void;
};

type QueueWaiter<T> = {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
};

class AsyncEventQueue<T> {
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

function createTurnActivityWatchdog(timeoutMs: number, onTimeout: () => void): TurnActivityWatchdog {
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

type TerminalRecord = {
  child: ChildProcess;
  output: string;
  truncated: boolean;
  outputLimit: number;
  exitStatus?: { exitCode?: number | null; signal?: string | null };
  closed: Promise<void>;
};

function asAcpError(error: unknown, fallback: string): AgyError {
  if (error instanceof AgyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (/auth|login|authenticate|credential/.test(lower)) {
    return new AgyError("auth", `${message}. Authenticate the official ACP server with the provider auth action or OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD.`, { code: "agy_acp_auth" });
  }
  if (/quota|rate limit|resource exhausted/.test(lower)) return new AgyError("quota", message, { code: "agy_acp_quota" });
  if (/cancel|abort/.test(lower)) return new AgyAbortError(message);
  return new AgyProcessError(message || fallback, error);
}

function timeoutMsOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 0 ? fallback : value;
}

function contentText(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const value = content as { type?: unknown; text?: unknown };
  return value.type === "text" && typeof value.text === "string" ? value.text : "";
}

function safeOptionKind(kind: PermissionOptionKind): boolean {
  return kind === "allow_always" || kind === "allow_once";
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|unknown session|invalid session|no such session|cannot load/i.test(message);
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
  private terminals = new Map<string, TerminalRecord>();
  private roots: string[] = [];
  private stderrDiagnostic = "";

  constructor(options: AcpWorkerOptions, executable: string) {
    this.options = { ...options };
    this.executable = executable;
    this.sessionIdValue = options.sessionId;
  }

  get state(): AcpWorkerState { return this.stateValue; }
  get resumed(): boolean { return this.resumedValue; }
  get sessionId(): string | undefined { return this.sessionIdValue; }
  get init(): InitializeResponse | null { return this.initValue; }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.stateValue === "ready") return;
    if (this.stateValue !== "created") throw new AgyProcessError(`Cannot start ACP worker from state ${this.stateValue}`);
    this.stateValue = "starting";
    this.roots = [this.options.cwd, ...(this.options.addDirs ?? [])].map((path) => resolve(path));
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
      app.onRequest(methods.client.fs.readTextFile, ({ params }) => this.readTextFile(params));
      app.onRequest(methods.client.fs.writeTextFile, ({ params }) => this.writeTextFile(params));
      app.onRequest(methods.client.terminal.create, ({ params }) => this.createTerminal(params));
      app.onRequest(methods.client.terminal.output, ({ params }) => this.terminalOutput(params));
      app.onRequest(methods.client.terminal.waitForExit, ({ params }) => this.waitForTerminal(params));
      app.onRequest(methods.client.terminal.kill, ({ params }) => this.killTerminal(params));
      app.onRequest(methods.client.terminal.release, ({ params }) => this.releaseTerminal(params));
      this.connection = app.connect(stream);
      void this.connection.closed.then(() => {
        if (!this.stopping) this.turnEvents?.close(new AgyProcessError("The ACP agent connection closed unexpectedly", this.stderrDiagnostic));
      });
      const agent = this.connection.agent;
      const init = await this.withSignal(agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "opencode-antigravity", version: "0.2.1" },
      }), signal);
      this.initValue = init;
      const authMethod = this.options.authMethod?.trim() || process.env.OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD?.trim();
      if (authMethod) {
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
          if (explicitMethod || !isAuthenticationRequired(error)) throw error;
          const method = init.authMethods?.find((entry) => entry.id === "oauth-personal") ?? init.authMethods?.find((entry) => (entry as { type?: unknown }).type !== "terminal");
          if (!method) throw error;
          await this.withSignal(agent.request(methods.agent.authenticate, { methodId: method.id }), signal);
          await this.openSession(agent, signal);
        }
      }
      this.stateValue = "ready";
      info("official Antigravity ACP worker ready", { protocol: init.protocolVersion, session: Boolean(this.sessionIdValue) });
    } catch (error) {
      await this.stop(true);
      this.stateValue = "failed";
      throw asAcpError(error, "The official Antigravity ACP server could not be started");
    }
  }

  private async openSession(agent: ClientConnection["agent"], signal?: AbortSignal): Promise<void> {
    const request = {
      cwd: this.options.cwd,
      mcpServers: [],
      ...(this.options.addDirs?.length ? { additionalDirectories: this.options.addDirs } : {}),
    };
    if (this.options.sessionId && this.initValue?.agentCapabilities?.loadSession === true) {
      try {
        const loaded = await this.withSignal(agent.request(methods.agent.session.load, { sessionId: this.options.sessionId, ...request }), signal) as { configOptions?: unknown; modes?: unknown } | void;
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
    if (!Array.isArray(configOptions)) return;
    const options = configOptions as Array<{ id?: unknown; options?: Array<{ value?: unknown }>; currentValue?: unknown }>;
    const desired: Array<{ ids: string[]; value: string | undefined }> = [
      { ids: ["model"], value: this.options.model },
      { ids: ["effort", "thought_level", "reasoning_effort"], value: this.options.effort },
      { ids: ["mode"], value: this.options.mode === "accept-edits" ? "auto_edit" : this.options.mode === "plan" ? "default" : this.options.mode },
    ];
    for (const item of desired) {
      if (!item.value) continue;
      const option = options.find((candidate) => item.ids.includes(String(candidate.id)));
      if (!option) continue;
      const values = Array.isArray(option.options) ? option.options.map((entry) => String(entry.value)) : [];
      const baseValue = item.value.replace(/-(?:low|medium|high|thinking)$/i, "");
      const value = values.length
        ? values.find((entry) => entry === item.value || entry === baseValue || entry.toLowerCase() === item.value!.toLowerCase() || entry.toLowerCase() === baseValue.toLowerCase())
        : item.value;
      if (!value || (values.length > 0 && !values.includes(value))) {
        throw new AgyError("unknown_model", `The ACP session does not support the requested ${String(option.id)} value`, {
          code: "agy_acp_config_value",
          details: { configId: String(option.id), available: values },
        });
      }
      await this.withSignal(agent.request(methods.agent.session.setConfigOption, {
        sessionId: this.sessionIdValue,
        configId: String(option.id),
        value,
      }), signal);
    }
  }

  private onSessionUpdate(params: SessionNotification): void {
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
      });
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
      for (const terminal of this.terminals.values()) {
        if (terminal.child.exitCode === null) terminateProcess(terminal.child);
      }
      this.terminals.clear();
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
      debug("official Antigravity ACP worker stopped", { force });
    })();
    return this.closePromise;
  }

  async restart(options: AcpWorkerOptions, executable = this.executable): Promise<AcpWorker> {
    await this.stop();
    const worker = new AcpWorker(options, executable);
    await worker.start();
    return worker;
  }

  private async requestPermission(params: import("@agentclientprotocol/sdk").RequestPermissionRequest): Promise<import("@agentclientprotocol/sdk").RequestPermissionResponse> {
    const policy = this.options.permissionPolicy ?? (process.env.OPENCODE_ANTIGRAVITY_ACP_PERMISSION ?? "allow-always");
    if (policy === "deny") {
      const option = params.options.find((candidate) => candidate.kind === "reject_once" || candidate.kind === "reject_always");
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    const preferred = policy === "allow-always" ? "allow_always" : "allow_once";
    const option = params.options.find((candidate) => candidate.kind === preferred) ?? params.options.find((candidate) => safeOptionKind(candidate.kind));
    if (!option) return { outcome: { outcome: "cancelled" } };
    info("auto-approved ACP tool permission", { kind: params.toolCall.kind, status: params.toolCall.status });
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  private async readTextFile(params: import("@agentclientprotocol/sdk").ReadTextFileRequest): Promise<import("@agentclientprotocol/sdk").ReadTextFileResponse> {
    const path = await this.allowedPath(params.path, false);
    const content = await readFile(path, "utf8");
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, (params.line ?? 1) - 1);
    const selected = params.limit === undefined || params.limit === null ? lines.slice(start) : lines.slice(start, start + Math.max(0, params.limit));
    return { content: selected.join("\n") };
  }

  private async writeTextFile(params: import("@agentclientprotocol/sdk").WriteTextFileRequest): Promise<import("@agentclientprotocol/sdk").WriteTextFileResponse> {
    const path = await this.allowedPath(params.path, true);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, { encoding: "utf8", mode: 0o600 });
    return {};
  }

  private async allowedPath(path: string, write: boolean): Promise<string> {
    if (!isAbsolute(path)) throw new AgyError("invalid_request", "ACP file paths must be absolute", { code: "agy_acp_path" });
    const candidate = resolve(path);
    let check = candidate;
    if (write) {
      while (true) {
        try { check = await realpath(check); break; } catch {
          const parent = dirname(check);
          if (parent === check) throw new AgyError("unsupported", "The ACP path has no accessible parent", { code: "agy_acp_path" });
          check = parent;
        }
      }
    } else {
      check = await realpath(candidate);
    }
    const roots = await Promise.all(this.roots.map((root) => realpath(root).catch(() => resolve(root))));
    if (!roots.some((root) => check === root || !relative(root, check).startsWith(`..${sep}`) && relative(root, check) !== "..")) {
      throw new AgyError("unsupported", "The ACP agent requested a path outside the configured workspace", { code: "agy_acp_path_boundary" });
    }
    return candidate;
  }

  private async createTerminal(params: import("@agentclientprotocol/sdk").CreateTerminalRequest): Promise<import("@agentclientprotocol/sdk").CreateTerminalResponse> {
    const cwd = await this.allowedPath(params.cwd ?? this.options.cwd, false);
    const child = spawn(params.command, params.args ?? [], {
      cwd,
      env: this.terminalEnvironment(params.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const terminalId = `terminal_${Math.random().toString(36).slice(2, 14)}`;
    const record: TerminalRecord = {
      child,
      output: "",
      truncated: false,
      outputLimit: Math.max(1_024, params.outputByteLimit ?? 512 * 1024),
      closed: Promise.resolve(),
    };
    const append = (chunk: Buffer | string) => {
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const next = `${record.output}${value}`;
      if (Buffer.byteLength(next, "utf8") <= record.outputLimit) record.output = next;
      else {
        record.truncated = true;
        const bytes = Buffer.from(next, "utf8").subarray(-record.outputLimit);
        record.output = bytes.toString("utf8");
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    record.closed = new Promise<void>((resolveClosed) => child.once("close", (code, signal) => {
      record.exitStatus = { exitCode: code, signal };
      resolveClosed();
    }));
    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  private terminalEnvironment(entries: Array<{ name: string; value: string }> | undefined): NodeJS.ProcessEnv {
    const sensitive = /(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE|PRIVATE_KEY)/i;
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitive.test(name)));
    for (const entry of entries ?? []) {
      if (!sensitive.test(entry.name)) inherited[entry.name] = entry.value;
    }
    return inherited;
  }

  private terminal(params: { terminalId: string }): TerminalRecord {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) throw new AgyError("invalid_request", "Unknown ACP terminal", { code: "agy_acp_terminal" });
    return terminal;
  }

  private async terminalOutput(params: import("@agentclientprotocol/sdk").TerminalOutputRequest): Promise<import("@agentclientprotocol/sdk").TerminalOutputResponse> {
    const terminal = this.terminal(params);
    return { output: terminal.output, truncated: terminal.truncated, ...(terminal.exitStatus ? { exitStatus: terminal.exitStatus } : {}) };
  }

  private async waitForTerminal(params: import("@agentclientprotocol/sdk").WaitForTerminalExitRequest): Promise<import("@agentclientprotocol/sdk").WaitForTerminalExitResponse> {
    const terminal = this.terminal(params);
    await terminal.closed;
    return {
      exitCode: terminal.exitStatus?.exitCode ?? null,
      signal: terminal.exitStatus?.signal ?? null,
    };
  }

  private async killTerminal(params: import("@agentclientprotocol/sdk").KillTerminalRequest): Promise<import("@agentclientprotocol/sdk").KillTerminalResponse> {
    const terminal = this.terminal(params);
    if (terminal.child.exitCode === null && terminal.child.signalCode === null) terminateProcess(terminal.child);
    return {};
  }

  private async releaseTerminal(params: import("@agentclientprotocol/sdk").ReleaseTerminalRequest): Promise<import("@agentclientprotocol/sdk").ReleaseTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (terminal && terminal.child.exitCode === null && terminal.child.signalCode === null) terminateProcess(terminal.child);
    this.terminals.delete(params.terminalId);
    return {};
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
  await bridgeCliAuthentication({
    ...process.env,
    ...options.environment,
    ...(options.authMethod ? { OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD: options.authMethod } : {}),
  });
  const detection = options.executable
    ? { executable: options.executable, args: options.executableArgs }
    : await ensureAcpServer();
  const worker = new AcpWorker({
    ...options,
    executableArgs: options.executableArgs ?? detection.args,
    printTimeoutMs: options.printTimeoutMs ?? configuredPrintTimeoutMs(),
  }, detection.executable);
  await worker.start(signal);
  return worker;
}

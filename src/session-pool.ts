import { createHash, randomUUID } from "node:crypto";
import { AcpWorker, createAcpWorker, type AcpWorkerOptions } from "./acp-process.js";
import {
  AgyAbortError,
  AgyBusyError,
  AgyError,
  AgyProcessError,
} from "./errors.js";
import {
  DEFAULT_IDLE_WORKER_TIMEOUT_MS,
  DEFAULT_MAX_QUEUE_PER_SESSION,
  DEFAULT_MAX_SESSIONS,
  envNumber,
  type AcpEffort,
} from "./constants.js";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { AcpEvent } from "./acp-process.js";
import { buildBoundedHistory } from "./prompt.js";
import { sessionStore, type SessionRecord } from "./session-store.js";
import { debug, info, warn } from "./log.js";

export type SessionSettings = {
  cwd: string;
  model: string;
  effort?: AcpEffort;
  mode?: "accept-edits" | "plan";
  cliVersion?: string | null;
  executable?: string;
};

export type SessionTurnRequest = {
  key: string;
  requestId?: string;
  prompt: ContentBlock[];
  priorMessages?: Array<{ role?: unknown; content?: unknown }>;
  settings: SessionSettings;
  signal?: AbortSignal;
};

type SessionEntry = {
  worker?: AcpWorker;
  settingsSignature?: string;
  tail: Promise<void>;
  pending: number;
  lastUsedAt: number;
  record?: SessionRecord;
  turnCount: number;
  historyTransferred: boolean;
};

function settingsSignature(settings: SessionSettings): string {
  return JSON.stringify({
    cwd: settings.cwd,
    model: settings.model,
    effort: settings.effort ?? null,
    mode: settings.mode ?? null,
  });
}

function waitForPrevious(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(new AgyAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new AgyAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function combineSignals(left: AbortSignal | undefined, right: AbortSignal): AbortSignal {
  if (!left) return right;
  if (left.aborted || right.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function workerOptions(settings: SessionSettings, sessionId?: string): AcpWorkerOptions {
  return {
    cwd: settings.cwd,
    executable: settings.executable,
    model: settings.model,
    effort: settings.effort,
    sessionId,
    mode: settings.mode,
  };
}

export class SessionPool {
  private entries = new Map<string, SessionEntry>();
  private readonly maxQueue: number;
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private lifecycleController = new AbortController();

  constructor(options: { maxQueue?: number; idleMs?: number } = {}) {
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? envNumber("OPENCODE_ANTIGRAVITY_MAX_QUEUE", DEFAULT_MAX_QUEUE_PER_SESSION, 0)));
    this.maxSessions = Math.max(1, Math.floor(envNumber("OPENCODE_ANTIGRAVITY_MAX_SESSIONS", DEFAULT_MAX_SESSIONS, 1)));
    this.idleMs = options.idleMs ?? envNumber("OPENCODE_ANTIGRAVITY_IDLE_WORKER_MS", DEFAULT_IDLE_WORKER_TIMEOUT_MS, 1_000);
    this.open();
  }

  open(): void {
    if (!this.disposed && this.cleanupTimer) return;
    this.disposed = false;
    this.lifecycleController = new AbortController();
    this.cleanupTimer = setInterval(() => void this.cleanup(), Math.min(this.idleMs, 60_000));
    this.cleanupTimer.unref?.();
  }

  get size(): number {
    return this.entries.size;
  }

  async *turn(request: SessionTurnRequest): AsyncGenerator<AcpEvent> {
    if (this.disposed) throw new AgyProcessError("The Antigravity session pool has been shut down");
    let entry = this.entries.get(request.key);
    if (!entry) {
      if (this.entries.size >= this.maxSessions) throw new AgyBusyError("The Antigravity session pool has reached its session limit");
      entry = { tail: Promise.resolve(), pending: 0, lastUsedAt: Date.now(), turnCount: 0, historyTransferred: false };
      this.entries.set(request.key, entry);
    }
    if (entry.pending > this.maxQueue) throw new AgyBusyError();
    entry.pending += 1;
    entry.lastUsedAt = Date.now();
    const signal = combineSignals(request.signal, this.lifecycleController.signal);
    let release!: () => void;
    const previous = entry.tail.catch(() => undefined);
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForPrevious(previous, signal);
      if (this.disposed) throw new AgyProcessError("The Antigravity session pool has been shut down");
      if (signal.aborted) throw new AgyAbortError();
      const unlock = await sessionStore.lockTurn(request.key);
      try {
        if (signal.aborted) throw new AgyAbortError();
        const identity = request.requestId || createHash("sha256").update(JSON.stringify({
          prior: request.priorMessages, prompt: request.prompt,
        })).digest("hex");
        const receipt = await sessionStore.receipt(request.key, identity);
        if (receipt) {
          if (receipt.state === "completed" && receipt.events) { yield* receipt.events; return; }
          throw new AgyError("invalid_request", "This request already started in Antigravity. Send a new message to continue; retrying could repeat workspace changes.", { code: "agy_request_already_started", status: 409 });
        }
        yield* this.runTurn(entry, { ...request, signal }, identity);
      } finally { await unlock(); }
    } finally {
      void previous.then(release);
      entry.pending = Math.max(0, entry.pending - 1);
      entry.lastUsedAt = Date.now();
    }
  }

  private async *runTurn(entry: SessionEntry, request: SessionTurnRequest, identity: string): AsyncGenerator<AcpEvent> {
    const signature = settingsSignature(request.settings);
    const record = await sessionStore.get(request.key);
    // Another process may have advanced or replaced this session since our
    // last turn. Reload it instead of using a stale in-memory ACP worker.
    if (entry.worker && JSON.stringify(entry.record) !== JSON.stringify(record)) {
      await entry.worker.stop();
      entry.worker = undefined;
      entry.settingsSignature = undefined;
      entry.historyTransferred = false;
    }
    entry.record = record;
    if (entry.worker && (entry.worker.state === "closed" || entry.worker.state === "failed")) {
      entry.worker = undefined;
      entry.settingsSignature = undefined;
      entry.historyTransferred = false;
    }
    if (entry.worker && entry.settingsSignature !== signature) {
      await this.persistWorkerSafe(entry, request.key, request.settings);
      await entry.worker.stop();
      entry.worker = undefined;
      entry.settingsSignature = undefined;
      entry.historyTransferred = false;
    }
    if (!entry.worker) {
      const sessionId = record?.sessionId;
      entry.worker = await createAcpWorker(workerOptions(request.settings, sessionId), request.signal);
      entry.settingsSignature = signature;
      const workerSession = entry.worker.sessionId;
      if (workerSession) await this.persistWorkerSafe(entry, request.key, request.settings);
      info("created Antigravity ACP session worker", { resumed: Boolean(sessionId), poolSize: this.entries.size });
    }

    const history = !entry.worker.resumed && !entry.historyTransferred && request.priorMessages?.length
      ? buildBoundedHistory(request.priorMessages)
      : "";
    const prompt: ContentBlock[] = history
      ? [{ type: "text", text: `${history}\n\n<current-user-message>` }, ...request.prompt, { type: "text", text: "</current-user-message>" }]
      : request.prompt;
    // This write must succeed before sending a prompt that can change files.
    await sessionStore.saveReceipt(request.key, identity, { state: "started" });
    if (history) entry.historyTransferred = true;
    const events: AcpEvent[] = [];
    let bytes = 0;
    let cacheable = true;
    try {
      for await (const event of entry.worker.runTurn(prompt, request.signal)) {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes <= 2_000_000) events.push(event);
        else { cacheable = false; events.length = 0; }
        if (event.event === "result" && event.result.stopReason !== "cancelled") {
          // Persist before exposing success, including when the consumer stops
          // reading immediately after the terminal event.
          await sessionStore.saveReceipt(request.key, identity, {
            state: "completed", ...(cacheable ? { events } : {}),
          });
        }
        yield event;
      }
    } catch (error) {
      // Do not retry a process failure: the prompt may have been accepted by
      // the remote agent. The next user turn can resume the saved id.
      if (error instanceof AgyError) throw error;
      throw new AgyProcessError("The Antigravity ACP turn failed", error);
    }

    entry.turnCount += 1;
    await this.persistWorkerSafe(entry, request.key, request.settings);
  }

  private async persistWorkerSafe(entry: SessionEntry, key: string, settings: SessionSettings): Promise<void> {
    try {
      await this.persistWorker(entry, key, settings);
    } catch (error) {
      // A metadata filesystem failure must not turn a completed remote turn
      // into a fake assistant failure. Resume may be unavailable next time;
      // the current response remains authoritative.
      warn("could not persist Antigravity ACP session metadata", { code: error && typeof error === "object" ? (error as { code?: unknown }).code : undefined });
    }
  }

  private async persistWorker(entry: SessionEntry, key: string, settings: SessionSettings): Promise<void> {
    const worker = entry.worker;
    const sessionId = worker?.sessionId ?? entry.record?.sessionId;
    if (!sessionId) return;
    const now = Date.now();
    const previous = entry.record;
    const record: SessionRecord = {
      sessionId,
      revision: randomUUID(),
      model: settings.model,
      ...(settings.effort ? { effort: settings.effort } : {}),
      cwd: settings.cwd,
      cliVersion: settings.cliVersion ?? previous?.cliVersion ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: now,
    };
    entry.record = record;
    await sessionStore.set(key, record);
  }

  async cleanup(): Promise<void> {
    if (this.disposed) return;
    const threshold = Date.now() - this.idleMs;
    for (const [key, entry] of this.entries) {
      if (entry.pending === 0 && entry.lastUsedAt < threshold) {
        this.entries.delete(key);
        await entry.worker?.stop();
        debug("cleaned up idle Antigravity ACP worker", { poolSize: this.entries.size });
      }
    }
    try {
      await sessionStore.prune(undefined, new Set([...this.entries].filter(([, entry]) => entry.pending > 0).map(([key]) => key)));
    } catch (error) {
      warn("could not prune Antigravity ACP session metadata", { code: error && typeof error === "object" ? (error as { code?: unknown }).code : undefined });
    }
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleController.abort();
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    const workers = [...this.entries.values()].map((entry) => entry.worker?.stop());
    await Promise.all(workers);
    this.entries.clear();
  }

  async forget(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry?.pending) throw new AgyBusyError("Cannot forget an active Antigravity session");
    const unlock = await sessionStore.lockTurn(key);
    try {
      await entry?.worker?.stop();
      this.entries.delete(key);
      await sessionStore.delete(key);
    } finally { await unlock(); }
  }

  async status(key: string): Promise<Record<string, unknown>> {
    const entry = this.entries.get(key);
    const record = entry?.record ?? await sessionStore.get(key);
    return {
      active: Boolean(entry?.pending),
      workerState: entry?.worker?.state ?? "none",
      hasSession: Boolean(record?.sessionId || entry?.worker?.sessionId),
      turns: entry?.turnCount ?? 0,
    };
  }
}

export const sessionPool = new SessionPool();

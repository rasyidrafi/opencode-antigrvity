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
import { buildBoundedHistory, extractTextContent, messageContentToAcp, hostResultMessageToAcp, type HostMessage } from "./prompt.js";
import { canonical, extendsBoundary, fingerprints, type ConversationState } from "./coordinator.js";
import { ownershipKey, sessionStore, type SessionRecord } from "./session-store.js";
import { debug, info, warn } from "./log.js";
import { collectTurn, hostVisibleContent } from "./translate.js";
import { blockBudget, historyCharacterLimit } from "./budget.js";
import { materializeMedia, validateMediaBlocks, type MediaMaterializationBudget } from "./attachments.js";
import { reconstruct, type ReconstructionGroup } from "./reconstruction.js";
import { observeContext, publishContextSnapshot } from "./telemetry.js";

export type SessionSettings = {
  cwd: string;
  model: string;
  outputBudget?: number;
  effort?: AcpEffort;
  mode?: "accept-edits" | "plan";
  cliVersion?: string | null;
  executable?: string;
  catalogScope?: string;
  hostTools?: boolean;
  mcpServers?: AcpWorkerOptions["mcpServers"];
  waitingForTools?: () => boolean;
  hasToolActivity?: () => boolean;
};

export type SessionTurnRequest = {
  key: string;
  requestId?: string;
  prompt: ContentBlock[];
  priorMessages?: Array<{ role?: unknown; content?: unknown }>;
  settings: SessionSettings;
  signal?: AbortSignal;
  instructions?: string;
  messages?: HostMessage[];
  hostSessionID?: string;
  responseCursor?: { start: number; events: number };
  identity?: { value?: string };
  suppressToolTelemetry?: boolean;
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
  conversation?: ConversationState;
  executionGeneration?: string;
};

function settingsSignature(settings: SessionSettings): string {
  return JSON.stringify({
    cwd: settings.cwd,
    model: settings.model,
    effort: settings.effort ?? null,
    mode: settings.mode ?? null,
    catalogScope: settings.catalogScope,
    mcpServers: settings.mcpServers,
    hostTools: settings.hostTools,
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
  return AbortSignal.any([left, right]);
}

function workerOptions(settings: SessionSettings, sessionId?: string): AcpWorkerOptions {
  return {
    cwd: settings.cwd,
    executable: settings.executable,
    catalogScope: settings.catalogScope,
    model: settings.model,
    effort: settings.effort,
    sessionId,
    mode: settings.mode,
    hostTools: settings.hostTools,
    mcpServers: settings.mcpServers,
    waitingForTools: settings.waitingForTools,
  };
}

async function reconstructionBlocks(message: HostMessage, cwd: string, budget: MediaMaterializationBudget): Promise<ContentBlock[]> {
  if (message.role === "system") return [{ type: "text", text: `<instruction-update>\n${extractTextContent(message.content)}\n</instruction-update>` }];
  if (message.role === "user" && Array.isArray(message.content) && message.content.some((p: any) => p?.type === "tool_result")) return hostResultMessageToAcp(message, [cwd], budget);
  if (message.role === "user" && (!Array.isArray(message.content) || message.content.every((p: any) => !["tool_result", "tool_use"].includes(p?.type)))) return [{ type: "text", text: "[user]" }, ...await messageContentToAcp(message.content, [cwd], budget)];
  return [{ type: "text", text: buildBoundedHistory([message], Number.MAX_SAFE_INTEGER) }];
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
  get capacity(): number { return this.maxSessions; }

  async *turn(request: SessionTurnRequest): AsyncGenerator<AcpEvent> {
    if (request.hostSessionID && await sessionStore.isHostDeleted(request.hostSessionID)) throw new AgyError("invalid_request", "This host session was deleted; late requests cannot recreate its execution state");
    if (this.disposed) throw new AgyProcessError("The Antigravity session pool has been shut down");
    let entry = this.entries.get(request.key);
    if (!entry) {
      if (this.entries.size >= this.maxSessions) {
        const idle = [...this.entries].filter(([, value]) => value.pending === 0).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
        if (idle) await this.forgetWorker(idle[0]);
      }
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
      const unlock = await sessionStore.lockTurn(ownershipKey(request.key, request.hostSessionID));
      try {
        if (signal.aborted) throw new AgyAbortError();
        const identity = request.requestId || createHash("sha256").update(canonical({
          prior: request.priorMessages, prompt: request.prompt,
          messages: request.messages ? fingerprints(request.messages) : undefined,
          instructions: request.instructions, model: request.settings.model,
        })).digest("hex");
        const receipt = await sessionStore.receipt(request.key, identity);
        if (receipt && receipt.state !== "rejected-before-execution" && receipt.state !== "prepared") {
          if (receipt.state === "completed" && receipt.events) { yield* receipt.events; return; }
          if (receipt.state === "completed") throw new AgyError("invalid_request", "This Antigravity request completed, but its response payload is unavailable. It cannot be executed again.", { code: "agy_completed_response_unavailable" });
          throw new AgyError("invalid_request", "This request already started in Antigravity. Send a new message to continue; retrying could repeat workspace changes.", { code: "agy_request_already_started" });
        }
        if (request.identity) request.identity.value = identity;
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
    const profile = createHash("sha256").update(signature).digest("hex");
    const record = await sessionStore.get(request.key);
    const incoming = request.messages ? fingerprints(request.messages) : undefined;
    const accepted = record?.conversation ?? entry.conversation;
    const aligned = request.messages ? Boolean(incoming && accepted?.resumable && record?.executionProfile === profile && extendsBoundary(accepted.boundary, incoming)) : Boolean(entry.worker && entry.settingsSignature === signature);
    if (!aligned && request.hostSessionID && await sessionStore.executionBinding(request.hostSessionID)) {
      // Retire provenance before startup, including failed replacements.
      entry.executionGeneration = randomUUID();
      await sessionStore.saveExecutionBinding(request.hostSessionID, { generation: entry.executionGeneration, sourceSessionID: "" });
      await publishContextSnapshot(request.hostSessionID);
    }
    if (entry.worker && !aligned) {
      await entry.worker.stop();
      entry.worker = undefined;
      entry.historyTransferred = false;
    }
    entry.conversation = aligned ? accepted : { version: 1, epoch: (accepted?.epoch ?? -1) + 1, boundary: [], instructions: request.instructions ?? "", hostSessionID: request.hostSessionID, resumable: false };
    // Another process may have advanced or replaced this session since our
    // last turn. Reload it instead of using a stale in-memory ACP worker.
    if (entry.worker && canonical(entry.record) !== canonical(record)) {
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
      const sessionId = aligned && record?.model === request.settings.model && record.effort === request.settings.effort ? record.sessionId : undefined;
      entry.worker = await createAcpWorker(workerOptions(request.settings, sessionId), request.signal);
      entry.settingsSignature = signature;
      if (!entry.worker.resumed) {
        entry.conversation = { version: 1, epoch: (accepted?.epoch ?? -1) + 1, boundary: [], instructions: request.instructions ?? "", hostSessionID: request.hostSessionID, resumable: false };
        entry.executionGeneration = randomUUID();
      } else entry.executionGeneration = record?.executionGeneration ?? randomUUID();
      const workerSession = entry.worker.sessionId;
      if (request.hostSessionID && workerSession) {
        await sessionStore.saveExecutionBinding(request.hostSessionID, { generation: entry.executionGeneration, sourceSessionID: workerSession });
        if (await sessionStore.contextSnapshot(request.hostSessionID)) await publishContextSnapshot(request.hostSessionID);
      }
      if (workerSession) await this.persistWorkerSafe(entry, request.key, request.settings);
      info("created Antigravity session worker", { resumed: entry.worker.resumed, rebuilt: !entry.worker.resumed, poolSize: this.entries.size });
    }
    const remoteAligned = aligned && Boolean(entry.worker.resumed || entry.historyTransferred);
    const historyLimit = historyCharacterLimit();

    let prompt: ContentBlock[] = [...request.prompt];
    if (!request.messages) {
      validateMediaBlocks(request.prompt);
      const mediaBudget = { remaining: Number.POSITIVE_INFINITY, signal: request.signal, inspect: true };
      const groups: ReconstructionGroup[] = [];
      if (!entry.worker.resumed && !entry.historyTransferred) {
        const prior = request.priorMessages ?? [];
        let queuedStart = 0;
        prior.forEach((message, index) => { if (message.role === "assistant") queuedStart = index + 1; });
        for (const [index, message] of prior.entries()) groups.push({ message, blocks: await reconstructionBlocks(message, request.settings.cwd, mediaBudget), operative: message.role === "system" || (message.role === "user" && index >= queuedStart) });
      }
      groups.push({ message: { role: "user" }, blocks: request.prompt, operative: true });
      prompt = reconstruct(groups, request.instructions ?? "", request.settings.model, historyLimit, request.settings.outputBudget);
    }
    if (request.messages) {
      const unseen = request.messages.slice(remoteAligned ? accepted!.boundary.length : 0);
      let currentUserIndex = -1;
      for (let index = 0; index < unseen.length; index++) if (unseen[index].role === "user") currentUserIndex = index;
      let queuedStart = aligned && accepted ? accepted.boundary.length - (remoteAligned ? accepted.boundary.length : 0) : 0;
      if (!aligned) for (let index = 0; index < unseen.length; index++) if (unseen[index].role === "assistant") queuedStart = index + 1;
      const groups: ReconstructionGroup[] = [];
      const mediaBudget = { remaining: Number.POSITIVE_INFINITY, signal: request.signal, inspect: true };
      for (const [index, message] of unseen.entries()) {
        const blocks = await reconstructionBlocks(message, request.settings.cwd, mediaBudget);
        groups.push({ blocks, message, operative: message.role === "system" || index === currentUserIndex || (message.role === "user" && index >= queuedStart) });
      }
      prompt = reconstruct(groups, request.instructions ?? "", request.settings.model, historyLimit, request.settings.outputBudget);
    }
    prompt = await materializeMedia(prompt, request.signal);
    if (request.instructions) prompt.unshift({ type: "text", text: request.instructions });
    // The alternate path must enforce the same independent transport/context cap.
    validateMediaBlocks(prompt);
    blockBudget(request.settings.model, prompt, request.settings.outputBudget);
    // This write must succeed before sending a prompt that can change files.
    await sessionStore.saveReceipt(request.key, identity, { state: "prepared" });
    if (entry.conversation) entry.conversation.resumable = false;
    await this.persistWorker(entry, request.key, request.settings);
    entry.historyTransferred = true;
    const events: AcpEvent[] = [];
    let bytes = 0;
    let cacheable = true;
    let terminal = false;
    let settledReceipt = false;
    let activity = false;
    try {
      await sessionStore.saveReceipt(request.key, identity, { state: "submitted" });
      for await (const event of entry.worker.runTurn(prompt, request.signal)) {
        if (!activity && event.event === "update") {
          activity = true;
          await sessionStore.saveReceipt(request.key, identity, { state: "running" });
        }
        if (request.hostSessionID && event.event === "update" && event.update.sessionUpdate === "usage_update") {
          await observeContext(request.hostSessionID, entry.conversation!.epoch, event.sessionId, request.settings.model, event.update, identity, entry.worker.actualModel, entry.executionGeneration);
        }
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes <= 2_000_000) events.push(event);
        else { cacheable = false; events.length = 0; }
        if (request.responseCursor) request.responseCursor.events = events.length;
        if (event.event === "result" && event.result.stopReason !== "cancelled") {
          const collected = cacheable ? await collectTurn((async function* () {
            for (const item of events.slice(request.responseCursor?.start ?? 0)) {
              if (request.suppressToolTelemetry && item.event === "update" && (item.update.sessionUpdate === "tool_call" || item.update.sessionUpdate === "tool_call_update")) continue;
              yield item;
            }
          })()) : undefined;
          const assistant = collected ? hostVisibleContent(collected.segments) : undefined;
          if (request.messages && entry.conversation) {
            entry.conversation.boundary = fingerprints([...request.messages, ...(assistant?.length ? [{ role: "assistant", content: assistant }] : [])]);
            entry.conversation.resumable = cacheable;
            await this.persistWorker(entry, request.key, request.settings);
          }
          // Persist before exposing success, including when the consumer stops
          // reading immediately after the terminal event.
          await sessionStore.saveReceipt(request.key, identity, {
            state: "completed", ...(cacheable ? { events } : {}),
          });
          terminal = true;
          settledReceipt = true;
        }
        if (event.event === "result" && event.result.stopReason === "cancelled") {
          await sessionStore.saveReceipt(request.key, identity, { state: "interrupted" });
          settledReceipt = true;
        }
        yield event;
      }
    } catch (error) {
      if (!terminal) await sessionStore.saveReceipt(request.key, identity, { state: error instanceof AgyError && error.details?.execution === "rejected-before-execution" && !activity && !entry.worker?.hasExecutionActivity && !request.settings.waitingForTools?.() && !request.settings.hasToolActivity?.() ? "rejected-before-execution" : error instanceof AgyAbortError ? "interrupted" : "uncertain" });
      settledReceipt = true;
      // Do not retry a process failure: the prompt may have been accepted by
      // the remote agent. The next user turn can resume the saved id.
      if (error instanceof AgyError) throw error;
      throw new AgyProcessError("The Antigravity turn failed", error);
    } finally {
      if (!settledReceipt) await sessionStore.saveReceipt(request.key, identity, { state: "uncertain" });
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
      warn("could not persist Antigravity session metadata", { code: error && typeof error === "object" ? (error as { code?: unknown }).code : undefined });
    }
  }

  private async persistWorker(entry: SessionEntry, key: string, settings: SessionSettings): Promise<void> {
    const worker = entry.worker;
    const sessionId = worker?.sessionId ?? entry.record?.sessionId;
    if (!sessionId) return;
    const now = Date.now();
    const previous = entry.record;
    const record: SessionRecord = {
      version: 1,
      executionGeneration: entry.executionGeneration,
      conversation: entry.conversation,
      executionProfile: createHash("sha256").update(settingsSignature(settings)).digest("hex"),
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
        debug("cleaned up idle Antigravity worker", { poolSize: this.entries.size });
      }
    }
    try {
      await sessionStore.prune(undefined, new Set([...this.entries].filter(([, entry]) => entry.pending > 0).map(([key]) => key)));
    } catch (error) {
      warn("could not prune Antigravity session metadata", { code: error && typeof error === "object" ? (error as { code?: unknown }).code : undefined });
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
    await sessionStore.delete(key);
    await entry?.worker?.stop();
    this.entries.delete(key);
  }

  /** Release an idle process while retaining the persisted ACP resume point. */
  async forgetWorker(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.pending) return;
    this.entries.delete(key);
    await entry.worker?.stop();
  }

  async quiesceHostSession(hostSessionID: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.conversation?.hostSessionID !== hostSessionID) continue;
      await entry.worker?.stop(true);
      if (entry.pending) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([entry.tail, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgyBusyError("The old ACP turn did not quiesce within the shutdown deadline")), 5000); })]);
        } finally { if (timer) clearTimeout(timer); }
      }
      if (!entry.pending) this.entries.delete(key);
    }
  }

  async retireCatalogScope(scope: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(`${scope}:`) && !key.startsWith(`host-v1:${scope}:`)) continue;
      await entry.worker?.stop(true);
      if (!entry.pending) this.entries.delete(key);
    }
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

const runtimeOwner = globalThis as typeof globalThis & { __agySessionPoolV1?: SessionPool };
export const sessionPool = runtimeOwner.__agySessionPoolV1 ??= new SessionPool();

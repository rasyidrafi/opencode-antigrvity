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
import { sessionStore, type SessionRecord } from "./session-store.js";
import { debug, info, warn } from "./log.js";
import { collectTurn, hostVisibleContent } from "./translate.js";
import { blockBytes, boundHistoricalBlocks, HISTORY_OMISSION, modelTranscriptBudget } from "./budget.js";
import { DEFAULT_HISTORY_MAX_CHARS } from "./constants.js";
import { observeContext } from "./telemetry.js";

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
      const unlock = await sessionStore.lockTurn(request.hostSessionID ? `host:${request.hostSessionID}` : request.key);
      try {
        if (signal.aborted) throw new AgyAbortError();
        const identity = request.requestId || createHash("sha256").update(canonical({
          prior: request.priorMessages, prompt: request.prompt,
          messages: request.messages ? fingerprints(request.messages) : undefined,
          hostEpoch: request.hostSessionID ? (await sessionStore.lifecycle(request.hostSessionID)).epoch : 0,
          instructions: request.instructions, model: request.settings.model,
        })).digest("hex");
        const legacyIdentity = request.requestId || createHash("sha256").update(JSON.stringify({ prior: request.priorMessages, prompt: request.prompt, instructions: request.instructions, model: request.settings.model })).digest("hex");
        const receipt = await sessionStore.receipt(request.key, identity);
        // Legacy hashes carry no epoch/boundary evidence. Preserve them only
        // as tombstones; never replay an unverified old response into a new
        // accepted host baseline.
        if (!receipt && identity !== legacyIdentity && await sessionStore.receipt(request.key, legacyIdentity)) throw new AgyError("invalid_request", "A legacy Antigravity receipt prevents replay without verified host alignment", { code: "agy_legacy_replay_tombstone" });
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
    const hostEpoch = request.hostSessionID ? (await sessionStore.lifecycle(request.hostSessionID)).epoch : 0;
    const aligned = request.messages ? Boolean(incoming && accepted?.resumable && record?.executionProfile === profile && accepted.hostEpoch === hostEpoch && extendsBoundary(accepted.boundary, incoming)) : Boolean(entry.worker && entry.settingsSignature === signature);
    if (entry.worker && !aligned) {
      await entry.worker.stop();
      entry.worker = undefined;
      entry.historyTransferred = false;
    }
    entry.conversation = aligned ? accepted : { version: 1, epoch: Math.max((accepted?.epoch ?? -1) + 1, hostEpoch), hostEpoch, boundary: [], instructions: request.instructions ?? "", hostSessionID: request.hostSessionID, resumable: false };
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
      const workerSession = entry.worker.sessionId;
      if (workerSession) await this.persistWorkerSafe(entry, request.key, request.settings);
      info("created Antigravity ACP session worker", { resumed: Boolean(sessionId), poolSize: this.entries.size });
    }

    const history = !entry.worker.resumed && !entry.historyTransferred && request.priorMessages?.length
      ? buildBoundedHistory(request.priorMessages)
      : "";
    let prompt: ContentBlock[] = history
      ? [{ type: "text", text: `${history}\n\n<current-user-message>` }, ...request.prompt, { type: "text", text: "</current-user-message>" }]
      : [...request.prompt];
    if (request.messages) {
      const unseen = request.messages.slice(aligned ? accepted!.boundary.length : 0);
      let currentUserIndex = -1;
      for (let index = 0; index < unseen.length; index++) if (unseen[index].role === "user") currentUserIndex = index;
      const groups: Array<{ blocks: ContentBlock[]; operative: boolean }> = [];
      for (const [index, message] of unseen.entries()) {
        let blocks: ContentBlock[];
        if (message.role === "system") blocks = [{ type: "text", text: `<instruction-update>\n${extractTextContent(message.content)}\n</instruction-update>` }];
        else if (message.role === "user" && Array.isArray(message.content) && message.content.some((p: any) => p?.type === "tool_result")) blocks = await hostResultMessageToAcp(message, [request.settings.cwd]);
        else if (message.role === "user" && (!Array.isArray(message.content) || message.content.every((p: any) => !["tool_result", "tool_use"].includes(p?.type)))) blocks = [{ type: "text", text: "[user]" }, ...await messageContentToAcp(message.content, [request.settings.cwd])];
        else blocks = [{ type: "text", text: buildBoundedHistory([message], Number.MAX_SAFE_INTEGER) }];
        groups.push({ blocks, operative: message.role === "system" || index === currentUserIndex || (aligned && message.role === "user") });
      }
      const fixed = [...(request.instructions ? [{ type: "text", text: request.instructions }] : []), ...groups.filter(group => group.operative).flatMap(group => group.blocks)];
      const marker: ContentBlock = { type: "text", text: HISTORY_OMISSION };
      let historyBytes = modelTranscriptBudget(request.settings.model, DEFAULT_HISTORY_MAX_CHARS, fixed.map(block => JSON.stringify(block)).join("\n"), request.settings.outputBudget) - blockBytes(marker);
      let omitted = false;
      prompt = groups.flatMap(group => {
        if (group.operative) return group.blocks;
        const bounded = boundHistoricalBlocks(group.blocks, historyBytes);
        historyBytes = bounded.remaining; omitted ||= bounded.omitted;
        return bounded.blocks;
      });
      if (omitted) prompt.unshift(marker);
    }
    if (request.instructions) prompt.unshift({ type: "text", text: request.instructions });
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
          await observeContext(request.hostSessionID, hostEpoch, event.sessionId, request.settings.model, event.update, identity, entry.worker.actualModel);
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
      throw new AgyProcessError("The Antigravity ACP turn failed", error);
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
      version: 1,
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
          await Promise.race([entry.tail, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AgyBusyError("The old ACP turn did not quiesce within the compaction deadline")), 5000); })]);
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

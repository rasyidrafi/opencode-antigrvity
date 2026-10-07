import { chmod, mkdir, open, readFile, readdir, rename, unlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_IDLE_WORKER_TIMEOUT_MS } from "./constants.js";
import { acquireFileLock } from "./file-lock.js";
import { AgyBusyError, AgyError } from "./errors.js";
import type { AcpEvent } from "./protocol.js";
import type { ContextSnapshot } from "./telemetry.js";
import { canonical, type ConversationState } from "./coordinator.js";
import { PAYLOAD_RETENTION_MS, pruneUtilityArtifacts } from "./retention.js";
import { ownershipKey } from "./ownership-key.js";
export { ownershipKey } from "./ownership-key.js";

export type SessionRecord = {
  executionGeneration?: string;
  version?: 1;
  conversation?: ConversationState;
  executionProfile?: string;
  sessionId: string;
  revision?: string;
  model: string;
  effort?: string;
  cwd: string;
  cliVersion: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
};

type DiskStore = Record<string, SessionRecord>;

export type ToolRecord = Record<string, unknown> & {
  version: 2; conversationKey: string;
  call: { id: string; name: string; input: Record<string, unknown>; type?: string };
  argumentsDigest: string; profile: string | null; profileDigest: string | null; hostSessionID: string | null;
  updatedAt: number; delivery?: "result-persisted" | "delivery-attempted" | "locally-handed-off";
  result?: { content: Record<string, unknown>[]; isError: boolean }; resultDigest?: string;
  epoch?: number; requestId?: string; payloadExpired?: boolean; emitted?: boolean;
};
function validateTool(value: any, key: string, id: string): asserts value is ToolRecord {
  const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  let validProfile = value?.profile === null && value?.profileDigest === null && value?.hostSessionID === null;
  if (typeof value?.profile === "string") {
    try {
      const parsed = JSON.parse(value.profile);
      validProfile = object(parsed) && typeof parsed.model === "string" && parsed.model.length > 0 &&
        (parsed.effort === undefined || typeof parsed.effort === "string") && Array.isArray(parsed.tools) &&
        parsed.tools.every((tool: any) => object(tool) && typeof tool.name === "string" && /^[\w.-]{1,128}$/.test(tool.name) && object(tool.input_schema)) &&
        parsed.tools.some((tool: any) => tool.name === value.call?.name) &&
        new Set(parsed.tools.map((tool: any) => tool.name)).size === parsed.tools.length &&
        canonical(parsed) === value.profile && value.profileDigest === digest(value.profile);
    } catch { validProfile = false; }
  }
  const validResult = value?.result === undefined || object(value.result) && typeof value.result.isError === "boolean" && Array.isArray(value.result.content) && value.result.content.every((part: any) => object(part) &&
    (part.type === "text" && typeof part.text === "string" || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string" && part.mimeType.startsWith("image/")));
  if (!object(value) || value.version !== 2 || value.conversationKey !== key || !key || !id ||
      !object(value.call) || value.call.id !== id || typeof value.call.name !== "string" || !value.call.name ||
      (value.call.type !== undefined && value.call.type !== "tool_use") ||
      !object(value.call.input) || value.argumentsDigest !== digest(canonical(value.call.input)) ||
      !validProfile || !validResult ||
      !(value.hostSessionID === null || typeof value.hostSessionID === "string" && value.hostSessionID.length > 0) ||
      !Number.isFinite(value.updatedAt) || value.updatedAt < 0 ||
      (value.epoch !== undefined && (!Number.isSafeInteger(value.epoch) || value.epoch < 0)) ||
      (value.requestId !== undefined && typeof value.requestId !== "string") ||
      (value.emitted !== undefined && typeof value.emitted !== "boolean") ||
      (value.payloadExpired !== undefined && typeof value.payloadExpired !== "boolean") ||
      (value.delivery !== undefined && !["result-persisted", "delivery-attempted", "locally-handed-off"].includes(value.delivery)) ||
      (value.resultDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.resultDigest)) ||
      (value.result !== undefined && value.resultDigest !== digest(canonical(value.result))) ||
      (value.delivery !== undefined && value.resultDigest === undefined) ||
      (value.resultDigest !== undefined && value.result === undefined && value.payloadExpired !== true)) {
    throw new AgyError("invalid_request", "Corrupt or unsupported durable tool record; execution cannot be retried", { code: "agy_tool_record_corrupt", retryable: false });
  }
}

function dataDirectory(): string {
  return process.env.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
    join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-antigravity");
}

function storePath(): string {
  return join(dataDirectory(), "sessions.json");
}

function validRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.sessionId === "string" &&
    typeof record.model === "string" &&
    typeof record.cwd === "string" &&
    (typeof record.cliVersion === "string" || record.cliVersion === null);
}

function sanitizeRecord(value: SessionRecord): SessionRecord {
  return {
    ...(typeof value.executionGeneration === "string" ? { executionGeneration: value.executionGeneration } : {}),
    ...(value.version === 1 && value.conversation?.version === 1 && Number.isSafeInteger(value.conversation.epoch) && value.conversation.epoch >= 0 && Array.isArray(value.conversation.boundary) && value.conversation.boundary.every(item => typeof item === "string") && typeof value.conversation.resumable === "boolean" ? { version: 1, conversation: value.conversation } : {}),
    sessionId: value.sessionId.slice(0, 200),
    ...(typeof value.executionProfile === "string" ? { executionProfile: value.executionProfile } : {}),
    ...(typeof value.revision === "string" ? { revision: value.revision } : {}),
    model: value.model.slice(0, 200),
    ...(value.effort ? { effort: value.effort.slice(0, 20) } : {}),
    cwd: value.cwd.slice(0, 4_000),
    cliVersion: value.cliVersion?.slice(0, 80) ?? null,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
    lastUsedAt: Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : Date.now(),
  };
}

export class SessionStore {
  async markHostDeleted(hostSessionID: string): Promise<void> {
    await atomicWrite(join(dataDirectory(), "deleted", `${digest(hostSessionID)}.json`), { version: 1, hostSessionID });
  }
  async deletedHosts(): Promise<string[]> {
    const root = join(dataDirectory(), "deleted");
    const hosts: string[] = [];
    for (const file of await readdir(root, { withFileTypes: true }).catch((error: any) => { if (error.code === "ENOENT") return []; throw error; })) {
      if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const path = join(root, file.name);
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (typeof value.hostSessionID !== "string" || `${digest(value.hostSessionID)}.json` !== file.name) throw new Error("Invalid deletion index");
        if (!value.cleaned && await this.isHostDeleted(value.hostSessionID)) hosts.push(value.hostSessionID);
      } catch { await quarantineJson(path, "invalid_deletion_index"); }
    }
    return hosts;
  }
  async isHostDeleted(hostSessionID: string): Promise<boolean> {
    const path = join(dataDirectory(), "deleted", `${digest(hostSessionID)}.json`);
    try { const value = JSON.parse(await readFile(path, "utf8")); if (value.version !== 1 || value.hostSessionID !== hostSessionID) throw new Error("Invalid deletion record"); return true; }
    catch (error: any) { if (error.code === "ENOENT") return false; await quarantineJson(path, "invalid_deletion"); throw error; }
  }

  /** Caller retires/join pumps first. Tombstone blocks late requests even if
   * another process still owns the turn and cleanup must be retried. */
  async removeHostSession(hostSessionID: string): Promise<void> {
    await this.markHostDeleted(hostSessionID);
    const unlockLifecycle = await this.lockTurn(`lifecycle-event:${hostSessionID}`, 5000);
    let unlock: (() => Promise<void>) | undefined;
    let unlockRecords: (() => Promise<void>) | undefined;
    try {
      unlock = await this.lockTurn(`host:${hostSessionID}`, 5000);
      unlockRecords = await this.lockTurn(`host-record:${hostSessionID}`, 5000);
      const keys = new Set((await this.entries()).filter(([, record]) => record.conversation?.hostSessionID === hostSessionID).map(([key]) => key));
      const index = join(dataDirectory(), "host-keys", `${digest(hostSessionID)}.json`);
      try {
        const indexed = JSON.parse(await readFile(index, "utf8"));
        if (!Array.isArray(indexed) || !indexed.every(key => typeof key === "string")) throw new Error("Invalid host key index");
        for (const key of indexed) keys.add(key);
      } catch (error: any) { if (error.code !== "ENOENT") { await quarantineJson(index, "invalid_host_key_index"); throw error; } }
      const tools = join(dataDirectory(), "tools");
      for (const entry of await readdir(tools, { withFileTypes: true }).catch((error: any) => { if (error.code === "ENOENT") return []; throw error; })) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        for (const file of await readdir(join(tools, entry.name))) {
          if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
          const path = join(tools, entry.name, file);
          let value;
          try { value = JSON.parse(await readFile(path, "utf8")); }
          catch (error) { if (error instanceof SyntaxError) { await quarantineJson(path, "invalid_tool_record"); await atomicWrite(path, { version: 2, corrupt: true }); continue; } throw error; }
          if (typeof value.conversationKey === "string" && digest(value.conversationKey) === entry.name && typeof value.call?.id === "string" && `${digest(value.call.id)}.json` === file) {
            const verified = await this.toolCall(value.conversationKey, value.call.id);
            if (verified?.hostSessionID === hostSessionID) keys.add(verified.conversationKey);
          } else { await quarantineJson(path, "invalid_tool_identity"); await atomicWrite(path, { version: 2, corrupt: true }); }
        }
      }
      for (const key of keys) {
        await rm(join(dataDirectory(), "tools", digest(key)), { recursive: true, force: true });
        await rm(join(dataDirectory(), "requests", digest(key)), { recursive: true, force: true });
      }
      await this.mutate(records => { for (const key of keys) delete records[key]; });
      for (const name of ["context", "execution", "host-keys"]) await rm(join(dataDirectory(), name, `${digest(hostSessionID)}.json`), { force: true });
      await atomicWrite(join(dataDirectory(), "deleted", `${digest(hostSessionID)}.json`), { version: 1, hostSessionID, cleaned: true });
    } finally { await unlockRecords?.(); await unlock?.(); await unlockLifecycle(); }
  }

  /** Retire only bindings that still belong to a lost event subscription. */
  async reconcileLostBinding(hostSessionID: string, expectedBindings: Array<[string, string | undefined]>, retire: () => Promise<void>): Promise<void> {
    const unlock = await this.lockTurn(`lifecycle-event:${hostSessionID}`, 5000);
    try {
      if (await this.isHostDeleted(hostSessionID)) return;
      const current = (await this.entries()).filter(([, record]) => record.conversation?.hostSessionID === hostSessionID);
      if (current.length > 0 && current.every(([key, record]) => expectedBindings.some(([oldKey, revision]) => oldKey === key && revision === record.revision))) await retire();
    } finally { await unlock(); }
  }
  async invalidateHostSession(hostSessionID: string): Promise<void> {
    await this.mutate(records => {
      for (const record of Object.values(records)) if (record.conversation?.hostSessionID === hostSessionID) record.conversation.resumable = false;
    });
  }
  async contextSnapshot(hostSessionID: string): Promise<ContextSnapshot | undefined> {
    try {
      const value = JSON.parse(await readFile(join(dataDirectory(), "context", `${digest(hostSessionID)}.json`), "utf8"));
      if (value.version !== 1 || value.hostSessionID !== hostSessionID || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !["measured", "unknown", "stale"].includes(value.state) || (value.state !== "unknown" && (typeof value.used !== "number" || !Number.isFinite(value.used) || value.used < 0 || typeof value.size !== "number" || !Number.isFinite(value.size) || value.size <= 0 || typeof value.observedAt !== "number" || !Number.isFinite(value.observedAt) || value.observedAt < 0))) throw new Error("Invalid context snapshot");
      return value;
    } catch (error: any) { if (error.code === "ENOENT") return undefined; await quarantineJson(join(dataDirectory(), "context", `${digest(hostSessionID)}.json`), "invalid_context_snapshot"); throw error; }
  }
  async saveContextSnapshot(hostSessionID: string, snapshot: ContextSnapshot): Promise<void> {
    await atomicWrite(join(dataDirectory(), "context", `${digest(hostSessionID)}.json`), snapshot);
  }
  async executionBinding(hostSessionID: string): Promise<{ generation: string; sourceSessionID: string } | undefined> {
    try {
      const value = JSON.parse(await readFile(join(dataDirectory(), "execution", `${digest(hostSessionID)}.json`), "utf8"));
      if (!value || typeof value.generation !== "string" || !value.generation || typeof value.sourceSessionID !== "string") throw new Error("Invalid execution binding");
      return value;
    }
    catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  }
  async saveExecutionBinding(hostSessionID: string, binding: { generation: string; sourceSessionID: string }): Promise<void> {
    await atomicWrite(join(dataDirectory(), "execution", `${digest(hostSessionID)}.json`), binding);
    const previous = await this.contextSnapshot(hostSessionID);
    if (previous && (previous.executionGeneration !== binding.generation || previous.sourceSessionID !== binding.sourceSessionID)) {
      // Invalidations are durable observations too: monotonically advance the
      // v1 sequence so consumers cannot mistake unknown for a duplicate sample.
      await this.saveContextSnapshot(hostSessionID, {
        version: 1, hostSessionID, epoch: previous.epoch,
        sequence: previous.sequence + 1, state: "unknown",
        executionGeneration: binding.generation, sourceSessionID: binding.sourceSessionID,
      });
    }
  }
  private async read(): Promise<DiskStore> {
    try {
      const parsed = JSON.parse(await readFile(storePath(), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid session metadata");
      if (!Object.values(parsed).every(validRecord)) throw new Error("Invalid session record; refusing unverified recovery");
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => validRecord(value))
        .map(([key, value]) => [key, sanitizeRecord(value as SessionRecord)]));
    } catch (error: any) {
      if (error.code === "ENOENT") return {};
      if (error instanceof SyntaxError || /^Invalid session/.test(error.message)) await quarantineJson(storePath(), "invalid_session_metadata");
      throw error;
    }
  }

  private async mutate(change: (records: DiskStore) => void | Promise<void>): Promise<void> {
    const unlock = await acquireFileLock(join(dataDirectory(), "sessions.lock"), 5_000);
    try {
      const records = await this.read();
      await change(records);
      await chmod(dataDirectory(), 0o700);
      await atomicWrite(storePath(), records);
    } finally { await unlock(); }
  }

  async get(key: string): Promise<SessionRecord | undefined> {
    return (await this.read())[key];
  }

  async set(key: string, record: SessionRecord): Promise<void> {
    const host = record.conversation?.hostSessionID;
    if (host) {
      if (await this.isHostDeleted(host)) throw new AgyError("invalid_request", "Host session has been deleted");
      const unlock = await this.lockTurn(`host-key-index:${host}`, 5000);
      const path = join(dataDirectory(), "host-keys", `${digest(host)}.json`);
      try {
        let keys: string[] = [];
        try { keys = JSON.parse(await readFile(path, "utf8")); if (!Array.isArray(keys) || !keys.every(key => typeof key === "string")) throw new Error("Invalid host key index"); }
        catch (error: any) { if (error.code !== "ENOENT") { await quarantineJson(path, "invalid_host_key_index"); throw error; } }
        await atomicWrite(path, [...new Set([...keys, key])]);
      } finally { await unlock(); }
    }
    await this.mutate(records => { records[key] = sanitizeRecord(record); });
  }

  async delete(key: string): Promise<void> {
    await this.mutate(async records => {
      const unlock = await this.lockTurn(ownershipKey(key, records[key]?.conversation?.hostSessionID));
      try {
        delete records[key];
      } finally { await unlock(); }
    });
  }

  async entries(): Promise<Array<[string, SessionRecord]>> {
    return Object.entries(await this.read());
  }

  async toolCall(key: string, id: string): Promise<ToolRecord | undefined> {
    const path = join(dataDirectory(), "tools", digest(key), `${digest(id)}.json`);
    const unlock = await this.lockTurn(`tool-record:${key}:${id}`, 5000);
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      validateTool(value, key, id);
      const binding = await this.get(key);
      if (binding?.conversation?.hostSessionID && value.hostSessionID !== binding.conversation.hostSessionID) throw new Error("Tool ownership conflicts with conversation binding");
      return value;
    } catch (error: any) { if (error.code === "ENOENT") return undefined; await quarantineJson(path, "invalid_tool_record"); await atomicWrite(path, { version: 2, conversationKey: key, callID: id, corrupt: true }); throw new AgyError("invalid_request", "Corrupt or unsupported durable tool record; execution cannot be retried", { code: "agy_tool_record_corrupt", retryable: false }); }
    finally { await unlock(); }
  }

  async saveToolCall(key: string, id: string, value: Record<string, unknown>): Promise<void> {
    const host = typeof value.hostSessionID === "string" ? value.hostSessionID : undefined;
    const release = host ? await this.lockTurn(`host-record:${host}`, 5000) : undefined;
    let unlock: (() => Promise<void>) | undefined;
    try {
      unlock = await this.lockTurn(`tool-record:${key}:${id}`, 5000);
      if (host && await this.isHostDeleted(host)) throw new AgyError("invalid_request", "Host session has been deleted");
      const record = { ...value, version: 2, conversationKey: key, hostSessionID: value.hostSessionID ?? null, profile: value.profile ?? null, profileDigest: value.profileDigest ?? (typeof value.profile === "string" ? digest(value.profile) : null), argumentsDigest: value.argumentsDigest ?? digest(canonical((value.call as any)?.input)), updatedAt: Date.now() };
      validateTool(record, key, id);
      await atomicWrite(join(dataDirectory(), "tools", digest(key), `${digest(id)}.json`), record);
    } finally { await unlock?.(); await release?.(); }
  }

  async saveToolResult(key: string, id: string, result: unknown): Promise<void> {
    const unlock = await this.lockTurn(`tool-result:${key}:${id}`, 5000);
    try {
    const call = await this.toolCall(key, id);
    if (!call) throw new AgyError("invalid_request", "Tool result has no durable originating call");
    const resultDigest = digest(canonical(result));
    if (call.resultDigest && call.resultDigest !== resultDigest) throw new AgyError("invalid_request", "Conflicting result for completed tool call");
    await this.saveToolCall(key, id, { ...call, result, resultDigest, delivery: call.delivery ?? "result-persisted", payloadExpired: false });
    } finally { await unlock(); }
  }

  async toolDelivery(key: string, id: string, delivery: "delivery-attempted" | "locally-handed-off"): Promise<void> {
    const unlock = await this.lockTurn(`tool-result:${key}:${id}`, 5000);
    try {
      const call = await this.toolCall(key, id);
      if (!call?.resultDigest) throw new AgyError("invalid_request", "Delivery requires a durable result");
      if (call.delivery === "locally-handed-off") return;
      if (delivery === "locally-handed-off" && call.delivery !== "delivery-attempted") throw new AgyError("invalid_request", "Delivery intent was not persisted");
      await this.saveToolCall(key, id, { ...call, delivery });
    } finally { await unlock(); }
  }

  async prune(maxIdleMs = DEFAULT_IDLE_WORKER_TIMEOUT_MS * 4, protectedKeys: ReadonlySet<string> = new Set()): Promise<void> {
    await this.pruneCompletedPayloads();
    await this.pruneCompletedToolPayloads(Date.now(), protectedKeys);
    await pruneUtilityArtifacts(dataDirectory());
    // Request receipts are kept independently: pruning idle metadata must not
    // make a previously submitted request executable again.
    await this.mutate(async records => {
      for (const [key, record] of Object.entries(records)) {
        if (protectedKeys.has(key) || record.lastUsedAt >= Date.now() - maxIdleMs) continue;
        let unlock: (() => Promise<void>) | undefined;
        try {
          unlock = await this.lockTurn(ownershipKey(key, record.conversation?.hostSessionID));
          delete records[key];
        } catch (error) {
          if (!(error instanceof AgyBusyError)) throw error;
        } finally { await unlock?.(); }
      }
    });
  }

  async pruneCompletedToolPayloads(now = Date.now(), protectedKeys: ReadonlySet<string> = new Set()): Promise<void> {
    const root = join(dataDirectory(), "tools");
    let directories: string[];
    try { directories = await readdir(root); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    for (const directory of directories.filter(name => /^[a-f0-9]{64}$/.test(name))) {
      for (const file of (await readdir(join(root, directory))).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const path = join(root, directory, file);
        let value;
        try { value = JSON.parse(await readFile(path, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Invalid tool record object"); }
        catch (error) { if (error instanceof SyntaxError) { await quarantineJson(path, "invalid_tool_record"); await atomicWrite(path, { version: 2, corrupt: true }); continue; } throw error; }
        const key = value.conversationKey;
        const id = value.call?.id;
        if (typeof key !== "string" || digest(key) !== directory || typeof id !== "string" || `${digest(id)}.json` !== file) {
          await quarantineJson(path, "invalid_tool_identity"); await atomicWrite(path, { version: 2, corrupt: true }); continue;
        }
        try { value = await this.toolCall(key, id); }
        catch (error) { if (error instanceof AgyError && error.code === "agy_tool_record_corrupt") continue; throw error; }
        if (!value) continue;
        // Old records without an originating receipt/key remain conservative
        // recovery evidence. Never expire parked/uncertain executions.
        if (typeof key !== "string" || digest(key) !== directory || typeof id !== "string" || protectedKeys.has(key) || typeof value.requestId !== "string" || !Number.isFinite(value.updatedAt) || value.updatedAt >= now - PAYLOAD_RETENTION_MS || !value.result || Buffer.byteLength(canonical(value.result)) < 64 * 1024) continue;
        let unlockTurn: (() => Promise<void>) | undefined;
        let unlockResult: (() => Promise<void>) | undefined;
        try {
          unlockTurn = await this.lockTurn(ownershipKey(key, value.hostSessionID ?? undefined));
          unlockResult = await this.lockTurn(`tool-result:${key}:${id}`);
          const current = await this.toolCall(key, id);
          if (!current?.result || typeof current.updatedAt !== "number" || current.updatedAt >= now - PAYLOAD_RETENTION_MS || (await this.receipt(key, value.requestId))?.state !== "completed") continue;
          delete current.result;
          // Keep call identity, arguments/result digests and profile forever.
          // Host-authoritative matching results can rehydrate this tombstone.
          await atomicWrite(path, { ...current, payloadExpired: true });
        } catch (error) { if (!(error instanceof AgyBusyError)) throw error; }
        finally { await unlockResult?.(); await unlockTurn?.(); }
      }
    }
  }

  async pruneCompletedPayloads(now = Date.now()): Promise<void> {
    const root = join(dataDirectory(), "requests");
    let directories: string[];
    try { directories = await readdir(root); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    for (const directory of directories.filter(name => /^[a-f0-9]{64}$/.test(name))) {
      for (const file of (await readdir(join(root, directory))).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const path = join(root, directory, file);
        let value;
        try { value = JSON.parse(await readFile(path, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Invalid receipt object"); }
        catch (error) { if (error instanceof SyntaxError) { await quarantineJson(path, "invalid_receipt"); continue; } throw error; }
        // Only terminal response payloads expire; calls/results and uncertain
        // work remain recovery evidence. Legacy records migrate conservatively.
        if (value.state !== "completed") continue;
        if (!Number.isFinite(value.updatedAt)) { value.updatedAt = now; await atomicWrite(path, value); }
        else if (value.events && value.updatedAt < now - PAYLOAD_RETENTION_MS && typeof value.conversationKey === "string" && digest(value.conversationKey) === directory) {
          let unlock: (() => Promise<void>) | undefined;
          try {
            unlock = await this.lockTurn(ownershipKey(value.conversationKey, typeof value.hostSessionID === "string" ? value.hostSessionID : undefined));
            const current = JSON.parse(await readFile(path, "utf8"));
            if (current.state === "completed" && current.updatedAt < now - PAYLOAD_RETENTION_MS) { delete current.events; await atomicWrite(path, current); }
          } catch (error) { if (!(error instanceof AgyBusyError)) throw error; }
          finally { await unlock?.(); }
        }
      }
    }
  }

  async clear(): Promise<void> {
    await this.mutate(records => { for (const key of Object.keys(records)) delete records[key]; });
  }

  async lockTurn(key: string, waitMs = 0): Promise<() => Promise<void>> {
    return acquireFileLock(join(dataDirectory(), "turns", `${digest(key)}.lock`), waitMs);
  }

  async receipt(key: string, request: string): Promise<RequestReceipt | undefined> {
    try {
      const value = JSON.parse(await readFile(receiptPath(key, request), "utf8"));
      if (!["started", "prepared", "submitted", "running", "parked", "completed", "rejected-before-execution", "interrupted", "uncertain"].includes(value?.state)) throw new Error("Invalid request receipt");
      if (value.state === "completed" && value.events && Number.isFinite(value.updatedAt) && value.updatedAt < Date.now() - PAYLOAD_RETENTION_MS) {
        delete value.events;
        await atomicWrite(receiptPath(key, request), value);
      }
      return value;
    } catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      if (error instanceof SyntaxError || error.message === "Invalid request receipt") {
        await quarantineJson(receiptPath(key, request), "invalid_receipt");
        // Keep a durable fail-closed tombstone at the original identity. Moving
        // corruption away alone would wrongly authorize another execution.
        await atomicWrite(receiptPath(key, request), { version: 1, state: "uncertain", updatedAt: Date.now() });
      }
      throw error;
    }
  }

  async saveReceipt(key: string, request: string, receipt: RequestReceipt): Promise<void> {
    const hostSessionID = (await this.get(key))?.conversation?.hostSessionID;
    await atomicWrite(receiptPath(key, request), { version: 1, ...receipt, conversationKey: key, ...(hostSessionID ? { hostSessionID } : {}), updatedAt: Date.now() });
  }

}

export const sessionStore = new SessionStore();

export function sessionStoreDirectory(): string {
  return dataDirectory();
}

export type RequestReceipt = { state: "started" | "prepared" | "submitted" | "running" | "parked" | "completed" | "rejected-before-execution" | "interrupted" | "uncertain"; events?: AcpEvent[] };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function quarantineJson(path: string, reason: string): Promise<void> {
  const raw = await readFile(path, "utf8");
  // Deduplicate repeated reads of the same corruption. Keep the original in
  // place unless replaced with a fail-closed tombstone, never an absent record.
  await atomicWrite(join(dataDirectory(), "quarantine", `${digest(path + raw)}.json`), { raw, reason });
}
function receiptPath(key: string, request: string): string {
  return join(dataDirectory(), "requests", digest(key), `${digest(request)}.json`);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value), "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    // Persist the rename and newly created private directory entries before
    // exposing calls/results. Atomic rename alone is not power-loss durability.
    const stop = dirname(resolve(dataDirectory()));
    for (let directory = dirname(resolve(path)); ; directory = dirname(directory)) {
      const handle = await open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      if (directory === stop || directory === dirname(directory)) break;
    }
  } finally { await unlink(temporary).catch(() => undefined); }
}

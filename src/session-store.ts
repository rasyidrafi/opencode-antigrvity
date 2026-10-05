import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_IDLE_WORKER_TIMEOUT_MS } from "./constants.js";
import { acquireFileLock } from "./file-lock.js";
import { AgyBusyError } from "./errors.js";
import type { AcpEvent } from "./protocol.js";

export type SessionRecord = {
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
    sessionId: value.sessionId.slice(0, 200),
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
  private async read(): Promise<DiskStore> {
    try {
      const parsed = JSON.parse(await readFile(storePath(), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid session metadata");
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => validRecord(value))
        .map(([key, value]) => [key, sanitizeRecord(value as SessionRecord)]));
    } catch (error: any) {
      if (error.code === "ENOENT") return {};
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
    await this.mutate(records => { records[key] = sanitizeRecord(record); });
  }

  async delete(key: string): Promise<void> {
    await this.mutate(records => { delete records[key]; });
  }

  async entries(): Promise<Array<[string, SessionRecord]>> {
    return Object.entries(await this.read());
  }

  async prune(maxIdleMs = DEFAULT_IDLE_WORKER_TIMEOUT_MS * 4, protectedKeys: ReadonlySet<string> = new Set()): Promise<void> {
    // Request receipts are kept independently: pruning idle metadata must not
    // make a previously submitted request executable again.
    await this.mutate(async records => {
      for (const [key, record] of Object.entries(records)) {
        if (protectedKeys.has(key) || record.lastUsedAt >= Date.now() - maxIdleMs) continue;
        let unlock: (() => Promise<void>) | undefined;
        try {
          unlock = await this.lockTurn(key);
          delete records[key];
        } catch (error) {
          if (!(error instanceof AgyBusyError)) throw error;
        } finally { await unlock?.(); }
      }
    });
  }

  async clear(): Promise<void> {
    await this.mutate(records => { for (const key of Object.keys(records)) delete records[key]; });
  }

  async lockTurn(key: string): Promise<() => Promise<void>> {
    return acquireFileLock(join(dataDirectory(), "turns", `${digest(key)}.lock`));
  }

  async receipt(key: string, request: string): Promise<RequestReceipt | undefined> {
    try {
      const value = JSON.parse(await readFile(receiptPath(key, request), "utf8"));
      if (value?.state !== "started" && value?.state !== "completed") throw new Error("Invalid request receipt");
      return value;
    } catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async saveReceipt(key: string, request: string, receipt: RequestReceipt): Promise<void> {
    await atomicWrite(receiptPath(key, request), receipt);
  }

}

export const sessionStore = new SessionStore();

export function sessionStoreDirectory(): string {
  return dataDirectory();
}

export type RequestReceipt = { state: "started" | "completed"; events?: AcpEvent[] };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function receiptPath(key: string, request: string): string {
  return join(dataDirectory(), "requests", digest(key), `${digest(request)}.json`);
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

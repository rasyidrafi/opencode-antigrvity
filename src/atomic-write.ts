import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { acquireFileLock } from "./file-lock.js";
import { warn } from "./log.js";

const STAGING_SLOTS = 4;
const CLEANUP_ATTEMPTS = 3;
const CLEANUP_RETRY_MS = [10, 30] as const;

export type AtomicWriteOperations = {
  mkdir: typeof mkdir;
  open: typeof open;
  rename: typeof rename;
  unlink: typeof unlink;
};

const fileOperations: AtomicWriteOperations = { mkdir, open, rename, unlink };

function safeErrorCode(error: any): string {
  return typeof error?.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(error.code) ? error.code : "unknown";
}

async function unlinkStaging(path: string, ops: AtomicWriteOperations): Promise<boolean> {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
    try { await ops.unlink(path); return true; }
    catch (error: any) {
      if (error?.code === "ENOENT") return true;
      if (attempt + 1 < CLEANUP_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, CLEANUP_RETRY_MS[attempt]));
      else {
        warn("Could not prune staged Antigravity metadata", {
          operation: "unlink",
          reason: "atomic_temp_cleanup_pending",
          code: safeErrorCode(error),
        });
      }
    }
  }
  return false;
}

/**
 * Write by atomic replacement using a small fixed set of serialized staging
 * names. A crash may leave one slot behind, but retries can reuse it and the
 * total number of staging files for a destination can never grow without
 * bound.
 */
export async function atomicWrite(path: string, value: unknown, ops: AtomicWriteOperations = fileOperations): Promise<void> {
  const release = await acquireFileLock(`${path}.atomic-write`, 5_000);
  let temporary: string | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await ops.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let slot = 0; slot < STAGING_SLOTS; slot++) {
      const candidate = `${path}.tmp-${slot}`;
      if (!await unlinkStaging(candidate, ops)) continue;
      try {
        file = await ops.open(candidate, "wx", 0o600);
        temporary = candidate;
        break;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    if (!file || !temporary) throw new Error("No Antigravity metadata staging slot is available");
    try { await file.writeFile(JSON.stringify(value), "utf8"); await file.sync(); }
    finally { await file.close(); file = undefined; }
    await ops.rename(temporary, path);
    temporary = undefined;

    // Directory fsync is not supported on Windows through Node's FileHandle.
    // File contents are still flushed before replacement on every platform.
    if (process.platform === "win32") return;
    const data = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
      join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-antigravity");
    const stop = dirname(resolve(data));
    for (let directory = dirname(resolve(path)); ; directory = dirname(directory)) {
      const handle = await ops.open(directory, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      if (directory === stop || directory === dirname(directory)) break;
    }
  } finally {
    try { await file?.close(); }
    finally {
      if (temporary) await unlinkStaging(temporary, ops);
      await release();
    }
  }
}

function definitelyDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error: any) { return error?.code === "ESRCH"; }
}

/** Remove only exact historical atomicWrite temp names whose recorded PID is
 * definitely gone. The sweep is independent of sessions.lock so tombstones
 * from a failed deletion can be reclaimed during startup. */
export async function sweepHistoricalDeletedTemps(root: string): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error: any) { if (error?.code === "ENOENT") return; throw error; }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^([a-f0-9]{64}\.json)\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/i.exec(entry.name);
    if (!match) continue;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !definitelyDead(pid)) continue;
    const path = join(root, entry.name);
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
      try { await unlink(path); break; }
      catch (error: any) {
        if (error?.code === "ENOENT") break;
        if (attempt + 1 < CLEANUP_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, CLEANUP_RETRY_MS[attempt]));
        else {
          warn("Could not prune historical Antigravity metadata staging", {
            operation: "unlink",
            reason: "historical_temp_cleanup_pending",
            code: safeErrorCode(error),
          });
        }
      }
    }
  }
}

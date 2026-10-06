import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AgyBusyError } from "./errors.js";

async function releaseOwned(path: string, token: string): Promise<void> {
  try { if (await readFile(path, "utf8") === token) await unlink(path); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
}

async function reclaimDead(path: string): Promise<void> {
  try {
    const token = await readFile(path, "utf8");
    // Legacy PID-only records remain reclaimable; malformed owners fail closed.
    const pid = Number(token.split(":")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return;
    try { process.kill(pid, 0); }
    catch (error: any) {
      if (error.code === "ESRCH") await releaseOwned(path, token);
      else if (error.code !== "EPERM") throw error;
    }
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
}

/** Publish a fully written owner file atomically, so contenders never read an empty PID. */
export async function acquireFileLock(path: string, waitMs = 0): Promise<() => Promise<void>> {
  return lock(path, waitMs, 0);
}

async function lock(path: string, waitMs: number, depth: number): Promise<() => Promise<void>> {
  if (depth > 8) throw new AgyBusyError("Antigravity stale-lock recovery guard limit reached; unknown ownership is protected");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = `${path}.${process.pid}.${randomUUID()}`;
  const token = `${process.pid}:${randomUUID()}`;
  await writeFile(owner, token, { mode: 0o600 });
  const deadline = Date.now() + waitMs;
  try {
    while (true) {
      try {
        await link(owner, path);
        return async () => { await releaseOwned(path, token); };
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        // Serialize stale-lock removal. Otherwise two contenders could remove
        // a newly acquired lock while both reclaiming the same dead owner.
        const reaper = `${path}.reap`;
        let releaseReaper: (() => Promise<void>) | undefined;
        try {
          // Reapers use the same ownership protocol. In particular, stale
          // reaper reclamation is itself serialized by a deeper guard; two
          // contenders cannot both unlink a replacement reaper after reading
          // the previous dead token. Guard depth is bounded and fails closed.
          releaseReaper = await lock(reaper, 0, depth + 1);
          await reclaimDead(path);
          try { await readFile(path); } catch (failure: any) { if (failure.code === "ENOENT") continue; throw failure; }
        } catch (failure: any) {
          if (failure.code === "ENOENT") continue;
          if (!(failure instanceof AgyBusyError)) throw failure;
        } finally {
          await releaseReaper?.();
        }
        if (Date.now() >= deadline) throw new AgyBusyError("This Antigravity session is busy in another request or OpenCode process");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } finally {
    await unlink(owner);
  }
}

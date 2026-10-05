import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AgyBusyError } from "./errors.js";

/** Publish a fully written owner file atomically, so contenders never read an empty PID. */
export async function acquireFileLock(path: string, waitMs = 0): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = `${path}.${process.pid}.${randomUUID()}`;
  await writeFile(owner, String(process.pid), { mode: 0o600 });
  const deadline = Date.now() + waitMs;
  try {
    while (true) {
      try {
        await link(owner, path);
        return async () => { await unlink(path); };
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        // Serialize stale-lock removal. Otherwise two contenders could remove
        // a newly acquired lock while both reclaiming the same dead owner.
        const reaper = `${path}.reap`;
        let reaping = false;
        try {
          await link(owner, reaper);
          reaping = true;
          const pid = Number(await readFile(path, "utf8"));
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); }
            catch (failure: any) {
              if (failure.code === "ESRCH") { await unlink(path); continue; }
              if (failure.code !== "EPERM") throw failure;
            }
          }
        } catch (failure: any) {
          if (failure.code === "ENOENT") continue;
          if (failure.code !== "EEXIST") throw failure;
        } finally {
          if (reaping) await unlink(reaper);
        }
        if (Date.now() >= deadline) throw new AgyBusyError("This Antigravity session is busy in another request or OpenCode process");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  } finally {
    await unlink(owner);
  }
}

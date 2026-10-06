import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "./file-lock.js";
import { AgyBusyError } from "./errors.js";

export const PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Only adapter-created private utility directories are eligible. Active
 * owners (including another process) and unknown/malformed locks are protected. */
export async function pruneUtilityArtifacts(data: string, now = Date.now()): Promise<void> {
  const root = join(data, "utilities");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^utility-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const path = join(root, entry.name);
    if ((await stat(path)).mtimeMs >= now - PAYLOAD_RETENTION_MS) continue;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireFileLock(join(path, ".owner"));
      await rm(path, { recursive: true, force: true });
    } catch (error) { if (!(error instanceof AgyBusyError)) throw error; }
    finally { await release?.(); }
  }
}

import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { acquireFileLock } from "./file-lock.js";

const URL = "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-x86_64.zip";
const files = {
  "agy_acp_server.par": { hash: "f472860b79c4816a32817e589afdb01cec0ca731e5fa428eae873b14be12387f", size: 714384320 },
  "localharness_external": { hash: "072fc497e7814b0e25a7d80109bceddacd815eb351d2e48ce579a05510e0cfdf", size: 139194456 },
};
type Manifest = { archiveHash: string; archiveLimit: number; files: Record<string, { hash: string; size: number }> };
const manifest: Manifest = { archiveHash: "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852", archiveLimit: 300_000_000, files };
/**
 * Production bounds for the first-setup download of the ~262 MiB archive
 * (extracted pair ~814 MiB), which legitimately takes several minutes.
 * `IDLE` is the maximum gap without progress (a byte of download, extraction
 * or verification), not a total budget: steady progress resets it. `MAX` is
 * the overall hard cap, so a trickle that never stalls still terminates.
 */
export const DEFAULT_RUNTIME_INSTALL_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_RUNTIME_INSTALL_MAX_TIMEOUT_MS = 30 * 60_000;
/** Injection is intended for offline tests; production callers should omit it. */
export type InstallerOptions = {
  directory?: string;
  fetch?: typeof fetch;
  manifest?: Manifest;
  /** No-progress (idle) timeout in ms; progress resets it. Alias: idleTimeoutMs. */
  timeoutMs?: number;
  idleTimeoutMs?: number;
  /** Overall hard cap in ms. Alias: overallTimeoutMs. */
  maxTimeoutMs?: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
};
function root(options: InstallerOptions) { return resolve(options.directory ?? join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode-antigravity", "runtime")); }
export function managedRuntimePath(options: InstallerOptions = {}): string { return join(root(options), "registry-1.5.2", "agy_acp_server.par"); }
function meter(limit: number, hash = createHash("sha256"), onProgress?: () => void) {
  let size = 0;
  const stream = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; if (size > limit) return callback(new Error("Runtime size limit exceeded")); hash.update(chunk); onProgress?.(); callback(null, chunk); } });
  return { stream, digest: () => hash.digest("hex"), size: () => size };
}
/** Timeout option resolution: non-positive/non-finite means "use default". */
function resolvedTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
/**
 * Progress watchdog: an idle (no-progress) deadline that progress resets,
 * plus an overall hard cap that progress never resets. Only the matching
 * deadline may abort; the other timer is left running.
 */
function createProgressWatchdog(idleMs: number, maxMs: number) {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let onTimeout: ((kind: "idle" | "max") => void) | undefined;
  const fire = (kind: "idle" | "max") => () => {
    onTimeout?.(kind);
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(fire("idle"), Math.max(1, idleMs));
    idleTimer.unref?.();
  };
  return {
    /** Sets the abort reason for the timeout; returns progress/stop hooks. */
    start(controller: AbortController) {
      onTimeout = (kind: "idle" | "max") => controller.abort(new Error(kind === "idle"
        ? "Runtime installer timed out: no progress within the idle limit"
        : "Runtime installer timed out: overall installation limit exceeded"));
      armIdle();
      maxTimer = setTimeout(fire("max"), Math.max(1, maxMs));
      maxTimer.unref?.();
      return {
        progress() {
          armIdle();
        },
      };
    },
    stop() {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      idleTimer = undefined;
      maxTimer = undefined;
    },
  };
}
async function valid(dir: string, spec: Manifest, signal: AbortSignal, onProgress?: () => void): Promise<boolean> {
  try {
    const directory = await lstat(dir);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) return false;
    if ((await readdir(dir)).sort().join("\0") !== Object.keys(spec.files).sort().join("\0")) return false;
    for (const [name, entry] of Object.entries(spec.files)) {
      signal.throwIfAborted();
      const handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size !== entry.size || !(stat.mode & 0o100)) return false;
        const h = createHash("sha256"); for await (const chunk of handle.createReadStream({ autoClose: false, signal })) { h.update(chunk); onProgress?.(); }
        if (h.digest("hex") !== entry.hash) return false;
      } finally { await handle.close(); }
    }
    return true;
  } catch (error) { if (signal.aborted) throw error; return false; }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); return value >>> 0; });
async function extract(archive: string, dir: string, spec: Manifest, signal: AbortSignal, onProgress?: () => void) {
  const file = await open(archive, "r");
  try {
    const length = (await file.stat()).size;
    async function read(offset: number, size: number) {
      if (offset < 0 || size < 0 || offset + size > length) throw new Error("Invalid ZIP bounds");
      const b = Buffer.alloc(size); const result = await file.read(b, 0, size, offset);
      if (result.bytesRead !== size) throw new Error("Truncated ZIP"); return b;
    }
    // The reviewed archive has no comment, ZIP64, data descriptors, or extra entries.
    const end = await read(length - 22, 22);
    const count = Object.keys(spec.files).length;
    if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt16LE(4) || end.readUInt16LE(6) || end.readUInt16LE(8) !== count || end.readUInt16LE(10) !== count || end.readUInt16LE(20)) throw new Error("Invalid ZIP end record");
    const centralSize = end.readUInt32LE(12), centralOffset = end.readUInt32LE(16);
    if (centralSize > 65536 || centralOffset + centralSize !== length - 22) throw new Error("Invalid ZIP directory");
    const central = await read(centralOffset, centralSize); let pos = 0, nextOffset = 0; const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted();
      if (pos + 46 > central.length || central.readUInt32LE(pos) !== 0x02014b50) throw new Error("Invalid ZIP entry");
      const crc = central.readUInt32LE(pos + 16);
      const flags = central.readUInt16LE(pos + 8), method = central.readUInt16LE(pos + 10), compressed = central.readUInt32LE(pos + 20), size = central.readUInt32LE(pos + 24);
      const n = central.readUInt16LE(pos + 28), x = central.readUInt16LE(pos + 30), c = central.readUInt16LE(pos + 32), offset = central.readUInt32LE(pos + 42);
      if (pos + 46 + n + x + c > central.length) throw new Error("Invalid ZIP entry length");
      const name = central.subarray(pos + 46, pos + 46 + n).toString("utf8");
      const entry = Object.hasOwn(spec.files, name) ? spec.files[name] : undefined;
      const mode = central.readUInt32LE(pos + 38) >>> 16;
      if (offset !== nextOffset || !entry || seen.has(name) || flags !== 0 || method !== 8 || size !== entry.size || (mode & 0xf000) !== 0x8000 || central.readUInt16LE(pos + 34)) throw new Error("Unexpected ZIP entry");
      seen.add(name);
      const local = await read(offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== size) throw new Error("Invalid ZIP local header");
      const ln = local.readUInt16LE(26), lx = local.readUInt16LE(28);
      if (!(await read(offset + 30, ln)).equals(Buffer.from(name)) || offset + 30 + ln + lx + compressed > centralOffset || !compressed) throw new Error("Invalid ZIP local entry");
      const extraCheck = (extra: Buffer) => { for (let j = 0; j < extra.length;) { if (j + 4 > extra.length) throw new Error("Invalid ZIP extra field"); const id = extra.readUInt16LE(j), len = extra.readUInt16LE(j + 2); j += 4; if (![0x5455, 0x7875].includes(id) || j + len > extra.length) throw new Error("Invalid ZIP extra field"); j += len; } };
      extraCheck(central.subarray(pos + 46 + n, pos + 46 + n + x));
      extraCheck(await read(offset + 30 + ln, lx));
      const start = offset + 30 + ln + lx, checked = meter(entry.size, createHash("sha256"), onProgress), inflate = createInflateRaw();
      let checksum = 0xffffffff;
      const crcStream = new Transform({ transform(chunk: Buffer, _enc, cb) { for (const byte of chunk) { checksum = (checksum >>> 8) ^ crcTable[(checksum ^ byte) & 255]!; } onProgress?.(); cb(null, chunk); } });
      try {
        await pipeline(createReadStream(archive, { start, end: start + compressed - 1 }), inflate, crcStream, checked.stream, createWriteStream(join(dir, name), { flags: "wx", mode: 0o700 }), { signal });
      } catch (error) {
        // pipeline() replaces the abort reason with a generic AbortError.
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        throw error;
      }
      if (inflate.bytesWritten !== compressed || ((checksum ^ 0xffffffff) >>> 0) !== crc) throw new Error("Invalid ZIP deflate data or CRC");
      nextOffset = start + compressed;
      if (checked.size() !== entry.size || checked.digest() !== entry.hash) throw new Error("Runtime file checksum mismatch");
      pos += 46 + n + x + c;
    }
    if (pos !== central.length || nextOffset !== centralOffset) throw new Error("Unexpected ZIP directory data");
  } finally { await file.close(); }
}
/** All path ancestors must be non-symlink and not writable by other users,
 * except root-owned sticky directories such as /tmp. The cache itself is private. */
async function prepareCache(base: string, signal: AbortSignal, create = true) {
  const parts: string[] = []; for (let p = base; p !== dirname(p); p = dirname(p)) parts.unshift(p);
  for (const p of parts) {
    signal.throwIfAborted();
    if (create) try { await mkdir(p, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    const st = await lstat(p);
    if (!st.isDirectory() || (st.uid !== 0 && st.uid !== process.getuid?.()) || ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000)))) throw new Error(`Unsafe runtime cache directory: ${p}`);
    if (p === base && (st.uid !== process.getuid?.() || (st.mode & 0o077))) throw new Error(`Runtime cache must be private: ${p}`);
  }
}
/** Check the same cache ancestry as installation without creating directories. */
export async function assertManagedRuntimeCacheTrust(options: InstallerOptions = {}): Promise<void> {
  await prepareCache(root(options), options.signal ?? new AbortController().signal, false);
}
/** Download and atomically publish the pinned official runtime. Returns its launcher path. */
export async function installManagedRuntime(options: InstallerOptions = {}): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Managed runtime requires Linux x64");
  const spec = options.manifest ?? manifest, base = root(options), target = join(base, "registry-1.5.2");
  if (Object.keys(spec.files).sort().join(",") !== Object.keys(files).sort().join(",")) throw new Error("Invalid runtime manifest");
  const controller = new AbortController();
  // Idle = no-progress deadline (progress resets it); max = overall hard cap.
  // timeoutMs is the legacy alias for idleTimeoutMs. Non-positive/non-finite
  // values fall back to defaults: an unbounded window would hang forever.
  const idleMs = resolvedTimeout(options.idleTimeoutMs ?? options.timeoutMs, DEFAULT_RUNTIME_INSTALL_IDLE_TIMEOUT_MS);
  const maxMs = resolvedTimeout(options.maxTimeoutMs ?? options.overallTimeoutMs, DEFAULT_RUNTIME_INSTALL_MAX_TIMEOUT_MS);
  const watchdog = createProgressWatchdog(idleMs, maxMs);
  const progress = watchdog.start(controller).progress;
  const abort = () => controller.abort(options.signal?.reason); options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = controller.signal; let stage: string | undefined; let unlock: (() => Promise<void>) | undefined;
  try {
    await prepareCache(base, signal);
    progress();
    while (!unlock) {
      signal.throwIfAborted();
      try { unlock = await acquireFileLock(join(base, "install.lock"), 0); }
      catch (error) {
        if (!(error instanceof Error) || error.name !== "AgyBusyError") throw new Error("Runtime installer lock failed", { cause: error });
        await new Promise<void>((resolve, reject) => { const done = () => { signal.removeEventListener("abort", cancelled); resolve(); }; const t = setTimeout(done, 20); const cancelled = () => { clearTimeout(t); reject(signal.reason); }; signal.addEventListener("abort", cancelled, { once: true }); });
      }
    }
    signal.throwIfAborted(); progress();
    for (const name of await readdir(base)) if (/^\.install-[A-Za-z0-9]{6}$/.test(name)) { signal.throwIfAborted(); await rm(join(base, name), { recursive: true, force: true }); }
    progress();
    if (await valid(target, spec, signal, progress)) return managedRuntimePath(options);
    progress();
    stage = await mkdtemp(join(base, ".install-")); await chmod(stage, 0o700);
    const archive = join(stage, "archive.zip"), output = join(stage, "runtime"); await mkdir(output, { mode: 0o700 });
    const response = await Promise.race([(options.fetch ?? fetch)(URL, { redirect: "error", signal }), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    signal.throwIfAborted(); progress();
    if (!response.ok || !response.body || response.redirected) throw new Error("Runtime download failed");
    const checked = meter(spec.archiveLimit, createHash("sha256"), progress);
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream), checked.stream, createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
    } catch (error) {
      // pipeline() replaces the abort reason with a generic AbortError;
      // restore the watchdog / caller diagnostic.
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      throw error;
    }
    if (checked.digest() !== spec.archiveHash) throw new Error("Runtime archive checksum mismatch");
    progress();
    await extract(archive, output, spec, signal, progress);
    signal.throwIfAborted(); progress();
    await rm(target, { recursive: true, force: true });
    signal.throwIfAborted();
    await rename(output, target);
    return managedRuntimePath(options);
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }); } finally { try { if (unlock) await unlock(); } finally { watchdog.stop(); options.signal?.removeEventListener("abort", abort); } }
  }
}

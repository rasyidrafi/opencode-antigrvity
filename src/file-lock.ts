import { open, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { LibraryHandle } from "koffi";
import { AgyBusyError } from "./errors.js";
import { warn } from "./log.js";

type NativeRelease = () => Promise<void>;
type NativeBackend = { guardDirectory: string; tryLock(path: string): Promise<NativeRelease | undefined> };

let backendPromise: Promise<NativeBackend> | undefined;

/** Decode an inline native UTF-16 buffer, not a pointer stored inside it. */
export function decodeWindowsProfilePath(koffi: typeof import("koffi").default, buffer: unknown): string {
  const home = koffi.decode.string16(buffer);
  if (!home) throw new Error("The OS account profile path is empty");
  return home;
}

function guardDirectory(accountHome: string): string {
  if (!accountHome) throw new Error("The OS account home for native lock storage is unavailable");
  return join(resolve(accountHome), ".local", "share", "opencode-antigravity", ".locks");
}

function posixAccountHome(koffi: typeof import("koffi").default, library: LibraryHandle): string {
  const passwdType = process.platform === "darwin"
    ? koffi.struct({
        name: "str", password: "str", uid: "uint32_t", gid: "uint32_t", change: "long",
        userClass: "str", gecos: "str", directory: "str", shell: "str", expire: "long", fields: "int",
      })
    : koffi.struct({
        name: "str", password: "str", uid: "uint32_t", gid: "uint32_t",
        gecos: "str", directory: "str", shell: "str",
      });
  const getEffectiveUid = library.func("uint32_t geteuid(void)");
  const getPasswordEntry = library.func("void * getpwuid(uint32_t uid)");
  const entry = getPasswordEntry(getEffectiveUid()) as bigint | null;
  if (!entry) throw new Error("The OS account home could not be resolved from the user database");
  const value = koffi.decode(entry, passwdType) as { directory?: unknown };
  if (typeof value.directory !== "string" || value.directory.length === 0) {
    throw new Error("The OS account home is missing from the user database");
  }
  return value.directory;
}

function windowsAccountHome(
  koffi: typeof import("koffi").default,
  kernel32: LibraryHandle,
): string {
  const advapi32 = koffi.load("advapi32.dll");
  const userenv = koffi.load("userenv.dll");
  const getCurrentProcess = kernel32.func("void * __stdcall GetCurrentProcess(void)");
  const closeHandle = kernel32.func("int __stdcall CloseHandle(void * handle)");
  const getLastError = kernel32.func("uint32_t __stdcall GetLastError(void)");
  const openProcessToken = advapi32.func("int __stdcall OpenProcessToken(void * process, uint32_t access, void * tokenOutput)");
  const getProfileDirectory = userenv.func("int __stdcall GetUserProfileDirectoryW(void * token, void * profileOutput, uint32_t * size)");
  const tokenOutput = koffi.alloc("void *", 1);
  const sizeOutput = koffi.alloc("uint32_t", 1);
  let token: bigint | undefined;
  try {
    koffi.encode(tokenOutput, "void *", null);
    koffi.encode(sizeOutput, "uint32_t", 0);
    if (!openProcessToken(getCurrentProcess(), 0x0008, tokenOutput)) {
      throw new Error(`Could not query the OS account token (Windows error ${getLastError()})`);
    }
    token = koffi.decode(tokenOutput, "void *") as bigint;
    if (!token) throw new Error("The OS account token is unavailable");

    if (!getProfileDirectory(token, null, sizeOutput)) {
      const code = getLastError() as number;
      if (code !== 122) throw new Error(`Could not query the OS account profile (Windows error ${code})`);
    }
    const length = koffi.decode(sizeOutput, "uint32_t") as number;
    if (!Number.isSafeInteger(length) || length < 2 || length > 32_768) throw new Error("The OS account profile path length is invalid");
    const profileOutput = koffi.alloc("uint16_t", length);
    try {
      if (!getProfileDirectory(token, profileOutput, sizeOutput)) {
        throw new Error(`Could not read the OS account profile (Windows error ${getLastError()})`);
      }
      return decodeWindowsProfilePath(koffi, profileOutput);
    } finally { koffi.free(profileOutput); }
  } finally {
    try {
      if (token && !closeHandle(token)) throw new Error(`Could not close the OS account token (Windows error ${getLastError()})`);
    } finally {
      koffi.free(sizeOutput);
      koffi.free(tokenOutput);
    }
  }
}

async function canonicalResourcePath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      const physical = await realpath(current);
      const canonical = resolve(physical, ...suffix.reverse());
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw new Error("Could not canonicalize native lock identity; refusing unsafe locking", { cause: error });
      }
      const parent = dirname(current);
      if (parent === current) throw new Error("Could not canonicalize native lock identity; refusing unsafe locking", { cause: error });
      suffix.push(basename(current));
      current = parent;
    }
  }
}

async function nativeLockPath(path: string, namespace: string): Promise<string> {
  const identity = await canonicalResourcePath(path);
  const digest = createHash("sha256").update(identity).digest("hex");
  return join(namespace, `${digest}.lock`);
}

function loadBackend(): Promise<NativeBackend> {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    let koffi: typeof import("koffi").default;
    try { koffi = (await import("koffi")).default; }
    catch (cause) {
      throw new Error("Crash-released native file locking is unavailable; refusing an unsafe lock fallback", { cause });
    }

    if (process.platform === "win32") {
      try {
        const kernel32 = koffi.load("kernel32.dll");
        const namespace = guardDirectory(windowsAccountHome(koffi, kernel32));
        const createFile = kernel32.func("void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void * security, uint32_t creation, uint32_t attributes, void * template)");
        const lockFile = kernel32.func("int __stdcall LockFileEx(void * handle, uint32_t flags, uint32_t reserved, uint32_t bytesLow, uint32_t bytesHigh, void * overlapped)");
        const unlockFile = kernel32.func("int __stdcall UnlockFileEx(void * handle, uint32_t reserved, uint32_t bytesLow, uint32_t bytesHigh, void * overlapped)");
        const closeHandle = kernel32.func("int __stdcall CloseHandle(void * handle)");
        const getLastError = kernel32.func("uint32_t __stdcall GetLastError(void)");
        const overlappedType = koffi.struct({
          internal: "uintptr_t",
          internalHigh: "uintptr_t",
          offset: "uint32_t",
          offsetHigh: "uint32_t",
          event: "void *",
        });

        return {
          guardDirectory: namespace,
          async tryLock(path) {
            // The lock file lives in the non-prunable account-home namespace and
            // is never deleted. Omitting FILE_SHARE_DELETE prevents replacing
            // its inode while another process has the handle open.
            const handle = createFile(path, 0xc0000000, 0x3, null, 4, 0x80, null) as bigint;
            if (handle === -1n || handle === 0xffffffffffffffffn) {
              throw new Error(`Could not open native lock handle (Windows error ${getLastError()})`);
            }
            const overlapped = koffi.alloc(overlappedType, 1);
            koffi.encode(overlapped, overlappedType, {
              internal: 0,
              internalHigh: 0,
              offset: 0,
              offsetHigh: 0,
              event: null,
            });
            const locked = lockFile(handle, 0x3, 0, 1, 0, overlapped) as number;
            if (!locked) {
              const code = getLastError() as number;
              closeHandle(handle);
              koffi.free(overlapped);
              if (code === 33) return undefined; // ERROR_LOCK_VIOLATION
              throw new Error(`Could not acquire native lock handle (Windows error ${code})`);
            }

            let released = false;
            return async () => {
              if (released) return;
              let unlockCode: number | undefined;
              let unlockFailed = false;
              try {
                if (!unlockFile(handle, 0, 1, 0, overlapped)) { unlockFailed = true; unlockCode = getLastError() as number; }
              } catch { unlockFailed = true; }
              let closed = false;
              let closeCode: number | undefined;
              try {
                closed = Boolean(closeHandle(handle));
                if (!closed) closeCode = getLastError() as number;
              } catch { /* Keep the handle state unknown and allow a later retry. */ }
              if (!closed) throw new Error(`Could not close native lock handle${closeCode === undefined ? "" : ` (Windows error ${closeCode})`}`);
              released = true;
              try { koffi.free(overlapped); } catch { /* The OS handle is already closed. */ }
              if (unlockFailed) warn("Native unlock call failed; closed handle released ownership", { reason: "native_unlock_closed_handle", code: unlockCode ?? "unknown" });
            };
          },
        };
      } catch (cause) {
        throw new Error("Crash-released Windows LockFileEx is unavailable; refusing an unsafe lock fallback", { cause });
      }
    }

    if (process.platform === "linux" || process.platform === "darwin") {
      try {
        const library = process.platform === "darwin"
          ? koffi.load("/usr/lib/libSystem.B.dylib")
          : (() => {
              try { return koffi.load("libc.so.6"); }
              catch { return koffi.load("libc.so"); }
            })();
        const flock = library.func("int flock(int fd, int operation)");
        const namespace = guardDirectory(posixAccountHome(koffi, library));
        const errnoBusy = new Set([koffi.os.errno.EWOULDBLOCK, koffi.os.errno.EAGAIN].filter((value): value is number => value !== undefined));
        return {
          guardDirectory: namespace,
          async tryLock(path) {
            const handle = await open(path, constants.O_CREAT | constants.O_RDWR, 0o600);
            const result = flock(handle.fd, 6) as number; // LOCK_EX | LOCK_NB
            if (result !== 0) {
              const code = koffi.errno();
              await handle.close();
              if (errnoBusy.has(code)) return undefined;
              throw new Error(`Could not acquire native flock (errno ${code})`);
            }
            let released = false;
            return async () => {
              if (released) return;
              let unlockCode: number | undefined;
              let unlockFailed = false;
              try {
                if ((flock(handle.fd, 8) as number) !== 0) { unlockFailed = true; unlockCode = koffi.errno(); } // LOCK_UN
              } catch { unlockFailed = true; }
              try { await handle.close(); }
              catch (cause) { throw new Error("Could not close native lock descriptor", { cause }); }
              released = true;
              if (unlockFailed) warn("Native unlock call failed; closed descriptor released ownership", { reason: "native_unlock_closed_descriptor", code: unlockCode ?? "unknown" });
            };
          },
        };
      } catch (cause) {
        throw new Error("Crash-released POSIX flock is unavailable; refusing an unsafe lock fallback", { cause });
      }
    }

    throw new Error(`Crash-released native file locking is unsupported on ${process.platform}; refusing an unsafe lock fallback`);
  })();
  return backendPromise;
}

function ownerPid(token: string): number | undefined {
  const match = /^(\d+)(?::[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/i.exec(token);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsDefinitelyDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error: any) { return error?.code === "ESRCH"; }
}

const LEGACY_LIVE_ERROR = "A legacy lock owner is live or could not be verified. Stop every older OpenCode server using this data directory, then retry.";
const LEGACY_UNKNOWN_ERROR = "An unknown legacy lock record is being preserved. Stop every older OpenCode server; if it remains after shutdown, back up the data directory and investigate before manual cleanup.";

/**
 * Existing PID/reaper locks are read only for a one-time, fail-closed upgrade
 * boundary. New versions never publish PID ownership records. A full legacy
 * chain is removed only when every member has a well-formed, definitely dead
 * owner; live and malformed records remain untouched.
 */
async function clearProvenDeadLegacyChain(path: string): Promise<void> {
  const owners: Array<{ path: string; token: string; pid: number }> = [];
  let candidate = path;
  for (let depth = 0; ; depth++, candidate += ".reap") {
    let token: string;
    try { token = await readFile(candidate, "utf8"); }
    catch (error: any) {
      if (error?.code === "ENOENT") {
        if (depth === 0) continue; // A detached legacy reaper can outlive its base file.
        break;
      }
      throw new AgyBusyError(LEGACY_UNKNOWN_ERROR);
    }
    const pid = ownerPid(token);
    if (pid === undefined) throw new AgyBusyError(LEGACY_UNKNOWN_ERROR);
    if (!processIsDefinitelyDead(pid)) throw new AgyBusyError(LEGACY_LIVE_ERROR);
    owners.push({ path: candidate, token, pid });
  }

  for (const owner of owners) {
    let current: string;
    try { current = await readFile(owner.path, "utf8"); }
    catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw new AgyBusyError(LEGACY_UNKNOWN_ERROR);
    }
    if (current !== owner.token) throw new AgyBusyError(LEGACY_UNKNOWN_ERROR);
    if (!processIsDefinitelyDead(owner.pid)) throw new AgyBusyError(LEGACY_LIVE_ERROR);
    try { await unlink(owner.path); }
    catch (error: any) { if (error?.code !== "ENOENT") throw new AgyBusyError(LEGACY_UNKNOWN_ERROR); }
  }
}

/** Acquire a crash-released OS lock. Lock files live outside caller-owned,
 * removable utility directories and are deliberately never unlinked. */
export async function acquireFileLock(path: string, waitMs = 0): Promise<NativeRelease> {
  // Retain the old API's directory-creation behavior for callers such as the
  // session store, while keeping the actual guard in the stable account-home
  // namespace below.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const backend = await loadBackend();
  const nativePath = await nativeLockPath(path, backend.guardDirectory);
  await mkdir(dirname(nativePath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Math.max(0, Number.isFinite(waitMs) ? waitMs : 0);
  while (true) {
    const release = await backend.tryLock(nativePath);
    if (release) {
      try {
        await clearProvenDeadLegacyChain(path);
        return release;
      } catch (error) {
        await release();
        throw error;
      }
    }
    if (Date.now() >= deadline) throw new AgyBusyError("This Antigravity session is busy in another request or OpenCode process");
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
  }
}

# Durable lock recovery

The adapter now acquires locks with the operating system instead of PID files:
POSIX `flock` on Linux/macOS and `LockFileEx` on Windows. The native handle is
held by the server process, so the OS releases ownership when that process
exits or is killed. If the native library or OS call is unavailable, locking
fails closed; there is no lease, token-unlink, or unlocked fallback.

Native lock files are persistent and live in the OS account home namespace at
`<account-home>/.local/share/opencode-antigravity/.locks/`. The account home is
resolved from the OS user record, not from `HOME`, `XDG_DATA_HOME`, or
`OPENCODE_ANTIGRAVITY_DATA_DIR`, so environment overrides cannot split
ownership. Lock names use canonical physical resource paths, allowing
processes with different session-store directories to rendezvous on a shared
installation. These files are outside temporary utility directories that
retention can remove. Do not delete or move the namespace while any adapter
process is running. The lock protocol is intended for processes sharing a
local filesystem with working OS advisory-lock semantics; it is not a
distributed lock service.

## Upgrade boundary

Stop every OpenCode server, desktop service, and other process using the same
adapter data directory before upgrading. The previous PID/reaper protocol and
the native OS-lock protocol are **not rolling-upgrade compatible**: an old
process does not honor the new native lock, so it could otherwise overlap a
new server on an unmarked resource.

At startup, the new version checks old lock files and `.reap` chains. It removes
them only when every encountered owner has a recognized PID and that PID is
definitely gone. Live, permission-protected, malformed, or otherwise unknown
owners are left untouched and block that resource. If the adapter reports an
older or unknown lock owner, stop all old servers first and retry. If an
unknown record remains after shutdown, preserve the data directory and
investigate it before any manual cleanup; the adapter will not guess that it
is safe to delete.

Historical deletion-temp files are swept separately, without acquiring the
session-store lock. Only the exact old `<sha256>.json.<pid>.<uuid>.tmp` format
with a definitely dead PID is removed. Active or unrecognized files remain
untouched. New atomic writes use four serialized staging slots per destination,
so failed cleanup cannot grow the number of staging files without bound.

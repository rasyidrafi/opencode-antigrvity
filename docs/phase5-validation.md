# Phase 5 coherent slice

Preserves the reviewed phase 1–2 and partial phase 3–4 work. Automatic compaction
activation remains blocked as documented in `phase3-4-validation.md`.

Implemented in real proxy/bridge/pool paths:

- Version-keyed process-global proxy, pool and MCP bridge registries. Per-workspace
  reference counts prevent one plugin instance disposing another instance's proxy.
  Explicit no-directory `stopProxy()` remains administrative/test force shutdown.
- Calls are persisted before the host sees them; results are persisted before MCP
  settlement. Per-call locks serialize conflicting concurrent result submissions.
  Steering is appended to a cloned delivery payload, not the saved result.
- Lost transports rebuild using host assistant calls plus independently saved
  results. Missing result evidence never proves missing execution. After a lost
  transport, any previously exposed call without a result returns a nonretryable
  uncertain-execution error (`agy_tool_execution_uncertain`), not executable
  `tool_use`. Host-stored results anywhere in incoming context are reconciled,
  including calls before later assistant status messages. Live partial batches
  retain their waiters but return a nonretryable pending-results error
  (`agy_tool_results_pending`); they do not re-expose the original calls. Unknown,
  cross-conversation and conflicting call/result identities fail nonretryably.
- Descriptions and schema key/list ordering do not invalidate parked profiles.
  Actual schema/model/effort changes preserve originating results, retire the old
  pump and rebuild once the reported batch is complete.
- Installed V2 `session.tool.success` identifies the exact accepted terminal
  call. Its acceptance marker is persisted independently of a tool result before
  closing that call's bridge. Recovery represents accepted output as historical
  text, not a new call or fabricated MCP result. Session-only execution success
  is ignored: it cannot authoritatively identify the originating execution.
  `StructuredOutput` waiters also have a 60-second cleanup fallback
  (`OPENCODE_ANTIGRAVITY_TERMINAL_IDLE_MS`, minimum 1 second). Cleanup aborts;
  it does not fabricate a successful tool result. Ordinary permission waits keep
  the existing longer deadline.
- Workspace acquisition/release is counted only by the process-global proxy;
  plugin registries balance every acquisition, including two instances sharing
  a workspace. There is no second reference counter suppressing releases.
- Atomic durable writes sync the private temporary file before rename, then
  sync the destination directory and directory ancestors through the data
  directory's parent. Write/sync failures propagate before call/result exposure.

Evidence: `test/host-tools.test.ts` covers persisted partial-batch reconstruction,
late results, identical/conflicting concurrent submissions, cross-session
rejection, schema changes, model changes, shared proxy retention, and terminal
cleanup without a success payload. The fixture's session IDs are process-local;
epoch advancement and imported prompt contents establish rebuild evidence.

Review-fix validation on 2026-10-06: `npm run check` passed TypeScript build and
**111 tests, 2 skipped, 0 failures** (587 assertions). `git diff --check` passed.
Final gate: `/tmp/opencode/phase5-uncertain-check.log`. Affected regressions:
`/tmp/opencode/phase5-uncertain-affected.log` (19 passed across bridge and plugin
tests, including durable acceptance/fsync tests).
Baseline before this slice was 101 passed / 2 skipped; initial phase 5 was 108.

Review regressions demonstrate:

- A simulated executor executes each parallel side effect exactly once across
  transport loss when both A and B executed but only A's result persisted. Live
  partial submission and restarted recovery expose no executable calls. Both
  streaming and non-stream recovery return HTTP 400, preserving A1/B1 execution
  counts. Reconciliation with B's original host-stored result (outside the
  trailing result group) completes without executing either call again.
- Durable terminal acceptance survives a new store instance, is idempotent and
  rejects wrong-session/wrong-call attribution. The real plugin subscriber marks
  the accepted call; the next request emits no duplicate terminal tool call.
- Delayed execution-A session success and duplicated A tool success leave B's
  terminal waiter active and its acceptance marker absent.
- Two plugin instances sharing a workspace retain the proxy after first disposal
  and fully stop it after the final balanced disposal.
- An injected temporary-file fsync failure rejects result persistence and leaves
  the stored call without an acknowledged result. Timeout cleanup also leaves
  both result and terminal acceptance absent.

Remaining validation / limitations for independent review:

- Restart tests retire the real worker/transport but are not OS-kill crash
  injection tests at every fsync/exposure/delivery boundary. No live authenticated
  ACP or disposable live host session validation is claimed.
- Durable recovery requires the originating assistant call in authoritative host
  context. A call written just before a crash but never exposed is conservatively
  protected by the originating uncertain receipt; it is not automatically reissued.
  The proxy reconciles supplied host context, not a separate host-storage API
  lookup. Without an original result or authoritative proof of non-execution,
  recovery fails closed and requires host-side reconciliation.
- Accepted-result recovery is implemented, but explicit delivered/acknowledged
  tool-record transitions and full record quarantine/migration remain follow-up.
- Query-import module reload tests verify shared pool/bridge/proxy ownership.
  Global owner V1 isolates incompatible versions; cross-version handoff and
  startup/shutdown race stress tests remain.
- Terminal fallback and the real plugin subscriber have deterministic coverage.
  Call-correlated tool success marks acceptance; delayed session-only success and
  duplicate old-call success cannot close execution B's terminal waiter. Hosts
  that emit only session execution success get bounded interruption cleanup, not
  a claimed acceptance. Live host schema-acceptance validation remains required.
  Subscription reconnect is still phase 7 work.
- No commits, publishing, package version changes or global installation.
# Historical terminal-retirement evidence

The name-based `StructuredOutput` retirement statements below describe the
earlier implementation and are superseded by
[live-host-validation.md](live-host-validation.md). A successful ordinary tool,
including one named `StructuredOutput`, must deliver its original result and
await real ACP completion; tool-success events do not authorize pump retirement.
The later slice records the actual cancellation bug, fix, regressions and
successful authenticated host rerun.

# Antigravity production stability — consolidated implementation plan

Status: superseded historical evidence, not active implementation or release requirements. The approved simplification removed private-storage accounting and automatic occupancy admission.
Baseline: plugin 0.5.0, commit `4a9f543`; OpenCode 2.0.22; official ACP 1.3.0.
Date: 2026-10-06.

## 1. Goal and scope

Make Antigravity feel native inside OpenCode: reliable conversation continuity,
usable images, accurate available usage, predictable compaction, bounded storage,
and quiet recovery. Preserve zero-touch CLI authentication and OpenCode-owned
tools, permissions, skills and subagents.

This is the single forward implementation plan combining the accepted original
lifecycle decisions, subsequent reverse-engineering findings, the worthwhile
improvements, and the latest bug/cleanup audit. Existing validation and research
documents remain evidence, not competing implementation plans.

Included work:

- Fix the four newly reproduced lifecycle/configuration bugs.
- Implement genuine stock-ACP accounting, durable attribution and owned-artifact
  retention together; integrate with existing host accounting/native compaction.
- Improve media budgeting, cold reconstruction, discovery resilience, model
  provenance and summary progress.
- Remove demonstrably unreachable/unused code without breaking supported APIs.

Do not rewrite the working lifecycle architecture or expand media/control support.
Preserve unrelated/uncommitted work. Implementation, installation, commits and
publication are separate tasks; writing this plan authorizes none of them.

## 2. Non-negotiable contracts

1. OpenCode owns conversation history and accepted checkpoints. ACP is a
   replaceable execution cache. Rebuild from the host after divergence or lost
   remote state; never resume an unverified baseline.
2. Generating a summary does not commit it. Advance the host checkpoint epoch
   only on authoritative acceptance/reconciliation. Failed compaction preserves
   the accepted host baseline.
3. Never intentionally repeat a completed or uncertain tool execution. Persist
   call/result identity before exposure/delivery; keep recovery fail-closed.
4. Billing, context occupancy and estimates are different data. Never manufacture
   input/output/cache counts from occupancy, text length or placeholder zeroes.
5. Keep the official tested ACP executable and host-tool isolation unchanged.
   No patched binary, private OpenCode-core import, guessed service identity, or
   compatibility-check bypass in production.
6. Never automatically overwrite a newer user model choice. Never treat a tool
   named `StructuredOutput` as native turn-completion authority.
7. GC touches only attributable adapter-owned artifacts. Active, parked,
   recovery, reader and compact replay state remain protected. Original CLI
   credentials and unrelated conversations are never GC targets.
8. Logs/progress contain bounded identities, counts and reason codes, not raw
   prompts, results, metadata blobs or credentials.

## 3. Verified findings and remaining verification

Evidence supports the following, not full production readiness:

- Stock ACP omits terminal accounting but persists per-model-call counters in
  SQLite `steps.metadata`. Read-only decoding recovered uncached input, cache
  reads, inclusive output and reasoning; one observed cache read was 32,701.
- Five model calls occurred across four prompts; one harmless MCP call required
  two model calls. Stock restart/resume retained those indexes and added index
  11 while recalling the original marker. Universal index immutability and
  emitted-accounting deduplication are not established by that experiment.
- Current utility cleanup removes `utility-*` working directories but leaves
  the isolated ACP trajectory outside the utility retention scan.
- Catalog/ACP capacity was 1,048,576 while persisted model metadata reported
  `max_tokens: 1,000,000`. This is a discrepancy, not verified enforcement.
- Reviewer reproduced the four bugs below with in-memory probes; their live
  regression coverage still needs implementing.

The latest recorded offline gate was 137 passed / 4 live checks skipped. One
live run had an upstream TLS discovery failure; its affected test passed on
targeted retry. These are historical observations, not new checks for this plan.

Maintainable tests must carry their own sanitized fixtures and setup. Temporary
research files may help develop them but must not become runtime/test prerequisites.

## 4. Phase 1 — repair lifecycle correctness first

### 1A. Failed resume must rebuild accepted host history — P1

Areas: `src/session-pool.ts`, `src/acp-process.ts`, coordinator/store tests.

Current failure: the pool computes alignment before worker creation. A missing
or unsupported `session/load` creates a fresh worker with `resumed === false`,
but the production assembler still slices history using the old sent boundary.
The replacement receives only the latest message and loses accepted context.

Required implementation:

- Separate host-history alignment from confirmed remote-cache availability.
- Only use the unseen suffix when the current worker actually represents the
  accepted boundary. Inspect actual resume outcome, not the requested session ID.
- Fresh fallback gets a new execution generation and the full bounded host
  reconstruction. Do not persist it as representing the old boundary beforehand.
- Preserve every operative unseen/queued user item and instruction update during
  reconstruction; a failed resume is not permission to drop queued input.
- Log actual resume/rebuild outcome. Keep legacy receipt tombstones intact.

Acceptance: successful resume, missing session, unsupported load, rejected load,
closed worker and restart. `Remember SECRET_A` followed by `What was the secret?`
must include accepted history in the fresh prompt and recall A in a live run.
An edited B context must never import stale A. Tool results survive rebuilding.

### 1B. GC and execution must use the same ownership identity — P2

Areas: `src/session-store.ts`, `src/session-pool.ts`, lock/retention tests.

Current failure: host turns lock `host:<sessionID>`, while metadata pruning locks
the conversation key. Another process can remove an active/parked binding.

Required implementation:

- Centralize ownership-key derivation and use it for execution, metadata/payload
  pruning, session deletion and the new artifact reader/GC lifecycle.
- Pruning while holding the sessions-store lock must attempt ownership
  nonblockingly; do not introduce a lock-order wait or deadlock.
- Retain conservative legacy/unattributed handling. A process-local protected set
  is an optimization, not proof that another process has no active owner.

Acceptance: real child processes hold host ownership while another process
attempts pruning/deletion. Active and parked state survives; eligible idle state
is removed after release. Include stale locks, legacy keys and lock-order tests.

### 1C. Rebuild invalidates occupancy immediately — P2

Areas: `src/session-pool.ts`, `src/telemetry.ts`, durable state, RPC contract.

Current failure: edit/profile rebuild changes the ACP binding without changing
the host checkpoint epoch. The previous binding's occupancy remains measured.

Required implementation:

- Track execution generation/source binding independently of host checkpoint
  epoch. Invalidate occupancy to unknown whenever represented execution state is
  replaced, including failed-resume fallback.
- Accept observations only from the current generation/source. Late retired
  callbacks cannot revive an old measurement.
- Reads must verify binding provenance as well as epoch/freshness.
- Extend the versioned telemetry contract compatibly. Existing client consumers
  must resync to unknown, then fresh measured usage; disconnection remains stale.

Acceptance: edits, model/profile changes, lost resume, host compaction, reconnect
and late old-worker samples. Before first usage from the replacement, both RPC
and `/v1/usage` report unknown, even if the replacement never supplies usage.

### 1D. Honor the documented history limit — P2

Areas: `src/session-pool.ts`, `src/prompt.ts`, `src/budget.ts`, README.

Current failure: the main `messages` assembler hardcodes the default and bypasses
`OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS`.

Required implementation:

- Resolve the setting once through the shared planner and apply it to both
  production paths. Keep the existing setting name and documented override.
- Separate its historical-text character bound from independent UTF-8 transport
  and estimated context budgets. Document units; do not silently rename characters
  to tokens or let per-message rendering bypass the final bound.
- Preserve operative instructions/current and queued input. Exhausted fixed
  content produces an explicit budget error, never silent truncation.
- Use a consistent validated fallback and bounded diagnostic for invalid settings.

Acceptance: 1,024-character override against 10,000-character history; default,
Unicode, mixed blocks, omission-marker overhead, both proxy paths, and oversized
fixed content. The configured history cap must measurably change the sent prompt.

## 5. Phase 2 — usable media and useful cold reconstruction

### 2A. Separate media transport from text-context budgeting

Areas: `src/attachments.ts`, `src/prompt.ts`, `src/budget.ts`, proxy/bridge.

A valid 90 KB decoded image currently exceeds the transcript budget after
base64 serialization. Correct this without removing transport/memory limits.

- Keep explicit individual/aggregate media bounds; reconcile actual host encoder,
  HTTP/MCP and ACP limits end-to-end. Oversized input fails early with a media
  error, not a misleading text-history budget error.
- Budget text and media separately. Media context estimates are explicitly
  estimates, never token billing. Do not charge base64 characters as textual tokens.
- Preserve user images, promoted tool-result images and steering association.
  Historical media may be omitted only whole, with explicit omission evidence.
- Keep text/image-only capabilities and early audio/PDF/document/remote rejection.

Acceptance: installed encoder → proxy → ACP for realistic screenshots above
90 KB, multiple images, mixed text, promoted tool images and steering. Test
individual/aggregate boundaries, cancellation, invalid base64 and bounded memory.

### 2B. Spend rebuild budget on the useful recent causal context

Areas: canonical assembler, shared planner, `src/session-pool.ts`.

- Reserve current instructions, operative requests and the accepted checkpoint.
  If required material cannot fit, fail explicitly rather than claim a complete
  rebuild after dropping it.
- Group assistant calls and their results as causal units; preserve units needed
  for the current continuation. Then select useful recent historical units before
  older optional material and emit everything selected in original chronology.
- Preserve stable IDs, instruction boundaries, ordered media and omission markers.
- This is ordinary bounded reconstruction, not a second hidden compaction-tail
  policy. Host-selected compaction prefix/recent-tail behavior stays unchanged.

Acceptance: oversized oldest message plus important recent decision/result;
parallel calls/results; queued user input; edited history; summary plus recent
tail. Selection must not create orphan calls/results or reorder retained items.

## 6. Phase 3 — stock accounting, attribution and owned artifacts together

This is one gated slice. Do not enable accounting first and defer its ownership,
retention or replay safeguards to a later release.

### 3A. Optional, compatibility-profiled stock trajectory reader

Areas: new reader/profile modules, `src/acp-process.ts`, `src/host-environment.ts`.

- Expose the exact worker-owned isolated storage root/session identity to the
  reader. Never scan arbitrary scope directories or global user conversations.
- Verify official build, schema and record format. Unsupported/missing/corrupt
  accounting means unavailable accounting, not failed chat or fabricated zero.
- Open read-only, use WAL-aware bounded queries/snapshots, and read only necessary
  metadata columns. Bound rows/blob sizes before materializing them.
- Validate wire types, finite safe counters, settled-call state, identities and
  output/reasoning relationships. Distinguish schema-default zero, measured zero
  and unavailable information. Preserve unknown categories instead of guessing.
- Coordinate pathname/symlink/DB/sidecar ownership with workers and GC; a
  `realpath` check followed by reopening is not sufficient race protection.
- Use bounded settlement waits. No unbounded polling, schema exploration or
  private source extraction in the production request path.
- Keep the official executable and its tool-filter compatibility proof unchanged.

### 3B. Durable per-call attribution before usage emission

Areas: reader ledger, `src/session-store.ts`, `src/session-pool.ts`, bridge/proxy.

- Identify calls by scoped source session, generation, stable call/index evidence
  and originating response identity; do not assume indexes universally immutable.
- Persist attribution before exposing accounting. A call may be emitted at park
  or completion, but never billed at both, nor again after replay/resume.
- Multiple internal inference calls are multiple accounting observations, not one
  occupancy sample. Attribute identical parallel-tool batches without name/order
  guesses and without re-executing any tool.
- Normalize uncached input, cache read/write, inclusive output and reasoning with
  a documented source contract. Do not infer prices, account quota or missing
  categories. Preserve supported genuine wire accounting with explicit precedence
  so wire and storage observations cannot both charge the same call.
- Emit only settled accounting when the host has no tested correction mechanism.
  Replacing a private receipt cannot undo already emitted usage. Conflicting late
  records become diagnostics/unavailable evidence, not another billing delta.
- Failure to read accounting must not make accepted inference retryable.

### 3C. Artifact ownership index and seven-day retention

Areas: `src/session-store.ts`, `src/retention.ts`, utilities, workers/pool.

- Register each private ACP artifact with utility/primary kind, source session,
  effective scope, host/epoch when known, ownership, resumability and reader cursor.
- Track successful utilities and retired bindings, not just temporary working
  directories. Address the reproduced leftover utility trajectory.
- Prune only indexed inactive adapter-owned DB/WAL/SHM/sidecar/brain artifacts
  after seven days; coordinate with cross-process readers and worker locks.
- Session deletion removes attributable state only after ownership releases.
  Keep compact replay/accounting tombstones as long as their host session exists.
- Active/parked/recovery records and uncertain execution evidence are protected.
  Unknown legacy artifacts remain protected rather than broadly deleting a scope.
- Migration and quarantine remain crash-safe, atomic/private and fail-closed.

Acceptance for the whole phase:

- Real nonzero cache-read normalization, output/reasoning reconciliation, and
  deterministic cache-write fixtures without claiming unobserved live behavior.
- Actual host SSE/nonstream parity; tools parked/settled/partial/parallel;
  identical calls; cancellation and permission denial.
- SIGKILL before/after attribution and response exposure; restart/resume/replay;
  no duplicated accounting or tool execution.
- Concurrent WAL writes/read snapshots/GC; cross-process ownership; stale locks;
  malicious paths/symlinks; malformed/wrong-type/unsupported/encrypted records.
- Live utility completion followed by eligible retention cleanup; primary recovery
  artifacts survive. Unknown formats continue chat with unavailable accounting.

## 7. Phase 4 — native accounting and compaction integration

Areas: `src/translate.ts`, `src/proxy.ts`, telemetry availability, README/client.

- Feed genuinely attributed accounting through standard Anthropic-compatible
  responses in both streaming and collection paths.
- Expose accounting availability/provenance independently of required protocol
  placeholders. Supported UI consumers must distinguish unknown from measured
  zero and preserve existing billing displays separately from occupancy.
- Let native OpenCode use real input/cache measurements as anchors and own
  `compaction.auto/buffer`. Do not activate a second guessed trigger.
- Explain multi-call semantics: summed billing can exceed the latest ACP context
  snapshot. Native anchors may compact conservatively early; this is not exact
  occupancy-based admission.
- Preserve transactional summaries, truthful stop reasons, safe reconstruction,
  failure rollback and unknown occupancy after replacement/checkpoint commit.

Acceptance: disposable live host with recovered accounting, native auto on/off,
custom buffer, manual compaction and exact-marker continuation. Exercise threshold
logic with controlled small test limits/fixtures, not by exhausting a real account.
Verify accepted checkpoint/epoch/binding and failure/no-loop behavior. Test model
changes and provider away/back without billing/provenance contamination.

## 8. Phase 5 — quieter operations, model evidence and visible progress

### 5A. Bounded discovery recovery

Areas: discovery/catalog/ACP startup and errors.

- Retry only structured transient network/discovery failures that are definitely
  before inference/tool execution, with bounded exponential backoff/jitter and
  cancellation. Preserve the existing compatible cached-catalog fallback.
- Never apply discovery retry rules to submitted/accepted/uncertain turns or
  permission/tool failures. Exhaustion gives an actionable bounded diagnostic.

Acceptance: TLS/network discovery failure then success; exhaustion; auth and
unsupported-model errors; cancellation; cached inventory; no inference replay.

### 5B. Model provenance and fallback notification

Areas: worker/catalog, telemetry/store, optional supported UI consumers.

- Keep requested host model, configured ACP model and observed inference model
  separate. An observed backend name does not create an available host catalog ID.
- Record source/reason and issue deduplicated fallback notifications. New user
  selections, including away-and-back changes, invalidate obsolete suggestions.
- Detect unavailable catalog selections before submitting a new turn where proven.
  Do not change global family defaults based on one session.
- Preserve all conflicting limit values/provenance. Validate the meaning and
  precedence of actual metadata before applying a smaller planning limit; use
  controlled backend/profile tests, not speculative enforcement claims.
- Once validated, share effective capacity across utility/history planning while
  honoring smaller host overrides. No per-session observation may alter another
  session's selection or misrepresent an unsupported model as available.

Acceptance: independent sessions/efforts, actual model updates, repeated fallback
notifications, newer selections and catalog removal. Cover metadata conflicts,
unknown limits, host overrides and auth-scope changes without catalog leakage.

### 5C. Honest utility reduction progress

Areas: `src/utility.ts`, versioned RPC/events, optional client rendering.

- Publish real chunk/round progress for potentially long bounded reductions:
  transaction identity, phase, completed/total work and terminal outcome.
- Preserve bounded retry/work limits and cancellation. Distinguish generation
  completed from host checkpoint committed; failed/truncated summaries stay failed.
- Provide read/resync semantics where events can be missed. No raw summary or
  transcript payloads in progress/logs; consumers remain nonblocking.

Acceptance: multiple chunks/rounds, retry, max-token failure, cancellation,
duplicate/missed events and delayed host commit. Long summaries show progress
without inventing provider output or blocking the ACP pump.

## 9. Phase 6 — evidence-backed cleanup

Perform after replacement paths and regression coverage are integrated.

Delete directly:

- Unreachable file/document processing after their explicit rejection in
  `src/prompt.ts`; unreachable audio alternatives inside image processing.
- The unused `replay` import in `src/proxy.ts`.

Audit before removing exported declarations:

- `withOptionalHistory`, `providerModelEntries`, `translate.replay`.
- The obsolete `stableConversationKey` identity path and its
  `validateTextOnlyMessages` helper/test-only references.

Check source/test/import graphs, package exports, shipped declarations and
documented deep-import compatibility. Remove genuinely internal dead exports;
retain a small deprecated shim if compatibility evidence requires it. Do not
retain whole duplicate execution/identity paths merely to satisfy an old test.

Keep `addAnthropicUsage` if the accounting implementation uses it; keep the
documented future auto-admission state machine unless a separately reviewed
replacement makes it obsolete. Keep `fflate`, ACP SDK and plugin SDK: they have
real production consumers. Do not remove unsupported-media validation, security
profiles, tombstones or recovery protections as cleanup.

Acceptance: no production references to deleted internal helpers; supported
exports/declarations remain valid; attachment rejection and new identity/replay
tests pass; no unneeded dependency removal or behavior changes hidden in cleanup.

## 10. Explicitly excluded work

The following guarantees cannot be implemented through the current supported
host/protocol contracts and are not gates for this plan:

- Direct ACP-occupancy admission guaranteed to follow effective host policy.
  Retain native measurement/estimate-driven compaction; do not guess policy.
- Atomic automatic fallback-selection reflection. Use provenance/notifications,
  not an unsafe host selection write.
- True per-result remote protocol ACK. Retain durable local delivery and safe
  recovery; optional correlated observation is not ACK or replay permission.
- Native terminal-stop without continuation. Keep ordinary validated continuation,
  not name-based cancellation or fabricated success.

Also excluded: patched ACP distributions, fake token accounting, quota inferred
from plain refusal, overflow inferred from every `max_tokens`, audio/PDF expansion,
native instruction-role claims, provider/core rewrite and unmeasured hash-cache
optimization. Preserve structured errors when present; stock upstream loss of
quota/limit distinctions cannot be reconstructed from missing wire evidence.

## 11. Execution, verification and release gate

Implement coherent phases in order. Each phase needs its regressions and a
separate read-only review; fix confirmed in-scope findings before continuing.
Promote useful research into maintainable sanitized tests. Do not claim prototype,
fixture, source-inspection and live-host evidence are interchangeable.

Final required gates:

1. `npm run check`, affected focused suites, authenticated `npm run test:live`.
2. Actual disposable-host stream/nonstream, tool/skill/subagent, edit/fork/restart,
   parked profile change, realistic images and manual/native-auto continuation.
3. Accounting/replay crash matrix, multi-process ownership/GC, unavailable-schema
   fallback and telemetry freshness/availability tests.
4. Build and actual npm pack inspection: public exports/types resolve; private
   trajectories, credentials, raw probes and fixtures do not ship.
5. Update README support matrix, storage/migration/retention, usage availability,
   native-auto versus exact occupancy semantics, progress and remaining contracts.
   If client changes are necessary, validate them separately against the versioned
   contract; plugin correctness must not depend on an unmodified client meter.

Record commands/results and genuine blockers without claiming unexecuted passes.
Version selection must check the registry and release compatibility; no commit,
publish, installed-plugin update or service restart without task authorization.

Done means: the four bugs are fixed; realistic image/cold-context use improves;
settled real accounting is emitted at most once per attributed call; unsupported
accounting never breaks chat; owned storage is bounded without harming recovery;
native host compaction is validated; notifications/progress are truthful; cleanup
has no supported-API regression; every phase and the final gate pass review.

## 12. Traceability

| Work | Original audit/plan coverage |
| --- | --- |
| Lost-resume reconstruction; recent causal history | F03, F04, F07, F10, F15 |
| Correct ownership locks and artifact retention | F07, F16, F17 |
| Binding-scoped telemetry, usage reader and native anchors | F05, F11, F12 |
| Configured history budget and utility progress | F01, F02, F04, F11 |
| Usable bounded images and steering | F08, F09, F14 |
| Discovery resilience and truthful failure handling | F06, F13, F18 |
| Requested/configured/observed model and fallback notices | F10, F12, F13 |
| Safe dead-code cleanup and supported export inspection | F14, F17, F18 |

Supporting evidence: `docs/production-followup-research.md`,
`docs/usage-reverse-engineering.md`, `docs/context-estimation-audit.md`,
`docs/phase8-validation.md`, `docs/live-host-validation.md`,
`docs/tool-crash-validation.md` and existing test suites.

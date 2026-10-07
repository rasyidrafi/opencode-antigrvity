# Production follow-up research — 2026-10-06

Scope authority: `/home/halotec/.opencode/plan/opencode-antigravity-lifecycle-handover.md`,
then the implementation's reviewed release limitations. This document proposes
follow-ups; it does not silently change those decisions or claim a new release.
Investigation and experiments were performed directly without subagents. A
separate reviewer is consulted after the experiments.

## 1. Real accounting without modifying the official ACP executable (F05)

**New live proof:** unmodified official ACP 1.3.0 stores per-model-call counters
in its isolated SQLite trajectory. This is a more conservative integration path
than the earlier temporary binary instrumentation.

Four authenticated prompts produced five completed model calls. The fourth
prompt called a harmless disposable MCP tool exactly once and required two model
calls. Stock ACP terminal responses still omitted accounting. A read-only decoder
of `steps.metadata` recovered all five calls' actual counters and the existing
adapter's `usageFromAcp` normalized them successfully.

| Step index | Uncached input | Cache read | Inclusive output | Reasoning | Visible output |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 4247 | 0 | 30 | 25 | 5 |
| 3 | 35257 | 0 | 25 | 20 | 5 |
| 5 | 2660 | 32701 | 25 | 20 | 5 |
| 7 | 2788 | 32690 | 431 | 372 | 59 |
| 9 | 3308 | 32682 | 36 | 31 | 5 |

This upgrades previous evidence from zero-only cached counters to genuine
**nonzero cache reads** without changing the server. Proto scalar omission means
default zero under the inspected schema; it does not independently prove a
backend explicitly measured that category as zero. The experimental adapter
reads defaults, but a production contract must document default/unavailable
semantics. Nonzero cache-write usage has not been observed.

Reverse-engineered path:

- Official `.par` bundles protobuf file descriptors. Descriptors were extracted
  without importing private generated modules or copying transcript text.
- SQLite `steps.metadata` is `CortexStepMetadata`; field 9 is `ModelUsageStats`,
  field 24 is `ModelInfo`. Input/output/cache/reasoning counts are in those
  messages. `steps.step_payload` independently corroborated the counts.
- The five stored call totals matched ACP occupancy notifications in order.
  No counter was inferred from generated text or split from aggregate occupancy.
- The pure Bun prototype opens the exact isolated session DB read-only and
  translates counters. It is research code, not shipped production behavior.

Proposed production slice:

1. A compatibility-profiled, **optional fail-closed** reader for adapter-owned
   isolated trajectory DBs only. Resolve the exact effective auth home and source
   session from the worker; do not scan a user's global conversation directory.
2. Strict schema/build/format checks, bounded metadata-only reads, safe integers,
   completed-call handling, WAL-aware read snapshots and bounded settlement waits.
   Missing/unsupported/encrypted records mean unavailable usage, not guessed zero
   or failed chat execution.
3. Durable billing receipts keyed by source session + call index + call identity,
   correlated with originating host response/epoch. Never count old rows after
   resume/replay; do not charge one row both at park and at final completion.
4. Preserve uncached/cache/inclusive-output/thinking normalization. A corrected
   same-call record replaces its prior observation; it is not a new billed call.
5. Add strict stream/nonstream, partial/parallel tools, cancellation, reload,
   crash and DB-format-change tests before enabling the reader by default.

This keeps the official tested execution/tool-filter binary unchanged. Its
private storage format remains a maintenance dependency and must be guarded by
the same explicit compatibility discipline as executable identity.

Evidence: `/tmp/opencode/acp-usage-reverse/stock-live-results.json`,
`stock-live-probe.log`, `sqlite-token-counters.json`, `usage-descriptors.json`,
`stock-db-adapter-results.json`, `stock-db-adapter.log`; runnable `stock-probe.ts`,
`decode-db.py`, `db-adapter-probe.ts`. The latter is a Bun metadata-only decoder;
Python protobuf was installed in a private research venv solely for descriptor
investigation.

Subsequent stock process restart/resume passed: the same session recalled
`STOCK_TOOL_4`, retained call indexes 1/3/5/7/9, and added one new model-call row
at index 11. Its actual occupancy was 34,806 and matched that new row's counters.
This verifies persistence and index continuation, **not** integration-level
billing deduplication. Evidence: `stock-resume-results.json`,
`stock-resume-assertions.json`, `stock-resume-probe.log`.

Prototype limitations identified in independent review: it scans private scope
directories rather than using a worker-provided exact DB path, fetches all rows
before bounding metadata, records rather than validates status/format, and
defaults missing/wrong-type scalar fields to zero. Its pathname check is not
race-free. None of these shortcuts should be copied into production. Coordinate
the worker/reader/GC ownership and sidecar handling, bound rows/bytes in the
query, validate fields, and resolve zero/unavailable semantics before emission.
Once accounting has been emitted, a later correction also needs an explicit
host-accounting policy; replacing only the private receipt cannot undo an already
reported amount.

## 2. Native auto-compaction becomes measurement-backed, not an occupancy hack (F05)

Installed host 2.0.22 already consumes real input/cache/output accounting as a
measurement anchor and independently owns `auto/buffer` policy. Returning the
genuine counters recovered above can improve its existing native trigger without
requesting `ctx.session.compact` based on guessed policy.

This is an implementation avenue, **not yet an end-to-end production pass**:
today's installed plugin still emits required zeros when the stock terminal
response lacks usage. The reader has not been integrated into its response pump.

Keep two caveats explicit:

- Billing for a host response containing several internal model calls is the sum
  of those calls, while current occupancy is the latest call's window. In the
  observed tool turn, two occupancies were 35,909 and 36,026, but their combined
  accounting was 71,935. Do not label 71,935 as current occupancy. A host using
  aggregate billing as an anchor can compact conservatively early.
- An exact **ACP-occupancy-based** trigger following effective host settings
  remains a separate integration gap. Public plugin context still lacks effective
  settings; adding an unused `contextTokens` wire field does not connect it to
  the core estimator. A host-owned occupancy/policy capability is the clean
  extension. It cannot be replaced by manufacturing `input_tokens`.

## 3. Investigate conflicting execution-window metadata (F05, F12)

New discrepancy observed on the same real model/calls:

- ACP `usage_update.size`: **1,048,576**.
- Host enriched catalog context: **1,048,576**.
- Persisted actual model metadata `max_tokens`: **1,000,000**.

This is concrete conflicting metadata, not an observed overflow or proof that
the smaller field's enforcement semantics are identical to the ACP capacity.
Inspect/validate its backend meaning before calling it authoritative. A
conservative compatibility-profiled effective cap can use the smaller validated
limit, retaining all original values/provenance in telemetry. Avoid changing
another session's selected model/defaults from one session's observation.

Acceptance: validate catalog/user override/live metadata precedence; test known
smaller capacity without consuming an account's full window; ensure summary and
history planners share that validated capacity.

## 4. ACP utility trajectories escape current retention (F17)

**New live reproduction:** a completed `runSummary` removed its `utility-*`
directory, but left a SQLite conversation under adapter-owned
`host-acp/<scope>/antigravity-acp/conversations/`. Current `pruneUtilityArtifacts`
only scans `utilities/`; it does not cover that trajectory. Utility workers do
not register these DBs in the primary session-binding ledger.

The remaining file is not itself a bug in retaining recoverable primary state;
the gap is lack of tracked ownership/eligibility and bounded retention for
abandoned utility/private ACP artifacts. Evidence:
`/tmp/opencode/acp-usage-reverse/utility-gc-evidence.json`.

Proposed fix: persist an artifact ownership index for each created ACP session,
with utility/primary kind, host session/epoch where applicable, worker ownership
and resumability. Extend seven-day pruning/session deletion to **only** indexed
inactive adapter-owned DB/WAL/SHM/sidecar/brain artifacts. Protect active, parked,
recovery and replay-accounting state; never remove original CLI credentials or
unattributed conversations. Make GC compatible with the new usage-reader cursor.

## 5. Fallback models: better evidence without unsafe selection writes (F12)

Reverse-engineered official replacement flow updates `current_model_id`, rebuilds
at a turn boundary, and sends `config_option_update`. The existing worker already
records those updates. Persisted per-call `ModelInfo.model_name` supplies an
additional execution observation (actual Gemini model name was recovered live).

Proposed enhancement: distinguish requested, configured ACP and observed
per-inference model; attach fallback reason/provenance to telemetry and detect
catalog removal before submitting a new turn. A user-facing suggestion can be
invalidated by `session.model.selected`, including away-and-back revisions.

**Still not safe:** automatically writing a fallback to host selection with a
guarantee against overwriting a newer choice. Current `switchModel` has no
expected-selection parameter, and the projector updates by session ID only.
Idle checks, local locks and subsequent correction do not remove that race.
Production scope should retain telemetry/suggestions rather than unconditional
host switching, unless the host adds a public atomic guard.

## 6. Tool delivery evidence: stronger observations, not fabricated ACK (F07, F18)

The inspected SDK sends `ToolResponse(id, response_json, supplemental_media)`
to its harness. Public MCP responses do not carry a per-result acknowledgement
back to this adapter. Current result-persisted/delivery-attempted/local-handoff
records and fail-closed recovery remain correct.

Completed ACP tool records may provide **additional remote-result-observed**
evidence, but associating them with a host call requires explicit causal mapping:
ACP frame/execution IDs, MCP request IDs and host call IDs are not interchangeable.
Matching only name/arguments or arrival order is unsafe for identical parallel
calls. A future observation receipt must bind original IDs/result digest and
must never authorize re-execution when absent. Do not rename it a protocol ACK.

A new supported upstream acknowledgement extension would be needed for the
stronger original guarantee. It is not required to keep recovery side-effect safe.

## 7. Terminal tools and overflow semantics (F06, F14)

Ordinary `StructuredOutput` now completes through the real continuation, as live
validated. Public tool schema has no native terminal-stop flag. Do not revive
the fixed name-based retirement bug. Immediate native stop still requires a host
contract; ordinary continuation is the supported production fallback.

Reverse source also maps several SDK input/output/total-limit stop reasons into
ACP `max_tokens`. Preserve distinct raw failure evidence if a reviewed upstream
extension provides it; add deterministic classifier coverage. Do not classify
all `max_tokens` as input overflow or silently manufacture a successful summary.
No new real-account overflow was forced in this research.

The pristine server also maps SDK `QUOTA_EXHAUSTED` to ACP `refusal`. This is
upstream information loss, not a new adapter regression; deterministic tests
cannot reconstruct the missing distinction from a plain terminal `refusal`.
An upstream/private-profile extension exposing raw stop reason would be needed
for exact classification, with ordinary structured error mapping preserved.

For stock source claims, use the exact archive member or the separate pristine
`/tmp/opencode/acp-usage-reverse/pristine-server.py`, not the previously modified
extracted `google3/.../server.py`. `source-provenance.json` records archive/member
hashes and verifies that pristine source has no research instrumentation.

## Recommended order

1. Profiled stock-trajectory usage reader + durable per-call attribution and
   artifact ownership indexing/retention in the same first slice.
2. Real host accounting/native-auto integration tests, keeping occupancy separate;
   do not enable accounting before the ownership/GC guards pass.
3. Extend retention to indexed idle utility/retired artifacts and session deletion,
   sharing reader/recovery ownership protections. This is broader lifecycle
   coverage, not permission to defer the utility ownership/retention safeguards
   required in item 1 before the reader is enabled.
4. Verified execution-limit reconciliation and model provenance.
5. Optional stronger correlated result-observation diagnostics and error evidence.

Host-owned exact occupancy admission, atomic model-selection reflection, true
ACK and native terminal-stop remain explicit external-contract requests—not
promises this repository alone can fulfill today.

## Independent consultation

Reviewer inspected real source/evidence and judged the stock SQLite path credible,
but not production-ready. Confirmed the utility-retention gap as an existing
0.5.0 issue; recommended reader/ownership/retention as one coherent slice. The
corrections above distinguish prototype shortcuts, default-zero semantics,
observed model-limit discrepancy and accounting versus occupancy. Required live
host attribution/native-auto, concurrency, cancellation/crash settlement, schema
change and nonzero-cache-write gates remain unexecuted, not declared impossible.

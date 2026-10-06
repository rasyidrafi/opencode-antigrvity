# Phase 6–7 integrated slice (2026-10-06)

Prior reviewed uncommitted phases are preserved. No commits, publishing, version
changes, sibling edits, or global plugin installation were performed. Phase 4
telemetry-triggered automatic activation remains blocked on authoritative public
effective configuration; this slice does not infer or bypass that configuration.

Implemented:

- Honest text/image-only capabilities and early audio/file/document/remote-media
  rejection. Unsupported sampling, stop, JSON-schema and tool-choice overrides
  fail explicitly; routine output budgets remain advisory, with model output
  reserves independent of adapter input-byte caps and no native enforcement claim.
  Temperature stays intentionally
  stripped with bounded metadata-only diagnostics.
- Inline/promoted result images, image steering and lost-waiter media recovery.
  Installed V2 Anthropic encoder → proxy → MCP regression coverage found/fixed a
  promoted-image digest mismatch in durable recovery. Ambiguous images remain user
  context, rather than being assigned to an arbitrary result.
- Stable family defaults, session-local effort, requested/actual fallback telemetry
  and shared effective authentication hashing/settings for discovery and execution.
  Auth scope changes retire incompatible bridges/workers; source CLI settings are
  not rewritten to apply explicit overrides. ADC/GCP/endpoint context is scoped.
- Primary/reaper ownership tokens, recursively serialized stale-reaper recovery
  with bounded guard depth, replacement-safe release, configured shared capacity,
  idle-only eviction, native composed signals, and success-listener regressions.
- Private seven-day completed response and large completed tool-result retention.
  Tool expiration requires completed originating receipts and no active turn/result
  owner. Digests/call/profile tombstones remain; matching host results rehydrate
  them. Parked, uncertain, unattributed legacy evidence stays protected. Dead
  utility artifacts are collected only in private adapter-owned utility paths.
  Corrupt receipts are quarantined with uncertain tombstones; corrupt session
  metadata is quarantined and remains fail-closed. Quarantine copies deduplicate.
- Exact official 1.3.0 Linux x64 executable/companion identity validation before
  host-tool startup. Version strings and arbitrary override paths are not safety
  evidence. Fixtures inject a test-only validator; no runtime environment bypass
  exists. Other platform/build profiles deliberately fail closed pending review.
- MCP cancellation request-ID mapping interrupts the originating bridge, with
  no successful empty result. Chunked body size and read deadlines are bounded.
  The cancellation map participates in process-global reload ownership.
- Observable event reconnection with bounded exponential backoff/jitter, stale
  disconnected telemetry, bridge retirement and binding invalidation on reconnect.
  Public active-context checkpoint IDs reconcile observed commits; authoritative
  request context remains the reconstruction backstop when no baseline exists.
  Lifecycle identity/epoch ledgers and accepted tool results remain intact.

Evidence:

Checkpoint race review correction:

- Hook, event, reconnect and checkpoint-state writes share `lifecycle-event`
  serialization. Novelty is determined from durable state re-read inside that
  lock, after awaited context acquisition; no pre-read decision survives an await.
- Internal writers do not recursively acquire the lifecycle lock. Retirement
  holds no host turn lock while joining pumps. Baseline/alias writes do not wait
  on a newer parked turn. Reconnect force-retirement additionally checks the
  binding revisions captured at subscription loss, not newly created bindings.
- Deterministic hook/hook and hook/event gates pause the first context read,
  advance the checkpoint through the competing path, create a new real parked
  bridge, then resume the first hook. The newer bridge/revision remains intact,
  its result reaches the original MCP waiter, and the epoch advances only once.
  Separate owner-lock regressions verify no join/re-lock of the newer turn.
- `npm run check`: **132 pass, 3 skipped, 0 fail**, 135 tests / 725 assertions,
  including TypeScript build. `/tmp/opencode/checkpoint-race-check.log`.
  `git diff --check`: clean. No native protocol/auth changes required a live rerun.

Follow-up correction/verification:

- Fixed the confirmed budget-domain error: model context/output tokens are
  reserved independently of the 100k chat and 24k utility input-byte caps.
  Both paths use `modelTranscriptBudget`, metadata where known and documented
  conservative estimates otherwise. Tiny actual proxy chat/continuation/summary
  requests pass with Gemini `max_tokens: 65536` and Claude `max_tokens: 128000`.
- Added public-context checkpoint reconciliation, serialized late-event aliases
  that cannot retire newer work, deleted-session ownership/late-writer guards,
  indexed payload cleanup/restart retries, ancillary and inventory-cache
  quarantine, and negotiated MCP SSE waiting/keepalive/error termination.
- Final `npm run check`: **130 pass, 3 skipped, 0 fail**, 133 tests / 699
  assertions. `/tmp/opencode/phase67-followup-check.log`.
- Final authenticated `npm run test:live`: **3 pass**, 7 assertions.
  `/tmp/opencode/phase67-followup-live.log`.
- Build/pack dry-run: 168 files; declarations present, tests/fixture bypass
  excluded. `/tmp/opencode/phase67-followup-pack.json`. No installation/publication.

Previous slice gate (historical):

- `npm run check`: **123 pass, 3 skipped, 0 fail** (126 tests, 649 assertions),
  including TypeScript build. Log: `/tmp/opencode/phase6-7-check.log`.
- `npm run test:live`: **3 pass**, including authenticated official stream/resume/
  image/cancellation and a tool-free isolated summary preserving an exact marker.
  The new utility check exercises the real binary/companion compatibility profile
  and official tool-filter startup, without enabling native filesystem/terminal
  tools. Log: `/tmp/opencode/phase6-7-live.log`.
- Deterministic regressions cover installed encoder media/recovery, MCP cancellation
  and stalled chunk reads, capacity pressure/active ownership, concurrent stale
  locks, listener counts, authentication scope retirement, protected retention/
  rehydration/conflicting digests/quarantine, and the real plugin subscription
  disconnect/reconnect with parked work and subsequent lifecycle processing.
- `git diff --check`: clean. `npm pack --dry-run --json`: 168 files;
  new runtime sources and public declarations included, tests/
  fixture compatibility bypass excluded. No tarball was installed or published.
  Manifest: `/tmp/opencode/phase6-7-pack.json`.

Explicit limitations:

- No safe automatic public host-model fallback selection update is claimed. Actual
  fallback is session-local telemetry only, so it cannot overwrite a newer user
  choice or invent an available provider/model entry. Verified installed public
  `SessionSwitchModelInput` contains only `sessionID` and `model`; it has no
  compare-and-set revision/expected selection or serialized selection guard.
  Checking `session.get().model` before `switchModel` is a TOCTOU race. A regression
  reports a real fixture fallback while preserving a newer medium host selection
  and asserts that no unsafe public model update is attempted.
- No native system-role authority, history mutation/forking, sampling enforcement,
  audio/PDF/remote expansion, native schema output, or billing inferred from context.
- MCP progress/keepalive is now supported for `_meta.progressToken` callers that
  accept SSE: one truthful waiting notification plus transport comments, ending
  with the actual result/error. JSON-only peers have no keepalive guarantee. No
  resumable SSE cursor or fabricated increasing work progress is claimed.
  Cancellation conservatively interrupts the originating whole ACP turn/batch.
- Isolated copied authentication homes and legacy/unattributed recovery records
  are retained conservatively; no blanket age-based deletion is applied. Deleted
  sessions now tombstone late requests/writers, join local owners, wait for other
  process ownership, then remove indexed private payloads and ancillary records.
  Deferred cleanup retries and is rediscovered on restart. Unattributed legacy
  payloads cannot safely be assigned to a deleted host and remain protected.
  Missing/expired results never permit tool re-execution.
- Public `session.context` is available and now reconciles completed checkpoint
  IDs against a durably observed baseline on reconnect and request boundaries.
  Epoch advancement is checkpoint-idempotent; late/concurrent events cannot
  retire newer work. First observation without a prior baseline does not invent
  a checkpoint transition. A missing checkpoint alone cannot prove a failed or
  still-running transaction; absent correlated failure evidence remains pending.
  No subscription replay cursor or observation of a missed event is fabricated.
- This is not a live disposable OpenCode host tool/skill/subagent/manual-checkpoint
  acceptance run. That release gate remains phase 8; existing live tests exercise
  official ACP and isolated utilities, not an installed replacement host plugin.

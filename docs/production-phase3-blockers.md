# Phase 3 implementation and enablement gates

Status: superseded historical evidence, not active implementation or release requirements. The approved simplification removed private-storage accounting and automatic occupancy admission.

Storage accounting remains disabled: no production SQLite pathname capability
or protocol emission hook is installed. Existing genuine ACP wire accounting
is unchanged. This is a local implementation/fixture gate, not full Phase 3
production or authenticated-host acceptance.

## Implemented

- `trajectory-source.ts`, `host-environment.ts`, `acp-process.ts`: exact isolated
  root/effective-scope/session/generation/build descriptor. Tool-filter proof is
  unchanged; the accounting hash is independently checked, never guessed from
  a version. Resume takes the artifact owner lease before loading the DB.
- `trajectory-format.ts`, `trajectory-reader.ts`, `trajectory-snapshot.ts`:
  bounded protobuf decoding, exact schema/source checks, type-15/status-3/format-0
  call profile, bounded read transactions and settlement waits. SQL bounds rows
  and blob sizes before loading metadata and never reads step payloads. Schema
  validation precedes trajectory-table queries; flexible scalar/identity columns
  use bounded type/length-checked SQL projections with null sentinels. Omitted
  counters stay schema-default/unknown, not measured zero. Inclusive output
  validates reasoning AND visible subsets even when the other category is absent.
  Model metadata is evidence only, never inferred planning capacity.
- `trajectory-ledger.ts`, `trajectory-accounting.ts`: ownership-gated snapshot
  and durable per-call emission reservations before returning observations.
  Every correlated historical row is reconciled against durable receipts before
  reserving only the requested response. Unknown historical exposure stays
  unavailable; old-call conflicts suppress new billing rather than rebilling.
  Generation changes cannot rebill a source call. Distinct stable identities
  remain distinct even with identical counters; changed identities at the same
  index and late conflicts suppress accounting. Wire wins before storage
  reservation; wire arriving after storage cannot create a second charge.
  Reservations are final even when exposure is uncertain. Ledger corruption,
  persistence/read failure, cancellation and limits make accounting unavailable,
  never inference retryable. No ledger tombstone age-based deletion exists.
- `trajectory-artifacts.ts`, `trajectory-files.ts`, `ownership-key.ts`, worker,
  pool, store and utility integration: durable primary/utility index before
  worker exposure; worker lifetime leases, reader/GC mutual exclusion, shared
  host ownership, generation/epoch/resumability/cursor records. Utility workers
  have distinct private scopes. Successful utilities and explicitly retired
  bindings qualify after seven days. Active, parked, recovery, uncertain and
  unattributed state remain protected; host deletion is retried through its
  durable deletion tombstone after ownership releases. Surviving detached
  process groups protect artifacts even after the parent releases its lease.
  Ownership checks the old group under the source lease before writing any new
  worker identity. Live, inaccessible and ambiguous groups block reuse without
  clearing evidence. Persisted session bindings retain their exact source so
  idle/restarted replacements can retire without an in-memory worker. Retirement
  intent survives a busy idle owner and is reconciled on close/GC; it never clears
  process-group evidence or retires uncertain execution.
  Metadata pruning/deletion records the same retirement intent under execution
  ownership before discarding a binding; compact replay receipts are unaffected.
  Retirement cannot be reversed by acquiring the same session again, even with
  a new generation. Matching pending authorization is checked against both the
  stored and incoming generation before any index mutation. Replacements retire
  the old binding only after successful replacement startup; startup failure
  leaves the accepted old binding recoverable. A legacy retired binding is
  refused before ACP spawn/load and rebuilt from bounded accepted host history,
  never reactivated or granted inference retry permission. Group evidence,
  reader uncertainty, cursors and accounting tombstones remain untouched.
  Indexed exact DB/WAL/SHM/`.meta` files and bounded per-session brain trees are
  inode/creation-stamp checked; unknown/replaced/symlinked/hardlinked artifacts
  protect cleanup. Legacy unstamped identities remain protected until refreshed.
  Partial GC is idempotent; deletion directories and index writes are fsynced.

The directory capability pins every ancestor through no-follow Linux directory
descriptors. Index writes/GC operate relative to those pinned inodes, rather
than checking realpath and reopening replaceable ancestors. Private roots and
non-writable descendants are required. Cooperating processes must use the
leases. Hostile same-UID code that can rewrite adapter memory/private files is
outside this threat model; pathname replacement by other users and preexisting
symlinks are not. Unsupported capability/platform/layout fails closed. Original
CLI credentials and unrelated conversations are never targets. Empty isolated
homes/copied auth files and unknown legacy artifacts remain conservative; this
does not claim a total byte bound for all historical storage.

## Evidence and remaining enablement work

Sanitized tests carry their own schemas, counters, protobuf construction and WAL
DB setup. The observed nonzero cache-read fixture is 32,701; cache-write 123 is
synthetic, not live evidence. Tests include real readonly SQLite WAL commits,
oversized/malformed records, reservation/replay/conflict/wire precedence,
cross-process host/worker ownership, stale locks, SIGKILL before/after reservation
and after **simulated** exposure, utility/brain retention, symlinks and pinned
ancestor replacement. These ledger crashes are not integrated host SSE exposure
or authenticated inference crash acceptance; existing tool crash tests remain
separate evidence.

Reviewer regressions additionally cover a real surviving detached child after
parent SIGKILL and failed replacement, inaccessible/ambiguous group evidence,
sequential A→B/resume/park reconciliation and late A conflicts while requesting
a later response, giant SQLite TEXT/BLOB scalar/identity/schema fields, and a 300-call paginated
WAL snapshot. A concurrent insert is invisible to that scan and is billed once
on the next scan. Scans permit 32 pages/4,096 rows and 8 MiB of inspected metadata,
with three bounded settlement attempts. Each query projects at most 129 metadata
blobs of at most 256,000 bytes (a separately bounded materialization ceiling).
Page and overall async deadlines also cover snapshot setup. Unsettled cancellation
leaves durable reader uncertainty protecting GC rather than claiming a closed
snapshot. These fixture bounds are not proof of production SQL execution bounds.

Private development inspection corroborated the schema and observed inference
rows: type 15, status 3, format 0; trajectory identity matches the source session.
Pristine source provenance records official SHA
`cf6feaebdacfc2255dcfc8883db99b15de8554698554e2a1e78e5ccec1c68a20`
and server-source SHA
`4b2171c74c116346260a9aa24e5372190bf0ad66cad8acebc350e89203157fe3`.
Its cancel path awaits conversation cancellation, not accounting settlement;
terminal tool statuses include DONE/ERROR/CANCELED, not all billable calls.
Its storage path uses `<isolated>/antigravity-acp/conversations/<session>.db`,
`.meta`, and `brain/<conversation id>`. No source/probe/secret was copied into
fixtures. Tests and runtime do not depend on the research directory.

Concrete unresolved contracts: the six observed stock inference rows (including
resume index 11) have an execution ID but **no response ID or message ID** in the
inspected usage message. A verified causal mapping to originating host responses
across parked/parallel continuations has not been established. The reader
therefore requires explicit correlation evidence and rejects these records
rather than inventing an identity from names, arguments or row order. Omitted
scalar categories cannot establish measured zeros or a complete billing tuple.

Engineering still required for enablement: provide a reviewed SQLite capability
that pins BOTH DB and WAL/SHM boundaries without SQLite canonicalization escaping
the descriptor-relative directory; establish explicit response correlation;
integrate reserved observations with
the protocol pump/replay behavior and test actual SSE/nonstream exposure. The
query/snapshot layer intentionally accepts an already-owned connection, not an
unsafe path opener. No immutable=1 or main-DB-only FD workaround is used.
JavaScript timers cannot interrupt synchronous SQLite queries, sorting, or schema
parsing. The synchronous fixture connection is therefore NOT a production
bounded-execution capability. Enablement also requires enforced SQLite limits
and progress interruption, or a cancellable isolated worker with a hard deadline
and proven lifetime/ownership cleanup. Output projection bounds are not CPU/time
bounds; elapsed checks only reject an over-budget completed read.
The worker exposes a lease-coordinated reservation method for that future
capability; retirement waits boundedly for readers and leaves durable uncertainty
if a capability does not settle. No production caller currently emits its output.

Verification still required: authenticated utility completion/eligible cleanup,
host SSE/nonstream parity, parked/partial/identical parallel calls, cancellation,
permission denial, integrated billing crash/exposure matrix and concurrent
writer/reader/GC stress. Ordinary fixture WAL transactions do not establish
hostile-path or live settlement safety. Phase 3 must not be declared complete
or accounting enabled until these distinct gates pass.

## Fresh local checks

- `npm run check`: TypeScript build, 205 passed, 4 skipped, 0 failed;
  209 tests / 1,409 assertions. Log: `/tmp/opencode/phase3-retirement-check.log`.
- `bun test test/production-phase3.test.ts test/trajectory-format.test.ts`:
  36 passed, 0 failed / 245 assertions.
- `git diff --check`: clean.

Earlier checks exposed the fixture's shared constant session ID (fixed to unique
new-session IDs, preserving session/load identity), then exhausted the already
nearly-full `/tmp` tmpfs. Only this session's exact disposable test outputs were
removed; unrelated research/live evidence was untouched. The media fixture now
cleans its owned temporary root and honors TMPDIR; the existing crash matrix now
also honors TMPDIR without changing its cases/assertions. An initial new-child
test hit the suite's five-second default under load; process tests now use a
bounded ten-second startup barrier with diagnostics and a fifteen-second test
deadline. Final check used a private,
automatically removed TMPDIR under `~/.cache` for the large disposable media
and crash fixtures; the command and test behavior otherwise remained unchanged. No live
ACP/host tests, installation, commit, publication or service restart was run.

This reviewer-fix slice initially exposed creation-inode reuse on disk-backed
temporary storage (fixed by creation stamps), and confirmed that the exact
INTEGER PRIMARY KEY schema rejects blob indexes (the regression now covers that
constraint plus unsafe integer indexes). Accounting remains disabled. These
changes require the reviewer's recheck; this document does not claim approval.

The follow-up retirement regression covers failed replacement of both warm and
idle/restarted bindings, restoration of original accepted history, and a legacy
already-retired binding with reader-uncertainty/accounting tombstones. The first
two actually resume their original source; the legacy case actually reconstructs
the complete small fixture history into a fresh source. All retain a resumable
current binding after idle close and simulated seven-day GC, and subsequently
resume without losing the marker. A separate test prevents an incoming generation
from activating its queued retirement authorization. These are integrated fixture
ACP/pool/storage regressions, not authenticated host or accounting enablement.

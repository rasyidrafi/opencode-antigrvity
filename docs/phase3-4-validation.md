# Phase 3–4 implementation evidence and blocker

This is not a declaration that phases 3–4, or the lifecycle handover, are complete.

## Implemented

- Streaming and collected responses share ACP finish/error mapping. Refusal,
  cancellation, max-token truncation, genuine reasoning, host calls, and ACP
  compaction status survive; terminal continuation failures use 400, not the
  V2 classifier's retryable 409 branch.
- Real installed V2 classifier/stream-decoder tests cover context overflow,
  throttling, quota, overload, policy refusal, and invalid request. Retry hints
  normalize milliseconds, seconds, minutes, dates, and structured timestamps;
  the retry hook preserves hints stripped by the Anthropic stream decoder and
  does not enable retries the host has rejected.
- Durable receipts distinguish preparation, submission, running, parking,
  completion, rejection before execution, interruption, and uncertainty. Verified
  cached completions replay without execution. Completed payload tombstones and
  uncertain requests cannot resubmit. Rejection requires structured evidence
  and absence of observed activity. Legacy unscoped hashes are tombstones only.
- Official ACP `cachedReadTokens/cachedWriteTokens` are normalized without
  double-counting inclusive input; duplicate terminal aggregates are deduplicated,
  conflicting aggregates fail, and occupancy never becomes accounting.
- Epoch-scoped, versioned replacement snapshots persist privately. Counts are
  validated, overflow occupancy is retained, old-epoch updates are ignored,
  and committed checkpoints read/emit unknown until new telemetry. Freshness
  expires after five minutes; clients must also mark disconnected displays stale.
- Authenticated `/v1/usage` returns the same record as location-scoped V2 RPC
  `antigravity-context-v1.read`/`changed`. The definition ships through `./rpc`.
  The RPC wire regression uses the exact installed client, actual plugin setup
  handlers, real HTTP/SSE, schema validation, real proxy/ACP pump updates,
  compaction events, read resync, isolation, and unload. Its host transport is
  a deterministic wire fixture, not a claim of live service/account validation.
- `src/auto-compaction.ts` implements durable stable message IDs, pending
  admission recovery, coalescing, stale/epoch rejection, effective auto/buffer
  policy, smaller ACP/model capacity, fixed-budget rejection, and failed-baseline
  suppression. Admission returns without waiting for completion. Duplicate
  telemetry cannot retry a lost admission acknowledgment; explicit recovery
  reuses the persisted ID. Real host lifecycle events mark failures only once.

## Exact automatic-admission prerequisite blocker

Installed `@opencode/plugin` is **2.0.22**. Both:

- `node_modules/@opencode/plugin/dist/promise/plugin.d.ts`, `Context`
- `node_modules/@opencode/plugin/dist/effect/plugin.d.ts`, `Context`

omit a configuration domain. The runtime Promise adapter in
`node_modules/@opencode/plugin/dist/promise/adapter.js` constructs that same
context and has no `config` member. `ctx.options` is explicitly the plugin's own
options, not effective session/location configuration. Neither `ctx.session`
nor the context hook includes `compaction.auto/buffer`.

The separate installed client's `config.get` exists in
`node_modules/@opencode/plugin/node_modules/@opencode/client/dist/promise/client.d.ts`;
it is not exposed by the plugin context. Creating another client through global
service discovery would not prove it targets the host that loaded this plugin
(including embedded SDK hosts), and is deliberately not done. Independently
reimplementing configuration discovery/merging is not an authoritative substitute.

The installed `SessionCompactInput` uses **`{sessionID, id}`**, not `messageID`.
The docs state admission is durable, runs at a safe point, and pending requests
merge. That action is available, but calling it without authoritative auto/buffer
settings violates the plan's explicit `auto: false` requirement. Consequently
the admission engine is tested but **not automatically activated** in this host.
Unblocking requires a public host-bound effective configuration read or an
equivalent authoritative settings capability. No guessed defaults are enabled.

## Sources and verification

Fetched V2 documentation:

- https://opencode.ai/v2/docs/build/plugins/
- https://opencode.ai/v2/docs/build/plugins/rpc/
- https://opencode.ai/v2/docs/compaction/

Affected regressions: `test/phase3-4.test.ts`, `test/auto-compaction.test.ts`,
`test/telemetry-rpc.test.ts`, `test/session-retry.test.ts`,
`test/proxy-smoke.test.ts`, `test/host-tools.test.ts`, `test/plugin-v2.test.ts`,
and `test/translate.test.ts`. Run `npm run check` for the integrated gate.

Hard-crash bridge reconstruction remains phase 5. Client meter consumption,
live authenticated validation, independent review, and release validation are
not asserted here. No commits, global plugin changes, or publishing were made.

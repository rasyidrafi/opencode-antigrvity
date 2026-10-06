# Phase 8 integrated evidence — 2026-10-06

Status: unreleased, not acceptance-complete. Preserve the reviewed implementation;
this document distinguishes tested behavior from remaining gates. No publication,
commit, global installation or shared-service restart was performed.

Additional authenticated edit/revert, fork, real provider away/back, restart,
parked-model, promoted-image/steering and native/OpenChamber proxy RPC/event
evidence is recorded in [live-host-validation.md](live-host-validation.md).
That slice also records concrete duplicate-call and name-based tool-retirement
fixes, successful ordinary `StructuredOutput` host acceptance after the initial
cancellation failure, and the precise distinctions from unsupported native
immediate loop-stop and unexecuted encrypted-relay/UI acceptance.

Subsequent tool-record migration/local-delivery and actual integrated SIGKILL
evidence is recorded in [tool-crash-validation.md](tool-crash-validation.md).
The pending tool/crash statements below describe the earlier phase-8 snapshot,
not the later slice; unrelated live/API gates remain open.

## Fresh gates

- `npm run check`: TypeScript build, 132 passed, 3 skipped, 0 failed;
  135 tests / 725 assertions. Initial `/tmp/opencode/phase8-check.log`;
  post-documentation/package gate `/tmp/opencode/phase8-final-check.log`.
- Authenticated `npm run test:live`: 3 passed, 0 failed, 7 assertions.
  `/tmp/opencode/phase8-live.log`. Official ACP stream/resume/image/cancellation
  and isolated tool-free utility inference; not live host tool acceptance.
- `npm view @rasyid_rafi/opencode-antigravity version --json`: registry 0.4.1.
  `/tmp/opencode/phase8-registry.json`. Version remains 0.4.1 deliberately: live
  full crash acceptance and API prerequisites are unresolved. This is a local
  validation artifact, not a replacement for the published 0.4.1 tarball. A
  future minor target must recheck the registry before changing manifest/lock.
- Actual `npm pack --json --pack-destination /tmp/opencode` executes the build;
  manifest `/tmp/opencode/phase8-pack.json`, build `/tmp/opencode/phase8-pack.log`.
  Final pack manifest `/tmp/opencode/phase8-final-pack.json`: 172 files, both
  root and `./rpc` source/declaration export targets present, documentation
  included, tests/fixture validators excluded. Inspection record:
  `/tmp/opencode/phase8-final-tarball-inspection.json`. No install/publication.
- `git diff --check`: clean. Documentation is included in the package allowlist
  so README evidence links resolve in the actual tarball.

## F01–F18 traceability

Evidence below refers to deterministic tests unless explicitly marked live.
Previous slice details remain in `phase3-4-validation.md`, `phase5-validation.md`
and `phase6-7-validation.md`; their historical counts are not today's totals.

| Finding | Implemented contract / source | Evidence / remaining limits |
|---|---|---|
| F01 checkpoint/cache divergence | `coordinator.ts`, `index.ts`, `session-pool.ts`: transactional epochs, accepted checkpoint rebuild, parked retirement | `lifecycle.test.ts`, `phase6-7.test.ts`; live host manual checkpoint continuation passed |
| F02 summary truncation | `budget.ts`, `utility.ts`: bounded ordered reduction, truthful failure | `lifecycle.test.ts`, `request-kind.test.ts`; authenticated utility marker passed |
| F03 edit/revert alignment | `prompt.ts`, `coordinator.ts`, `session-pool.ts`: host authority, divergence rebuild | `lifecycle.test.ts`, `prompt.test.ts`; live host edit/fork matrix not established |
| F04 chronology/initial boundary | `prompt.ts`, `session-pool.ts`: canonical unseen suffix, ordered instructions, first-turn initialization | `prompt.test.ts`, `lifecycle.test.ts` |
| F05 context/accounting | `telemetry.ts`, `telemetry-rpc.ts`, `auto-compaction.ts`, `translate.ts` | `telemetry-rpc.test.ts`, `auto-compaction.test.ts`, `phase3-4.test.ts`; automatic activation blocked |
| F06 classification/replay | `errors.ts`, `session-store.ts`, `proxy.ts`: real host classification, uncertain fail-closed receipts | `phase3-4.test.ts`, `session-retry.test.ts`, `proxy-smoke.test.ts` |
| F07 reload/restart tools | process-global owners, durable call/result writes, original host-result recovery | `host-tools.test.ts`, `plugin-v2.test.ts`; OS-kill boundary matrix pending, delivery acknowledgement state incomplete |
| F08 promoted images | `attachments.ts`, `prompt.ts`, `host-tools.ts`: causal association and ambiguous ordered context | installed host encoder path in `phase6-7.test.ts`; no live host image-tool run |
| F09 false audio support | `index.ts`, `attachments.ts`: text/image advertising; unsupported input rejected | `phase6-7.test.ts`, `attachments.test.ts`; no audio transport claimed |
| F10 profile changes | `host-tools.ts`, `session-pool.ts`: settle originating results, then rebuild changed profile | `host-tools.test.ts`; permissions remain host-owned |
| F11 event/finish parity | `translate.ts`, `proxy.ts`, `utility.ts`: normalized collected/stream outcomes | `translate.test.ts`, `phase3-4.test.ts`, `proxy-smoke.test.ts` |
| F12 cross-session defaults | `models.ts`, `model-catalog.ts`: stable defaults and session-local effort | `models.test.ts`, `model-catalog.test.ts`, `phase6-7.test.ts`; guarded fallback reflection blocked |
| F13 advanced auth scope | `effective-auth.ts`, `auth-bridge.ts`, `host-environment.ts`: shared execution/discovery scope | `phase6-7.test.ts`, `host-environment.test.ts`; personal CLI live authentication passed |
| F14 controls/terminal output | `proxy.ts`, `host-tools.ts`, `index.ts`: explicit support matrix; call-correlated terminal acceptance | `phase6-7.test.ts`, `host-tools.test.ts`, `plugin-v2.test.ts`; live terminal host validation pending |
| F15 instruction authority | `prompt.ts`: operative envelope versus quoted history | `prompt.test.ts`; native system role explicitly unsupported |
| F16 crash/reaper locks | `file-lock.ts`: ownership tokens and bounded stale-reaper guards | `phase6-7.test.ts`; exhaustive process-death stress not asserted |
| F17 capacity/retention | `retention.ts`, `session-store.ts`, `session-pool.ts`: shared capacity, protected recovery and tombstones | `phase6-7.test.ts`; unattributed legacy/auth homes retained conservatively |
| F18 compatibility/observability | `acp-compatibility.ts`, `host-tools.ts`, `index.ts`: exact profile, bounded MCP, reconnect/reconcile | `phase6-7.test.ts`, authenticated utility startup; only official Linux x64 1.3.0 profile reviewed |

## Public API blockers and crash boundaries

Installed Promise/Effect plugin Context and runtime adapter were rechecked:
no effective configuration domain, host-bound client/URL, or authoritative
`compaction.auto/buffer` read exists. `ctx.options` is plugin options; `ctx.app`
contains name/version/channel only. Public HTTP `config.get` on a separately
started host does not confer that capability on a loaded plugin, and returns
configuration sources rather than proving session-effective policy. No global
service discovery or filesystem merging workaround is activated.

Public `switchModel` has no atomic expected-selection/revision guard. Actual
fallback remains telemetry; read-then-write cannot safely reflect it to the host.

Calls persist before exposure; accepted results persist before waiter release;
atomic fsync failures reject persistence. Fixture transport death, partial
parallel side effects, duplicate/conflicting results and original host-result
reconciliation pass. These are not OS-kill tests at every boundary (before/after
exposure, before/after result persistence, after delivery before acknowledgement).
Tool record delivery currently records `accepted`, not independently verified
delivered/acknowledged transitions. Full tool-record schema migration/quarantine
and every crash boundary remain review/implementation gates, not completed work.
Other durable record quarantine coverage must not be used to imply those gates.

## Client phase 9

The sibling OpenChamber consumer is now implemented and independently reviewed:
73 independently passing tests were reported by its reviewer, with broad author
checks. This is separate sibling evidence, not a plugin test count or a shipped
client release. It consumes location/session/epoch/sequence scoped occupancy,
read resync, unknown checkpoint state and disconnected stale state separately
from billing. The unmodified core TUI has no such consumer.

## Disposable host attempt

An isolated public `opencode serve` was started with private HOME/XDG data/cache/
state and plugin storage under `/tmp/opencode/phase8-host`, loopback ports 18986
then 18987. Authentication used inherited server credentials without printing
them; personal CLI authentication was referenced read-only through GEMINI_HOME.
Inherited OPENCODE_CONFIG/OPENCODE/session identity were removed for the clean
host. Public location/config/plugin/model/session endpoints were exercised;
only disposable sessions were created. The user's shared service was untouched.

Package-directory loading and a flat local TypeScript entry did not produce an
active Antigravity entry. Public location reload timed out at 90 seconds while
the flat local source watcher was disposed. The documented nested local entry
`.opencode/plugins/antigravity/index.ts` subsequently loaded successfully: public
plugin listing showed `opencode-antigravity` active. The failed reload is still
a diagnostic observation, not a claim that all reload paths are validated.

Live host session `ses_ef064badeffepEhnEWW4NZfSY1` used discovered
`antigravity-cli/gemini-3.8-flash`. Host-stored messages show completed shell
output `PHASE8_SHELL_OAK_271`, successful `skill` loading with
`PHASE8_SKILL_CEDAR_417`, and a completed foreground `subagent` child
`ses_ef063a077ffeK0VVErSzqK6f4o` returning `PHASE8_CHILD_BIRCH_619`.
Initial invalid read/skill arguments were host errors, then corrected; this
was not a zero-error tool run. A real child session, not a simulated ACP tool,
was used. `messages-before.json` preserves the host evidence.

Public manual compaction admitted `msg_10f9cdd10001L4YlizsWcaBVLN`;
`context-compacted.json` shows the checkpoint completed with the expected summary.
The durable lifecycle ledger records committed source epoch 0 → epoch 1, with
checkpoint/event aliases and no duplicate advancement. The subsequent tool-free
primary response recalled exact context `PHASE8_CONTEXT_MAPLE_913`, skill and
child markers. `messages-after.json` preserves continuation evidence. These
passes fulfill the requested disposable live host shell/skill/subagent/manual
checkpoint scenario, not every edit/restart/crash/terminal scenario.

Raw disposable logs/API records remain under `/tmp/opencode/phase8-host`; do not
publish credential-bearing host storage. Only disposable hosts were terminated.

# Additional authenticated disposable-host evidence — 2026-10-06

Unreleased. This closes specific live gates, not all acceptance. The later
ordinary-StructuredOutput fix and successful live rerun below supersede the
initial cancellation failure, which remains preserved as historical evidence.
No commit,
publication, global install, private core import, or shared-service restart.
The sibling OpenChamber source was read and run, not edited.

## Isolation and execution

Public `opencode serve` v2.0.22 ran on loopback 18986, with private HOME/XDG
configuration/data/cache/state under `/tmp/opencode/phase8-host`. The local nested
plugin entry imports this repository's `src/index.ts`; personal GEMINI_HOME was
referenced read-only. Requests used inherited authenticated server credentials,
never printed or copied into this document. Calling `session.create` boots the
location: an initial plugin/model listing before that returned empty and was not
treated as an adapter acceptance result.

This restart used the default isolated XDG adapter directory,
`data/opencode-antigravity`, **not** the earlier `plugin-data` directory. Initial
snapshots of that earlier directory were corrected and the fresh edit scenario
rerun. Old evidence was not silently used to prove the new binding.

An independent OpenChamber web server ran on 18988 with private HOME/config/data,
`OPENCODE_HOST=http://127.0.0.1:18986` and managed OpenCode startup disabled. It
forwarded authenticated RPC and event requests to the disposable host. Private
relay hosting was disabled: this is a real OpenChamber HTTP/SSE proxy integration,
**not** an encrypted, paired private-relay or rendered-UI acceptance claim.

## Executed passes

All filenames below are under `/tmp/opencode/phase8-host` and remain private.
`assert-evidence.py` reruns exact-marker/binding/call assertions over saved host
responses; `acceptance-assertions.json` is its successful final summary.

* Fresh edit/revert: session `ses_ef03ac630ffe7u7bJDqBFF28cB` first returned
  `SECRET_A_OAK_721`. Public revert stage/commit replaced its authoritative
  conversation with `SECRET_B_CEDAR_842`, returned exactly that marker, and the
  stored host context contained no A marker. ACP binding changed from
  `0a09c1a1-567f-4382-8012-0e2587e9dc47` to
  `c758dd80-157c-44a2-b516-4f401720bddd`; adapter epoch 0 → 1, host checkpoint
  epoch still 0. `acceptance-fresh-{A,B}-bindings.json`,
  `acceptance-fresh-B-{context,messages}.json`.
* Public fork: `ses_ef03ba69bffeJOto9NpDGJAmu4` returned exactly B from copied
  host history, with its own ACP binding
  `c149ed9d-547a-4b97-83b1-57ba93b51deb`, distinct from the parent's
  `c05d971c-c425-46fd-aef1-a7fcd8723750`. `acceptance-fork-messages.json` and
  `acceptance-after-fork-bindings.json`.
* Real provider away/back: the discovered enabled
  `opencode/ling-3.1-flash-free` actually completed a provider turn with exact
  `PROVIDER_AWAY_PINE_563`; returning to `antigravity-cli/gemini-3.8-flash`
  recalled exactly that marker. Host messages include both `model-switched`
  entries and both providers' assistant responses. No imported-history substitute
  was needed. `acceptance-provider-away-messages.json`,
  `acceptance-provider-back-{messages,bindings}.json`.
* Actual process restart: only the owned 18986 host was terminated and restarted
  with the same private storage. The existing session again returned exactly B;
  its fresh ACP binding was recorded in `acceptance-after-restart-bindings.json`.
  Later, completed public checkpoint `msg_10fcfa0fe001qI0Ht1DZr3mX1z` survived a
  further actual restart and exact B continuation. Fresh RPC reported committed
  host epoch 1, sequence 3 and source binding
  `21f6a9d5-ca0e-4e33-bda3-d4c487e5a572`. Immediate post-compaction RPC was still
  stale epoch 0; it is preserved rather than claimed as instantaneous event
  convergence. `acceptance-checkpoint-{context,restart-messages,restart-rpc}.json`.
* Parked-call model change, **after the fix below**: session
  `ses_ef035f76fffexqzTcfHJilrMqT` exposed one foreground 18-second shell call,
  `toolu_3bf5130390cf49a280f629475e1cd642`. While it ran, public model selection
  changed to the low variant. Its original result completed; the new-profile
  reply was exactly `PARKED_FIXED_ASH_492`, and stored history had exactly one
  executable call. The ACP binding rebuilt at adapter epoch 1.
  `acceptance-parked-fixed-{exposed,messages,bindings}.json`.
* Installed host encoder image/steering: a disposable public plugin tool returned
  only an image file (80×80 red PNG data URI, no textual color description).
  The host stored completed `AcceptanceImage` call
  `toolu_309658d93345409fb89132cbb6cb88d0` in session
  `ses_ef0346bd1ffetF8Ul472TfIBfk`. A user steering input was admitted while it
  ran; the final response was exactly `red IMAGE_STEER_BEECH_927`, with one tool
  call. This exercised the actual installed host tool-result encoder, local
  plugin bridge and authenticated ACP image path, not a fabricated encoder
  response. `acceptance-image-{exposed,messages}.json`.
* Actual telemetry integration: `telemetry-integration.ts` used the official
  installed OpenChamber `@opencode/client` and actual `ContextOccupancyOwner`
  against both the native authenticated host and running OpenChamber proxy.
  RPC occupancy read, owner disconnected-stale state and read resync passed.
  `event-integration.ts` delivered live plugin `changed` events to that consumer
  through both native and proxy streams. Both also captured the same authoritative
  `session.model.selected` event `evt_10fcdfa56001mBzQP2u2gn5Dpv`, including
  previous/new selection, location, and durable aggregate sequence.
  `acceptance-telemetry-{integration,events}.json`.
* Real upstream disconnect: the first SDK-only stream attempt failed with
  `ECONNRESET` on host termination; the SDK does **not** automatically reconnect
  here. A subsequent explicitly retrying integration harness recovered native
  and proxy streams after the actual restart and received fresh checkpoint epoch
  1 telemetry. `acceptance-reconnect-integration.log` preserves the failed
  attempt; `acceptance-reconnect-retry.log` and
  `acceptance-reconnect-events.json` preserve the executed recovery. This proves
  network/runtime recovery with explicit retry, not a UI reconnection claim.

## Concrete failure fixed and regression

Before the change, parked model switching completed the original shell call
`toolu_a51ebf1be3804b1c9250cd360b486ac8`, then requested the same command again
as `toolu_cb1499f8efb14b2696861b19f0c1d2d8` under the new profile. A correct final
marker did not make this a pass. `acceptance-parked-after-messages.json` retains
both calls.

The rebuilt prompt's tool-result envelope did not explicitly identify the input
as continuation of already-executed host calls. `hostResultMessageToAcp` now does
so, preserves original result IDs/media and new steering, and directs continuation
rather than re-execution merely because ACP context rebuilt. Added normalization
regression and strengthened the existing model-switch prompt regression.
The same actual host scenario passed after the change with one call. This is not
a promise that arbitrary models can never intentionally request the same tool
arguments twice; no semantic deduplication or invented execution authority was
added.

## Initial terminal failure (subsequently fixed)

The disposable public plugin registered a schema-valid `StructuredOutput` tool.
The host accepted `toolu_2e56138e8d3545a08b9d1092a37697d0` in session
`ses_ef0351ba9ffe49WnD13xKqVbLR`; durable acceptance event
`evt_10fcb208b0010IZRGGpWLXGyO5` and original result digest exist. Follow-up
returned `TERMINAL_CONTINUED_FIR_734` with exactly one historical tool call, so
no terminal call was re-emitted.

However, the host treated this as an ordinary tool and attempted another provider
step; adapter retirement raced that continuation and the host stored
`agy_cancelled` / idle `failed`. **Clean terminal host acceptance failed.**
`acceptance-terminal-first-messages.json` and
`acceptance-terminal-continuation-messages.json` retain both outcomes. Installed
public `Tool.Info/Options/Result` has no terminal/stop/finish option;
`session.prompt` and `Config.AgentEncoded` expose no structured terminal-output
schema. This arbitrary named tool is not proof of a native host terminal-output
contract. The cancellation was a feasible plugin bug, not an API prerequisite:
name-based retirement incorrectly aborted an ordinary host tool continuation.
The fix and successful current acceptance are documented immediately below.
Only native immediate loop-stop without another provider step needs an actual
supported terminal-output contract. Private durable `tools` records hold
call-correlated acceptance, not remote delivery acknowledgement.

## Ordinary StructuredOutput fix and successful actual host rerun

`session.tool.success` now routes to `recordHostToolSuccess`, which retains the
existing call-correlated receipt but never aborts ACP or releases an MCP waiter.
The legacy durable field `terminalAcceptance` is compatibility data, not turn
completion authority. Removed name-based short idle retirement and replacement
of accepted calls with synthetic terminal-history text. The original host result
is persisted/delivered by the ordinary result path, and completion awaits real
ACP terminal output. No fabricated success, delay, or private API was added.

The real local plugin/public host rerun used session
`ses_ef025d3acffeDhmHzQ5nrrRg4H` and exactly one completed call
`toolu_6ac0a01fee7e40d3bb0cff35f8c2d7a3`. Original host JSON result was exactly
`{"marker":"STRUCTURED_FIXED_LARCH_963"}`. The durable record has result digest
`4f95fd837c8dfdd796efff1b6dc355a62b8c9a85d24d2d46d50e212c41f37dff`,
delivery `locally-handed-off`, and correlated success event
`evt_10fda82c30014HEvLRpIeKxFi0`. This is local handoff evidence, not remote MCP
acknowledgement. Real ACP continuation produced exactly
`STRUCTURED_COMPLETED_LARCH_964`; host assistant
`msg_10fda82e1001IoJLX1ASSUvXcm` stored `finish: stop` / `rawFinish: end_turn`.
Host idle `msg_10fda9160001U3cQFhae0G7zN4` stored `outcome: succeeded`.
There was no error assistant or failed idle. Tool-free follow-up returned exactly
`STRUCTURED_FOLLOWUP_LARCH_965` with still exactly one historical executable call.

Evidence: `acceptance-terminal-fixed-{session,first-messages,followup-messages,
bindings,tool-record}.json` under the same private disposable evidence directory.
Assertions executed against actual host-stored responses and durable records.
The host was restarted with the local changed plugin for this run; the shared
service was untouched. Native schema-enforced immediate stop without a provider
continuation remains unavailable, and is not confused with this supported,
successful ordinary-tool scenario.

Deterministic regressions now exercise original/duplicate tool success before
result delivery, delayed old-call success while a newer call is pending, and
duplicate new-call success, requiring original result delivery and real ACP
completion in every case. The plugin event-loop test likewise keeps the original
waiter active after success and requires the actual host result before completion.

`buildBoundedHistory` also no longer calls `slice(-0)`, which previously copied an
entire 10,000-character entry into a 40-character history budget. It now clips the
omission marker itself to remaining payload space, accounts for separators, and
includes a suffix only when space is positive. Regression payload limits 1, 10,
24, and 40 remain bounded, including when a recent entry is retained. The fixed
authority envelope is separate from this history-payload budget.

## Genuine remaining prerequisites

The actual selection events and stored `model-switched` history do not provide
CAS. Current fallback handling is telemetry only: there is no pending switch
proposal/action queue to invalidate, and no automatic host selection writer.
No unsafe read-then-switch implementation was added. A future proposal/action
implementation must invalidate on these authoritative events/history and on
subscription loss, then still require an atomic public selection guard.

Previously reviewed prerequisites remain unchanged: authoritative effective
`compaction.auto/buffer` is not public plugin context; `switchModel` has no CAS;
remote MCP delivery acknowledgement has no supported protocol. Paired encrypted
relay, rendered UI, authenticated host SIGKILL boundary matrix and exhaustive
process-death stress are not established by this slice. Existing integrated
fixture SIGKILL evidence remains separately documented.

## Fresh checks

* Refreshed final `npm run check`: TypeScript build; 137 passed, 3 skipped,
  0 failed; 140 tests / 952 assertions. `terminal-fixed-check.log`.
* Refreshed `npm run test:live`: 3 passed, 0 failed, 7 assertions;
  `terminal-fixed-acp-live.log`.
* Exact evidence assertions: `python3 assert-evidence.py` passed, including the
  historical terminal failure and preserved pre-fix duplicate calls. The later
  actual ordinary-StructuredOutput live assertions passed separately as above.

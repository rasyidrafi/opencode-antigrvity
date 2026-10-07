# Context estimation and actual ACP usage — 2026-10-06

Direct investigation without delegation, against installed OpenCode 2.0.22,
plugin 0.5.0, and authenticated official ACP 1.3.0. No host accounting or
production auto-compaction policy was changed.

## Actual authenticated observations

Two consecutive prompts in one tool-disabled Gemini 3.8 Flash High ACP session
emitted `usage_update { used: 3331, size: 1048576 }`, then
`usage_update { used: 3469, size: 1048576 }`. Both terminal responses were exactly
`{ stopReason: "end_turn" }`: no terminal token breakdown. Raw sanitized probe
output is `/tmp/opencode/acp-usage-real-probe/results.json`.

A live workspace-scoped host model read confirmed Gemini's advertised limits:
`context: 1048576`, `output: 65536`. The account's exact ACP inventory contained
Gemini models only; an initial Claude attempt was rejected as unsupported. This
audit does not claim a live Claude usage observation.

The new live regression independently observed 3,358 → 3,508 tokens with the
same 1,048,576 capacity and no terminal accounting on either turn. The full live
run had three passes and one upstream TLS model-discovery failure; the affected
stream/resume/image test passed on a targeted retry. This was not hidden or
reported as an initially clean full-suite pass. Logs are under the same private
probe directory. The offline check passed with the live checks skipped.

`test/acp-live.test.ts` now contains an opt-in regression observing occupancy and
terminal-accounting availability independently. The test deliberately does not
require accounting to remain absent in future server releases.

## What the host estimates

Verified OpenCode 2.0.22 source `packages/core/src/session/compaction.ts`:

- `estimatePrompt` finds the latest non-error assistant from the same provider
  with positive input/cache tokens. Zero placeholders do not become anchors.
- Without an anchor it estimates current instructions, tool definitions and the
  reconstructed transcript. With an anchor it adds unmeasured subsequent content.
- Text/reasoning uses `Math.round(text.length / 4)` from `util/token.ts`.
  Tool definitions include name, description and serialized schema; calls include
  name and serialized input; results include actual serialized/text content.
- Images have a 1,500-token estimate; PDFs 2,000. These are estimates, not measured
  billing and not ACP occupancy.
- The threshold is `limit.input || limit.context`, less an explicit buffer or
  `max(floor(window * 0.1), 16000)` when the window permits that reserve.

For the observed 1,048,576-token Gemini window and default buffer, the threshold
is **943,719 estimated tokens**. For an exactly 1,000,000-token window it is
900,000. At four characters/token, text alone would be about 3.77 million
characters for Gemini, before counting instructions, tools and media.

The actual pure host token estimator and extracted unmodified ceiling function
were executed, not just paraphrased: 400,000 ASCII characters estimated 100,000
tokens, default Gemini ceiling was 943,719, and an explicit 200,000 buffer made
it 848,576. Results: `estimate-source-execution.json` in the private probe folder.

The host checks before each model attempt. A text-summary checkpoint remains
locally estimable; the guard for unmeasured *native provider replacement*
checkpoints does not disable estimation after this adapter's text summaries.

## Why occupancy cannot be returned as billed input

The official server's examined `_maybe_send_usage_update` computes latest-call
context from differences in cumulative trajectory usage. Its `_extract_tokens_used`
combines prompt, cache, candidates and thinking. It emits only `used/size`, not
those separate underlying counters. Notifications happen around completed model
calls, not necessarily once per generated token.

The SDK's `UsageUpdate` defines occupancy. Its optional terminal `Usage` defines
separate token categories; protocol support does not mean this server supplies
them. The live responses demonstrate that distinction. The adapter already
forwards genuine terminal accounting when supplied and publishes occupancy via
plugin RPC, events and `/v1/usage` without manufacturing billing categories.

Writing `used` into Anthropic `input_tokens` would call prompt + generated output
+ thinking + cache "uncached input", misstate billing, and establish an invalid
host measurement anchor. It may also count generated output again in subsequent
context estimates. Inventing categories from the total cannot recover the missing
information.

OpenCode AI can represent `contextTokens`, but installed core
`session/usage.ts` persists only input/output/reasoning/cache and its compaction
estimator uses those fields. An extra field alone does not connect occupancy to
the native trigger. Adapter-owned telemetry admission remains inactive because
the public plugin context does not expose the effective host auto/buffer policy.

Therefore current native proactive compaction uses the host's honest local
estimate. Occupancy is real but separate. A supported core occupancy-trigger
contract, or authoritative host policy access for plugin admission, would connect
the two without falsifying billing.

# Real token breakdown recovery: possible — 2026-10-06

Research performed directly, without subagents. This is an authenticated live
proof using a temporary instrumented server, **not a production installation**.
It supersedes any inference that the backend cannot supply token categories:
the stock ACP wire omits them, but the internal backend does have them.

## Reverse-engineered path

The official 1.3.0 `agy_acp_server.par` is an ELF executable with an embedded
`.par_data` ZIP containing Python source and CPython 3.14 bytecode.

1. Extracted the exact installed server, SDK types, event processor and schema.
2. Traced local harness `usage_update.agents` through
   `event_processor.parse_usage_metadata` into per-trajectory cumulative counters.
3. Traced server `_read_current_usage` and `_maybe_send_usage_update`: the
   counters reach the Python adapter but it emits only aggregate `used/size`.
   Its final `PromptResponse` omits the optional `usage` field even though its
   bundled schema already supports that field.
4. Instrumented only a private copy of `server.py`: captured raw counters,
   recorded a pre-prompt baseline, returned actual counter differences, and
   attached raw research metadata to occupancy notifications.
5. Repaired the copy's ELF archive section size, ZIP relative offsets and stale
   compiled-module indexing. Merely appending changed source did not work: the
   importer continued executing the original bytecode. Those failed attempts
   remain in the private research logs.
6. Ran the instrumented copy through real ACP transport with the original
   companion harness and authenticated Gemini inference. The three-turn test
   included process shutdown, restart and ACP session resume before turn three.

No authentication, permission handling or tool filtering code was changed.
No production compatibility hash was relaxed. The research transport instantiated
the worker directly for the modified copy; normal production worker creation
continues to reject the unknown modified executable.

## Live results

| Turn | Uncached input | Cache read | Visible output | Reasoning | Restarted/resumed |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 3271 | 0 | 1 | 31 | no |
| 2 | 3380 | 0 | 9 | 39 | no |
| 3 | 3433 | 0 | 9 | 29 | yes |

These are underlying backend counters, not guessed subdivisions of `used`.
The raw cached-read counter really reported zero in these runs; nonzero cached
reads were **not** observed. Cache-write tokens were not supplied and were not
invented. No claim is made about price or quota.

Example returned wire response from turn two:

```json
{
  "stopReason": "end_turn",
  "usage": {
    "totalTokens": 3428,
    "inputTokens": 3380,
    "outputTokens": 48,
    "thoughtTokens": 39,
    "cachedReadTokens": 0,
    "_meta": { "researchOnly": true, "scope": "prompt-turn-delta" }
  }
}
```

The inclusive output count contains visible output plus reasoning. The Go
harness excludes cached input from `prompt_token_count` on this path, so inclusive
ACP input adds the separate cache-read count, matching the server's own occupancy
normalization. The existing adapter mapped this response to Anthropic usage
successfully. Assertions confirmed every returned count matched the raw
before/after backend difference and occupancy, including resume without counting
previous turns again.

Do not silently mix session-cumulative ACP accounting with per-turn accounting:
the probe labels its exact semantics. General production handling still needs
versioned scope normalization and deduplication across multiple model calls,
tool continuations, cancellation and resume. A final turn's accumulated billed
input also need not equal its final live-context occupancy when several model
calls occurred.

## Evidence and production boundary

Private reproducible source/probe/evidence:
`/tmp/opencode/acp-usage-reverse/` (`probe.ts`, extracted instrumented `server.py`,
`live-results.json`, `live-probe.log`, `assertions.json`, research executable).
Credentials are kept private and are not part of this document or npm artifacts.

Verified original executable SHA-256 remained unchanged:
`cf6feaebdacfc2255dcfc8883db99b15de8554698554e2a1e78e5ccec1c68a20`.

**Conclusion: possible, with a backend adapter change.** Stock official ACP
1.3.0 does not export these counters, but a narrowly instrumented copy demonstrably
can. Deployment would require a reviewed/version-pinned extension or upstream
change and regression coverage—not pretending stock 0.5.0 now exposes accounting.
The installed plugin/server remain unchanged.

## Subsequent stock-server finding

Later research found a second path that does **not** require an instrumented
executable: the stock server's isolated SQLite `steps.metadata` persists actual
per-call input/output/reasoning/cache counters. Four real prompts produced five
model calls, including nonzero cache reads of 32,701 tokens. A subsequent stock
restart/resume produced one new call at index 11 and recalled the original tool
marker. Thus the earlier binary-change deployment conclusion is superseded by
an optional compatibility-profiled read-only storage integration avenue.

The stock reader is a prototype, not production-ready or installed. See
`production-followup-research.md` for schema/ownership/attribution guards and
remaining acceptance gates. Original instrumented experiments remain historical
evidence, not an assertion that production needs a modified binary.

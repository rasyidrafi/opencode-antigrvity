# @rasyid_rafi/opencode-antigravity

An OpenCode V2 provider plugin for Google's official Antigravity ACP server.

This checkout is unreleased lifecycle work, not a completed release. See
[`docs/phase8-validation.md`](docs/phase8-validation.md) for F01–F18 evidence
and remaining acceptance gates. Published installation instructions below do
not imply that the registry package contains this checkout's changes.

```text
OpenCode → loopback Anthropic Messages proxy → ACP JSON-RPC client →
agy_acp_server.par

Antigravity tool call → session-bound MCP bridge → OpenCode tool + permissions
                     ← tool result             ←
```

## Requirements

- OpenCode V2 (tested against `2.0.22`);
- Google's `agy` CLI, already signed in to your personal Google account.

The official server is listed in the [ACP Registry](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp).

## Install

Install the plugin:

```sh
opencode plugin add @rasyid_rafi/opencode-antigravity
```

Or register it in `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@rasyid_rafi/opencode-antigravity"]
}
```

Select an **Antigravity ACP** model and send a message. No `/connect`, API key,
or second Google sign-in is needed when the CLI is already authenticated.
This also applies to OpenChamber.

## Dual context and checkpoint lifecycle

OpenCode owns authoritative conversation, instructions, edits and checkpoints.
ACP context is a replaceable execution cache. A proven append sends the unseen
chronological suffix; edits, deletions, reorderings, incompatible profiles and
missing alignment evidence rebuild instead of resuming unverified remote memory.
Forked host sessions have separate bindings.

Summary generation uses isolated tool-free utility workers and is not a commit.
The host's `session.compaction.ended` checkpoint advances the durable epoch;
failure preserves the prior host baseline. The next primary turn reconstructs
the accepted summary, host-retained recent tail and current instructions in a
fresh ACP session. Late events and old-epoch telemetry cannot commit twice.
Oversized summaries use ordered bounded reduction; empty, cancelled or truncated
summaries fail rather than becoming successful checkpoints. Budget estimates are
conservative byte-based estimates, not exact tokenizer measurements.

ACP internal compaction changes occupancy, not the OpenCode checkpoint or host
conversation. Instructions are explicit envelopes, not native system authority.

The plugin reuses an installed ACP server. If missing, the first request downloads
Google's official ACP **1.3.0** server and companion automatically into
`$XDG_DATA_HOME/opencode-antigravity/acp-server-1.3.0/` (default:
`~/.local/share/opencode-antigravity/acp-server-1.3.0/`). The first request can take
longer while downloading. Downloads support Linux, macOS, and Windows on x64/arm64.
Google's archive URLs are taken from the ACP Registry; no system installer is needed.

An explicit `OPENCODE_ANTIGRAVITY_ACP_PATH` takes precedence and is never replaced.
Custom arguments can be supplied with `OPENCODE_ANTIGRAVITY_ACP_ARGS` as a JSON array;
Linux defaults to `["--uid="]`.

## Authentication

The plugin reuses the official CLI's existing OAuth login when it finds
`~/.gemini/antigravity-cli/antigravity-oauth-token` (or the equivalent path
under `GEMINI_HOME`). It seeds the ACP server's local credential file so the
first OpenCode request does not start a second browser login. Malformed ACP
credentials are repaired and CLI account changes are picked up on the next worker.
The CLI's original credential file is never modified. Credentials stay
on the local machine and are not sent through the OpenCode proxy. The V2
integration automatically stores only a fixed local API marker (`opencode-antigravity-local`);
Google credentials remain in the official ACP server's local auth store.

Existing non-personal ACP authentication is preserved. Advanced users can select
`oauth-business`, `gemini-api-key`, or `agent-platform` through the official ACP
server; `OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD` remains an optional override.

## Configuration

### OpenCode tools and permissions

Tool definitions from each OpenCode request are exposed to Antigravity through
a local MCP bridge. Antigravity's call is returned as an Anthropic `tool_use`;
OpenCode evaluates permissions and executes its own tool. The resulting
`tool_result` completes the pending MCP call, continuing the same ACP turn.

Shell, skill loading, subagents, questions, and installed plugin/MCP tools use
their actual OpenCode implementations. Global, agent, and session permission
rules—including `ask`, `deny`, and command/path-specific rules—remain owned by
OpenCode. Subagents create real OpenCode child sessions with their configured
agents and models. Tools are not approximated with Antigravity equivalents.

The bridge disables ACP built-in tools and direct filesystem/terminal callbacks.
Workers use a private Gemini home and empty ACP workspace under
`host-acp/<scope>/`, carrying only authentication settings and credential files
(private permissions on POSIX). Global Antigravity MCP servers, hooks and skills
are not imported; host tools execute in the actual OpenCode workspace. Google
credentials are never exposed through MCP. This mode requires official ACP
1.3.0 or a compatible implementation of its tool-filter extension.

Host system instructions are forwarded in a dedicated instruction block on each
new user turn, outside the bounded history budget. Instruction changes and user
steering during tool execution accompany the next completed tool-result group.
ACP still receives user content, not a native system-role override.

Parallel calls can share a host step. Partial results are retained until all
calls in that step have results. Cancelling the OpenCode session interrupts its
ACP turn and invalidates its MCP endpoint. A lost/restarted bridge reconciles
saved calls and original host results; uncertain execution fails closed rather
than re-executing tools. Tool selection currently supports
`auto`; forced/required tool choices are rejected explicitly.

### Dynamic model catalog

The picker uses the official ACP server's `session/new` and `session/load`
model choices, preferring `configOptions` (`category: "model"`) over legacy
`models.availableModels`. Discovery creates a session but sends no inference prompt
and does not initiate an interactive sign-in.

The plugin keeps exact ACP IDs for requests, including opaque IDs such as
`gemini-pro-agent`. Only explicitly named, matching effort siblings are grouped
into variants; unfamiliar models stay selectable under their original IDs.
The picker and proxy validation are refreshed together on configuration updates.
Background checks run once a minute, with fresh discovery at most once every
10 minutes unless a refresh is explicitly requested. A failed refresh retains
the last successful catalog for the same account, auth mode, client, and server
installation. A first-time failure shows no fabricated model list.

ACP may expose fewer models than `agy models`: availability can depend on the
account, authentication method, and client surface. The plugin never adds models
that are absent from ACP's advertised choices.

Optional models.dev enrichment refreshes daily and supplies underlying-model
token-limit estimates for known matches. It never determines availability,
rewrites wire IDs, or imports direct-API prices as Antigravity subscription costs.
Unmatched models are labelled **limits estimated** and use conservative defaults
(32,768 context / 8,192 output). Bundled metadata is retained if enrichment is offline.
Set `OPENCODE_ANTIGRAVITY_MODELS_DEV=0` to disable external metadata fetching.

Catalog caches live under `model-catalogs/` in the plugin's data directory;
filenames use an account/configuration digest, not stored login credentials.

### Environment

| Variable | Purpose |
|---|---|
| `OPENCODE_ANTIGRAVITY_ACP_PATH` | ACP server executable path |
| `OPENCODE_ANTIGRAVITY_ACP_ARGS` | JSON array of ACP server arguments |
| `OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD` | ACP authentication method |
| `OPENCODE_ANTIGRAVITY_ACP_PERMISSION=allow-always\|allow-once\|deny` | Legacy direct-worker policy; provider tools always use OpenCode permissions |
| `OPENCODE_ANTIGRAVITY_MODE=plan\|accept-edits` | ACP session mode when advertised |
| `OPENCODE_ANTIGRAVITY_PROXY_PORT` | Loopback proxy port; default ephemeral |
| `OPENCODE_ANTIGRAVITY_DATA_DIR` | Session metadata and request replay directory |
| `OPENCODE_ANTIGRAVITY_MODELS_DEV=0` | Disable optional models.dev metadata fetching |
| `OPENCODE_ANTIGRAVITY_DEBUG=1` | Metadata-only debug logging |
| `OPENCODE_ANTIGRAVITY_MAX_REQUEST_BYTES` | Maximum request size |
| `OPENCODE_ANTIGRAVITY_REQUEST_READ_TIMEOUT_MS` | Timeout while reading an HTTP request |
| `OPENCODE_ANTIGRAVITY_SSE_HEARTBEAT_MS` | Loopback SSE heartbeat interval |
| `OPENCODE_ANTIGRAVITY_TURN_STALL_MS` | Idle timeout after the last ACP session update |
| `OPENCODE_ANTIGRAVITY_PRINT_TIMEOUT_MS` | Setup/request timeout, not a streamed-turn limit |
| `OPENCODE_ANTIGRAVITY_IDLE_WORKER_MS` | Idle session cleanup interval |
| `OPENCODE_ANTIGRAVITY_HOST_IDLE_MS` | Parked MCP bridge lifetime without a host continuation; default 2 hours |
| `OPENCODE_ANTIGRAVITY_MAX_SESSIONS` | Maximum concurrent ACP sessions |
| `OPENCODE_ANTIGRAVITY_MAX_QUEUE` | Maximum queued turns per session |
| `OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS` | Maximum host conversation history size |
| `OPENCODE_ANTIGRAVITY_UTILITY_MAX_CHARS` | Maximum prompt size for utility requests |

Active turns do not have a default wall-clock limit. They time out only after
`OPENCODE_ANTIGRAVITY_TURN_STALL_MS` has elapsed since the last ACP `session/update`.
`OPENCODE_ANTIGRAVITY_PRINT_TIMEOUT_MS` covers setup RPCs and does not cut off an
actively streaming turn.
While waiting for OpenCode tool results or approval, the ACP stall watchdog is
paused. The bridge lifetime above still applies.

Code that creates an ACP worker may set `onActivity?: () => void` in
`AcpWorkerOptions`. The callback runs for each accepted ACP `session/update`
during an active turn. It is a heartbeat signal, not a completion callback.
Active turns use this idle timeout behavior rather than a wall-clock deadline,
so a stream can run as long as it keeps sending updates.

## Supported input

Text and image input, with text output, are supported. Images may be sent
as base64 data URLs or local files inside the configured workspace. Audio,
file/document/PDF blocks, remote URLs and video are rejected before inference.

The provider advertises text/image input and OpenCode tool support only.
Tool results preserve text, error status, and base64 images. Other tool-result
media types are rejected explicitly. Tool calls and their results appear in
OpenCode's normal tool UI. Duplicate ACP tool activity is suppressed in the MCP
bridge; genuine model thinking and other status notices remain available.

Promoted tool-result images are associated by call metadata or an unambiguous
immediate result group. Ambiguous images remain ordered user context. Image
steering during a parked tool continuation is carried through MCP with text.

| Request control | Contract |
| --- | --- |
| Model / effort | Exact discovered ACP IDs; explicit effort wins. Family defaults are stable across sessions. Requested/actual fallback IDs are telemetry, not an automatic host selection override. |
| Tool choice | `auto` only; forced/required/none modes are rejected. |
| Temperature | Intentionally stripped; ACP owns sampling. One bounded diagnostic per loaded module. |
| top-p / top-k / stop sequences | Explicit overrides rejected; no native enforcement claimed. |
| Native JSON schema | Unsupported. A host tool named `StructuredOutput` retains ordinary host validation and original result delivery; its name or success event does not stop the provider turn. Completion awaits the real ACP terminal response. |
| max_tokens | Advisory routine budget accepted; never subtracted from the adapter's input-byte cap. Planning reserves the advertised model output/window independently. Not a backend generation-limit guarantee. |

Host-tool execution requires a reviewed binary/companion compatibility profile,
not a version string. Currently only the exact official ACP 1.3.0 Linux x64
distribution is reviewed. Other platforms/builds and unknown overrides fail
closed with `agy_acp_compatibility`; they need a reviewed profile before use.
Tests inject a fixture validator in test code, not a production environment bypass.

Discovery and workers share one effective authentication scope, including method,
account credential revision, GCP configuration, endpoint and ADC context. Keys
contain digests only. Overrides are reflected in isolated settings; original
CLI authentication settings are not changed to apply an override.

Completed response payloads expire after seven days; compact replay tombstones
remain, and missing payloads never authorize repeat execution. Legacy payloads
begin their retention window on migration. Active, parked, uncertain and durable
tool-result recovery evidence is retained conservatively. Large completed tool
results expire only with a completed originating receipt and no live owner;
call identity, arguments/result digests and profile remain, allowing matching
host-authoritative results to rehydrate the tombstone. Corrupt request receipts
are privately quarantined and replaced by fail-closed uncertain tombstones.
Abandoned private utility directories are collected after seven days only when
their owner is provably dead. GC never targets source CLI credentials or unrelated
caches. Isolated auth homes and legacy/unattributed tool-result records currently
remain conservative evidence rather than receiving blanket age-based deletion.

MCP body reads have an 8 MiB limit and 15-second deadline. Cancellation maps the
MCP request ID to its bridge and interrupts the originating turn; it is never a
successful empty result. Requests with `_meta.progressToken` that accept SSE
receive an initial waiting notification and transport keepalive comments until
the real result/error. JSON-only peers receive JSON, not a keepalive guarantee.
The bridge's idle TTL is not a transport timeout guarantee.

Host lifecycle subscriptions reconnect with bounded exponential backoff/jitter.
After unexpected loss, telemetry is stale; reconnection retires questionable
bindings. The public active-context API reconciles new completed checkpoint IDs
against the durable observed baseline, including missed completion events; late
events cannot advance the same checkpoint twice. Without a prior baseline, the
next request remains the conservative reconstruction backstop. Missing checkpoints
alone never prove compaction failure. Durable tool results survive reconciliation.

Host session deletion tombstones late requests immediately, retires workers, and
cleans indexed private records only after turn/result ownership is released.
Pending cleanup retries and is rediscovered on restart. Source CLI credentials,
shared isolated authentication homes and unattributed legacy evidence are untouched.
Lifecycle, context, admission, tool, deletion/index and malformed inventory-cache
records are quarantined privately and fail closed (optional caches rediscover).

Automatic host fallback selection remains blocked: V2's public `switchModel`
accepts only session/model, with no expected-selection or revision condition.
Read-then-write can overwrite a concurrent newer user selection. Until the host
provides an atomic guard or serialized selection facility, fallback is telemetry
only; this plugin does not claim race-safe automatic selection updates.

## Sessions and retries

The adapter records requests before sending prompts to ACP. A repeated
completed request replays the saved response. A request that failed or was
interrupted after submission is rejected on retry; send a new message to
continue. OpenCode V2's `model.request` hook does not expose a message ID, so
V2 requests use a hash of the normalized conversation and current prompt as
their replay identity. Identical retries are protected; a changed request body
cannot use a host message ID to recover the previous receipt.
Transient V2 `generate` requests use disposable ACP workers and never join the
primary chat's persistent ACP session.

Session turns and metadata updates use local process locks. Another OpenCode
process cannot run a turn in the same session while one is active.

`OPENCODE_ANTIGRAVITY_DATA_DIR` defaults to `$XDG_DATA_HOME/opencode-antigravity`, or
`~/.local/share/opencode-antigravity`. It contains `sessions.json` and request receipts
under `requests/`. Completed receipts include response events, including text,
reasoning, and tool activity, up to 2 MB per request. Larger responses retain a
completion marker and reject retries instead of executing again. Directories
use mode `0700` and files use `0600` on POSIX filesystems. Request receipts remain
after idle session metadata is pruned. Deleting them removes retry protection
for those requests.

## Local endpoints

- `GET /health`;
- `GET /v1/models`;
- `GET /v1/usage`;
- `POST /v1/messages`.

The private `/mcp/<session-token>/<catalog-hash>` endpoint serves Streamable HTTP
MCP for ACP. Tokens are random, session-bound, and revoked on bridge shutdown;
the fixed proxy marker cannot authorize an MCP call.

Requests require the loopback marker `x-api-key: opencode-antigravity-local`.

## Tests

```sh
npm run check
```

The test command requires Bun 1.3 or newer.

The live test requires an authenticated official ACP server:

```sh
OPENCODE_ANTIGRAVITY_ACP_LIVE=1 \
OPENCODE_ANTIGRAVITY_ACP_PATH=/absolute/path/to/agy_acp_server.par \
OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD=oauth-personal \
npm run test:live
```

Review Google's current [terms](https://antigravity.google/terms) before using
subscription authentication through a third-party host.
## Context telemetry (V2)

The plugin records ACP `usage_update.used/size` as replacement occupancy snapshots,
not billed token usage. Snapshots are version 1 and scoped to the host compaction
epoch. A committed host checkpoint reads as `unknown` until fresh telemetry;
measurements older than five minutes read as `stale`. ACP internal compaction
does not commit a host checkpoint.

Authenticated `GET /v1/usage` requires the same local API key as `/v1/messages`
and the `x-opencode-antigravity-session` host-session header. It returns one snapshot,
never all sessions. The V2 RPC domain `antigravity-context-v1` exposes `read`
with `{sessionID}` and the live-only `changed` event. RPC reads and events are
restricted to the plugin location. Resync with `read` after reconnecting; events
may be missed. The snapshot includes epoch, sequence, observation time, source
ACP session, requested model, used, size, and state. `model` is present only when
ACP reports its actual current model; `requestedModel` is never substituted for
that evidence. Race-safe automatic host model-selection updates remain blocked.

Clients can import the versioned RPC definition:

The sibling OpenChamber integration is implemented and independently reviewed
(73 reported passing client tests), but is a separate unreleased client change.
It prefers matching fresh ACP occupancy, resyncs after missed events, and shows
unknown/stale rather than substituting billing totals. The core OpenCode TUI
meter is unchanged. This plugin alone does not ship that client UI.

```ts
import { ContextTelemetry } from "@rasyid_rafi/opencode-antigravity/rpc"

const telemetry = client.rpc(ContextTelemetry)
const snapshot = await telemetry.read({ sessionID })
const unsubscribe = telemetry.events.on("changed", event => {
  // Check event.location, hostSessionID, epoch, and sequence before displaying.
  console.log(event.data)
})
```

Automatic occupancy-driven admission is **blocked on the installed V2 API**:
`@opencode/plugin` 2.0.22 supplies `ctx.session.compact`, but neither its Promise
nor Effect context exposes effective `compaction.auto/buffer` configuration.
Plugin options are not those settings. The tested durable admission engine
remains inactive rather than ignore `auto: false`, guess a buffer, or discover
an unrelated service. Manual host compaction still works. See
[`docs/phase3-4-validation.md`](docs/phase3-4-validation.md) for exact evidence.

Occupancy never establishes measured billing. Terminal ACP usage is a turn
aggregate, not a delta per repeated result. Inclusive `inputTokens` is lowered
to Anthropic non-cached input by subtracting `cachedReadTokens` and
`cachedWriteTokens`; those counts retain their separate cache fields. Reasoning
is retained as an output subset. Missing accounting remains protocol zero
placeholders, not measured zero usage. Contradictory cache totals are not used.
Submitted/uncertain replay receipts fail closed; only verified completed cached
responses replay without executing again. Legacy hashes remain conservative
tombstones. Definite structured pre-execution rejection may resubmit; a quota
message alone, even before any text, is not evidence that work was rejected.

Remaining acceptance gates include OS-kill injection at every call/result/delivery
boundary, independently recorded delivery/acknowledgement transitions and complete
tool-record migration/quarantine validation. Durable recovery requires the
originating host assistant call and original results; missing evidence fails
closed, not permission to repeat a side effect. The disposable live host proved
shell/skill/foreground-child execution and manual checkpoint continuation, not
the entire deterministic failure matrix.

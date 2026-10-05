# @rasyid_rafi/opencode-antigravity

An OpenCode V2 provider plugin for Google's official Antigravity ACP server.

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
ACP turn and invalidates its MCP endpoint. A lost/restarted bridge rejects orphan
tool results instead of re-executing tools. Tool selection currently supports
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

ACP text, image, and audio blocks are supported. Images and audio may be sent
as base64 data URLs or local files inside the configured workspace. Remote URLs,
PDFs, and video are rejected.

The provider reports ACP image/audio input capability and OpenCode tool support.
Tool results preserve text, error status, and base64 images. Other tool-result
media types are rejected explicitly. Tool calls and their results appear in
OpenCode's normal tool UI. Duplicate ACP tool activity is suppressed in the MCP
bridge; genuine model thinking and other status notices remain available.

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

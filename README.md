# @rasyid_rafi/opencode-antigravity

OpenCode V2 provider adapter for Google's official Antigravity ACP server.

## Install and use

Requires OpenCode V2 (tested with `2.0.22`), Bun 1.3+, and Google's `agy` CLI
already signed in. Review Google's [terms](https://antigravity.google/terms)
before using subscription authentication through a third-party host.

```sh
opencode plugin add @rasyid_rafi/opencode-antigravity
```

Alternatively, add `"@rasyid_rafi/opencode-antigravity"` to `plugins` in
`~/.config/opencode/opencode.jsonc`. Select an **Antigravity ACP** model and
send a message. Existing CLI OAuth is reused; no API key or second login is
needed for personal authentication. Original CLI credentials are not modified.

If missing, the official ACP 1.3.0 server and companion are downloaded into
`$XDG_DATA_HOME/opencode-antigravity/acp-server-1.3.0/` (default
`~/.local/share/opencode-antigravity/acp-server-1.3.0/`). An explicit
`OPENCODE_ANTIGRAVITY_ACP_PATH` takes precedence and is never replaced.

**Host tool isolation requires the exact official ACP 1.3.0 Linux x64
distribution, including its companion.** Both files are hash-checked. Other
builds/platforms fail closed with `agy_acp_compatibility`; a matching version
string is insufficient, even though download archives exist for other platforms.

## What works

Streaming text and image input, dynamic ACP model discovery, model effort,
OpenCode tools and permissions, cancellation, and manual host compaction.
Discovery uses exact advertised ACP model IDs, not a fabricated CLI model list.
Optional models.dev metadata estimates limits, not availability or subscription
prices; set `OPENCODE_ANTIGRAVITY_MODELS_DEV=0` to disable fetching it.

ACP supplies inference through a loopback Messages proxy. A session-bound MCP
bridge returns tool calls to OpenCode, which owns tool execution and permission
decisions. ACP built-in tools and direct filesystem/terminal callbacks are
disabled. Workers use an isolated Gemini home and empty workspace; global ACP
MCP servers, hooks and skills are not imported. Credentials are never exposed
through MCP. Cancellation interrupts the turn and revokes the bridge.

OpenCode owns conversation history and checkpoints. Proven appends resume ACP;
edits, missing alignment, incompatible profiles and failed resumes reconstruct
from host history. Manual compaction summaries use isolated tool-free workers;
only the host checkpoint commits the new epoch. Recent causal history, including
parallel calls/results and selected images, is retained within bounded budgets.
Required instructions/current content that cannot fit fails explicitly.
Instructions are user-content envelopes, not native system-role authority.

Submitted or uncertain requests fail closed on retry. Completed requests replay
saved responses; missing recovery evidence never authorizes repeating a tool.
Completed payloads expire after seven days while replay tombstones remain.
Do not delete receipts unless you intend to lose that retry protection.
Private ACP storage is not read for accounting or automatically garbage-collected.

## Support limits

Text and base64/local-workspace images are supported. Audio, PDFs/documents,
video and remote image URLs are rejected. Images are limited to 16 MiB each and
32 MiB per selected delivery. Historical text defaults to 100,000 UTF-16
characters; estimates are advisory, not exact tokenizer or billing measurements.

Tool choice supports `auto` only. Forced tool choice, explicit top-p/top-k/stop
controls and native JSON schema are unsupported. Temperature is stripped;
`max_tokens` is advisory rather than an ACP generation-limit guarantee.
Uncertain tool execution requires original host calls/results for recovery.
Automatic occupancy-driven compaction and automatic host model switching are
not implemented; manual host compaction remains available.

Usage is unavailable when upstream does not supply counters. Protocol zero
placeholders do not mean measured zero usage. Native terminal usage is a turn
aggregate; cached tokens are separated from inclusive input. ACP occupancy is
context telemetry, not billed token usage. No private-storage estimates are billed.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `OPENCODE_ANTIGRAVITY_ACP_PATH` | Explicit server executable |
| `OPENCODE_ANTIGRAVITY_ACP_ARGS` | Server arguments as a JSON array |
| `OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD` | Official ACP authentication method override |
| `OPENCODE_ANTIGRAVITY_DATA_DIR` | Private metadata/receipts directory |
| `OPENCODE_ANTIGRAVITY_PROXY_PORT` | Loopback port; default ephemeral |
| `OPENCODE_ANTIGRAVITY_HISTORY_MAX_CHARS` | Positive historical text cap; default 100,000 |
| `OPENCODE_ANTIGRAVITY_HOST_IDLE_MS` | Parked tool bridge lifetime; default two hours |
| `OPENCODE_ANTIGRAVITY_TURN_STALL_MS` | Idle timeout since the last ACP update |
| `OPENCODE_ANTIGRAVITY_PRINT_TIMEOUT_MS` | Setup/RPC timeout, not active streaming duration |
| `OPENCODE_ANTIGRAVITY_DEBUG=1` | Metadata-only diagnostics |

Active turns have no default wall-clock deadline. The stall watchdog pauses
while waiting for host tool results/approval; the bridge lifetime still applies.
Data defaults to `$XDG_DATA_HOME/opencode-antigravity` or
`~/.local/share/opencode-antigravity`, with private POSIX file permissions.

## Telemetry and local API

Loopback `/health` is public. `/v1/models`, `/v1/messages` and `/v1/usage`
require `x-api-key: opencode-antigravity-local`. Usage additionally requires the
`x-opencode-antigravity-session` host-session header and returns only that
session's snapshot. Private MCP endpoints require separate session-bound tokens.

The public `antigravity-context-v1` RPC remains compatible with OpenChamber:

```ts
import { ContextTelemetry } from "@rasyid_rafi/opencode-antigravity/rpc"

const telemetry = client.rpc(ContextTelemetry)
const snapshot = await telemetry.read({ sessionID })
const unsubscribe = telemetry.events.on("changed", event => {
  console.log(event.data)
})
```

Reads/events are location-scoped. Check host session, epoch and sequence; resync
with `read` after reconnecting. Occupancy becomes unknown after a checkpoint and
stale after five minutes. Requested model is not substituted for actual-model
evidence. This plugin does not ship a client meter UI.

## Development and support

```sh
npm run check
```

Authenticated live tests are opt-in and can consume account quota:

```sh
OPENCODE_ANTIGRAVITY_ACP_PATH=/absolute/path/to/agy_acp_server.par npm run test:live
```

Report the OpenCode/plugin/server versions, OS/architecture, error code and
redacted reproduction steps via [issues](https://github.com/rasyidrafi/opencode-antigrvity/issues).
Never include tokens or private conversations. Research and validation records
remain in `docs/` as historical evidence, not promises of implemented features;
the production stability plan and Phase 3 accounting gates are superseded.

# OpenCode Antigravity

An OpenCode V2 plugin that exposes Google's Antigravity ACP agent as an
`antigravity` provider. OpenCode owns the agent loop and calls the in-process
AI SDK `LanguageModelV3` adapter; the adapter starts a separately installed
ACP server and bridges OpenCode tools to it. This is not an Anthropic HTTP
proxy and is not an official Google or OpenCode product.

## Requirements and setup

1. Use an OpenCode V2 host compatible with the plugin API used here
   (`@opencode/plugin` 2.0.22). The package requires Bun >= 1.4.4 and exports
   TypeScript source; the OpenCode host must provide Bun.
2. Obtain Google's **ACP Registry 1.5.2 Linux x64** standalone artifact from
   the [`antigravity-acp` entry in the official Registry manifest](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
   and extract it. The manifest is a moving latest listing; check the version
   before downloading. This project does not install the
   artifact. Keep `agy_acp_server.par` and `localharness_external` together.
   The launcher must be executable. The adapter admits only Linux x64 and
   checks the SHA-256 of **both** extracted files before launching:

   | File | SHA-256 |
   | --- | --- |
   | `agy_acp_server.par` | `f472860b79c4816a32817e589afdb01cec0ca731e5fa428eae873b14be12387f` |
   | `localharness_external` | `072fc497e7814b0e25a7d80109bceddacd815eb351d2e48ce579a05510e0cfdf` |

   For example, run `sha256sum agy_acp_server.par localharness_external` in
   the extracted directory. These pins are an admission check, not an
   automatic download or update mechanism. See
   [the migration notes](docs/agy-cli-migration.md) for the artifact review.
3. Sign in separately with the official `agy` CLI using a personal account.
   The CLI is used for its existing personal authentication, **not** as the
   ACP runtime. The plugin does not initiate interactive login. It reads the
   CLI token file at `$GEMINI_HOME/antigravity-cli/antigravity-oauth-token`
   (default `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`) and stages
   a translated credential in an account-scoped private profile. Protect that
   profile and never share credentials or its contents. The plugin does not
   modify the CLI token or reuse an existing standalone credential.
4. Set `OPENCODE_ANTIGRAVITY_ACP_PATH` to the full path of the extracted
   `agy_acp_server.par` in the environment of the OpenCode **server**; or put
   the pair together in a directory on its `PATH`. An explicit path is the
   launcher, not its directory or the `agy` CLI. A long-running shared service
   must actually inherit the chosen environment.
5. Install dependencies in this checkout using Bun:

   ```sh
   bun install --frozen-lockfile
   ```

   Add the **absolute path to this checkout directory** to your global
   `~/.config/opencode/opencode.jsonc` or a project's `opencode.jsonc`,
   preserving any existing configuration. Replace the example path:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/absolute/path/to/opencode-antigrvity"]
   }
   ```

   See the OpenCode
   [plugin guide](https://opencode.ai/docs/build/plugins) and
   [configuration guide](https://opencode.ai/docs/config). The npm latest
   release 0.6.5 predates this runtime; publication of 0.6.6 has not been
   verified. Use the current checkout for the behavior documented here. The
   plugin registers the provider and a
   non-secret local connection marker automatically; no Google API key needs
   to be configured in OpenCode.

Use `/models` in OpenCode to select an available **Antigravity** model after
discovery. Model
IDs and availability come from the authenticated ACP session, not a fixed
list in this repository; before successful discovery the fallback catalog is
empty. Some explicitly advertised effort siblings are grouped into variants
(`low`, `medium`, `high`). Availability can change by account or runtime.
Unknown model limits are estimates, not guarantees.

## Tools, prompts, and safety

OpenCode tools are presented to ACP through an `external_tool` MCP bridge;
OpenCode continues to own tool execution and permissions. The reviewed
standalone runtime is configured with an empty native-tool allowlist. Do not
substitute the CLI-embedded `agy acp` or an unreviewed binary: an isolation
test of CLI 1.5.18 found native tool access despite the requested disabling
flag. This is a specific reviewed runtime boundary, not a general sandbox or a
guarantee against all server behavior. Native ACP permission requests default
to deny; `OPENCODE_ANTIGRAVITY_ACP_PERMISSION=allow` changes that policy and
should only be used with an understanding of the risk. See
[migration notes](docs/agy-cli-migration.md).

OpenCode agent instructions and instruction sources are forwarded to ACP;
the harness supplies its own internal system context. See the
[prompt contract](docs/prompt-contract.md) for history, subagents and
compaction. The adapter ignores temperature overrides; ACP owns sampling.
Text and image input and text output are advertised, subject to the actual
runtime and model. Usage may fall back to an approximate context occupancy
when ACP does not report usage; it is not billing accounting. See
[development notes](docs/development.md#usage-fallback) for limitations,
including tool-bridge changes and session reconstruction.

The adapter stores session state and private profiles under
`OPENCODE_ANTIGRAVITY_DATA_DIR`, or by default under
`${XDG_DATA_HOME:-~/.local/share}/opencode-antigravity`. Durable OS locks live
separately in the OS account home. Stop all old adapter processes before an
upgrade across the lock-protocol boundary; do not delete lock files while
processes are running. See [lock recovery](docs/lock-recovery.md).

## Troubleshooting

- **Executable not found or rejected:** check the server environment, execute
  permission, platform, exact filename, companion location and both hashes.
  An explicit `OPENCODE_ANTIGRAVITY_ACP_PATH` disables `PATH` fallback, even
  if the override is invalid. Symlinks are resolved before admission: the real
  launcher's basename must be `agy_acp_server.par`, with the matching
  `localharness_external` next to that real file.
  The CLI-embedded ACP, other versions and other platforms are not admitted.
- **Authentication required:** sign in through `agy` separately with personal
  authentication and ensure the server sees the same `HOME`/`GEMINI_HOME`.
  Do not paste or print token contents into logs or issue reports.
- **No models / unknown model:** check authentication and runtime discovery;
  the empty fallback does not invent models. Select an ID actually advertised
  by the session. Account access, quota and service availability remain
  external dependencies.
- **Lock or session recovery issues:** consult [lock recovery](docs/lock-recovery.md)
  before manual cleanup. For host problems, see OpenCode's
  [troubleshooting guide](https://opencode.ai/docs/troubleshooting); redact
  credentials, prompts and private data before sharing diagnostics.

## Development and tests

```sh
bun install --frozen-lockfile
mkdir -p /tmp/opencode
bun run check                 # build and test suite
bun test test/protocol.test.ts # one test file
```

`bun run build` type-checks source and emits `dist/`; the default suite uses
fixtures and skips live tests when not enabled. `bun run test:live` opts into
real inference and may consume quota; it requires the admitted runtime and
existing authentication. See [development](docs/development.md) for details;
historical baseline counts and platform reviews in the docs are not a promise
of current support. Never commit credentials or local environment files.

## License

[MIT](LICENSE).

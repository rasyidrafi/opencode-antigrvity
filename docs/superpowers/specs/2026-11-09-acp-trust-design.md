# ACP trust and update design

Date: 2026-11-09
Status: proposed
Scope: `~/code/opencode-antigravity` fork, trust/update path only

## Intent

Stop re-pinning SHA-256 hashes of Google's Antigravity ACP server on every release. Resolve the current version from Google's official registry entry, download from Google's CDN, and verify the publisher's code signature instead of the exact bytes. Keep the safety property the hash gate protected: this plugin supplies the tools, so the server's built-in tools must stay disabled.

Picked approach: signature-verified latest (approach A). Alternatives considered: scheduled hash automation (B), trust-on-first-use plus behavior probe (C). B only automates the chore; C has no publisher identity. A gives per-release verification at macOS/Windows native-tooling quality. Linux has no OS-level signature format, so it stays on B's pinned hashes, clearly labelled.

## Current state (facts this design builds on)

- `src/acp-install.ts` pins `ACP_VERSION` and constructs `dl.google.com/agy-extensions/releases/...` URLs; install is lazy and versioned under `~/.local/share/opencode-antigravity/acp-server-<version>/`.
- `src/acp-compatibility.ts` admits only exact hash pairs per platform; anything else fails closed with `agy_acp_compatibility`.
- macOS 1.4.5 binaries (`agy_acp_server.par`, `localharness_external`) are signed `Developer ID Application: Google LLC (EQHXZ8M8AV)`; `codesign --verify --strict` passes and the designated requirement pins `certificate leaf[subject.OU] = EQHXZ8M8AV`.
- Sessions send `_meta: { agy: { enabledTools: [] } }` (`src/acp-process.ts:328`), which the reviewed builds honour by disabling built-ins and subagents.
- The official registry entry `agentclientprotocol/registry/antigravity-acp/agent.json` lists Google LLC as author and carries per-platform archive URLs.

## Design

### 1. Version resolution (`src/acp-trust.ts`)

- `resolveAcpVersion()` fetches the registry `agent.json`, returns `version`, and caches `{version, fetchedAt, archives}` at `<dataDir>/registry.json` with a 6 h TTL.
- Offline or failed fetch: use the cached entry, or the last verified installed version. Never block plugin startup on the network.
- Overrides: `OPENCODE_ANTIGRAVITY_ACP_VERSION` pins an exact version; `OPENCODE_ANTIGRAVITY_ACP_REGISTRY` points at a mirror for testing.
- The download URL comes from the registry entry, but the trust code requires `https:` and host `dl.google.com`. Anything else is rejected before download.

### 2. Trust verification (`src/acp-trust.ts`)

One function per platform, all verifying both files in the archive:

- **darwin**: `codesign --verify --strict` then `codesign -d --requirements -`, asserting the designated requirement contains the Google team OU `EQHXZ8M8AV`. Absence of `codesign` fails closed.
- **win32**: PowerShell `Get-AuthenticodeSignature` on both files; require `Status -eq Valid` and signer subject containing `O=Google LLC`. Exact subject match is verified on a Windows host during implementation and pinned in a test.
- **linux**: no platform signature. Keep the existing content-hash `profiles` map; a version with no Linux hash pair is not admitted. The updater script maintains those pairs (approach B), and the UI/report labels Linux "hash-verified" rather than "publisher-verified".
- Any state other than pass fails closed with a distinguishable error code (`agy_acp_signature`, `agy_acp_hash`, `agy_acp_untrusted_version`).

### 3. Smoke gate before first use of a version

After download and verification, run a minimal ACP probe once per version: `initialize`, `session/new` with `_meta.agy.enabledTools: []`, assert protocol version 1, the four expected auth methods, and at least one model. Record `{version, verifiedAt, platform}` in `<dataDir>/verified.json`.

- Failure: do not run the new version. Fall back to the previous verified version if one is installed, surface a warning with the probe error, and retry on the next update window.
- Success: mark the version trusted for the platform.
- This catches protocol drift and broken releases. It does not introspect the server's internal tool filter, which the protocol does not expose; publisher signature plus the `enabledTools: []` request remain the isolation contract. Residual risk, stated in docs: a signed Google release could change filter semantics and still pass the smoke gate.

### 4. Installation and rollback

- Keep the existing versioned directories. Retain the current version plus the previous verified one; prune older ones.
- `verified.json` records the last good version per platform; startup uses it when resolution fails.

### 5. Manual controls

- `bun run acp:check` reports registry vs pinned vs verified (existing script, extended to print the trust mode).
- `OPENCODE_ANTIGRAVITY_ACP_VERSION` pins; `OPENCODE_ANTIGRAVITY_DISABLE_ACP_UPDATE=1` stays on the verified version.
- Docs: one page explaining the three platform trust modes and how to diagnose a refusal.

## Non-goals

- Verifying Google's backend behavior or quota handling.
- A general signature framework for other providers.
- Removing the Linux hash path; no signer exists to trust.

## Risks

- Windows signer subject needs on-device verification; a wrong assumption would fail closed (acceptable) rather than admit unsigned binaries.
- Registry compromise: mitigated by host restriction to `dl.google.com` plus signature/hash verification of the archive contents. The registry can only choose among Google-signed releases, or cause a denial.
- `codesign` output parsing can vary by OS version; parse the designated requirement text, not localized diagnostics.
- A smoke-passing release could regress tool isolation internally; documented as accepted residual risk under publisher trust.

## Test plan

- Unit: fake command runners for darwin/win32, unsigned/wrong-team/wrong-host archives rejected, cache/TTL/override behaviour, rollback selection.
- Integration (darwin, this machine): real 1.4.5 download, signature pass, smoke pass; tampered byte fails signature.
- CI matrix (when upstreamed): win32 Authenticode against the real archive, linux hash path, unsigned fixture rejected.
- Existing suite stays green; `profiles` tests move under the Linux-only path.

## Open questions

1. Update window: is a 6 h registry cache acceptable, or should it refresh once per process start only?
2. On smoke failure, fall back silently with a warning toast, or require the user to choose? Proposal: run the last verified version and surface one warning with a link to retry.
3. Keep hash pins as an optional second check on signed platforms when the version is known? Proposal: no; signature is the gate, hashes stay Linux-only.

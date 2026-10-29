# Development

## Prerequisites

- Bun >=1.4.4. The repository pins Bun 1.4.4 in `package.json` and CI; update
  both pins together.

Use Bun for installs, scripts, builds, tests, and CI. `bun.lock` is the sole
lockfile; do not create or update locks with another package manager. CI uses
`bun ci` (equivalent to `bun install --frozen-lockfile`): it verifies the lock
is current and installs its exact versions. For local development, the frozen
install is equally reproducible.

```sh
bun install --frozen-lockfile
mkdir -p /tmp/opencode
bun run check
```

## Daily workflow

Edit TypeScript in `src/` and add regression tests in `test/`.

```sh
bun run build                     # Type-check and emit dist/ declarations and JS
bun test test                     # Run tests without rebuilding
bun test test/protocol.test.ts     # Run one test file
bun test --watch test              # Re-run tests as files change
bun run --bun tsc -p tsconfig.json --watch # Run TypeScript under Bun while watching
bun run check                     # Build and full tests before submitting changes
```

This repository is a plugin/library, not a standalone development server.
The package entrypoint is `src/index.ts`; generated output lives in the ignored
`dist/` directory. The build type-checks `src/`, not the test files.
The OpenCode host must provide Bun at runtime. Imports from `node:` in source
and tests use Bun's Node.js API compatibility layer; they do not launch or
require the Node executable. TypeScript and the fake ACP test executable are
explicitly run with Bun. `@types/node` remains only to type-check those
compatible APIs; it does not add a Node runtime requirement.

Bun skips dependency lifecycle scripts unless a package is explicitly trusted.
Do not trust dependencies broadly: Koffi's optional platform package supplies
its prebuilt native binary, so its Node-based install script is intentionally
left untrusted. A clean Bun install and Koffi import were verified on Linux.

## Optional live tests

The default suite uses fixtures and skips opt-in live and platform-specific
checks when their prerequisites are unavailable. Normal development does not
require Google credentials or a running Antigravity server.

`bun run test:live` enables real inference checks. Only run it after configuring
the official Antigravity ACP executable and authentication; it may consume
account quota. See `test/acp-live.test.ts` and `src/acp-detect.ts` for the checks
and executable discovery behavior. Do not commit credentials or local `.env`
files.

## Verified baseline

Setup was verified with Bun 1.4.4: the build succeeded, with 205 tests passing,
10 skipped, and no failures.

A prior lockfile audit reported 4 dependency vulnerabilities (1 moderate,
3 high). Dependency upgrades were deliberately left out of this migration;
some remediation changes the pinned OpenCode plugin version and needs separate
compatibility testing.

## Bun references

- [CI installs and frozen lockfiles](https://bun.com/docs/pm/cli/install#ci-cd)
- [Bun script execution and `--bun`](https://bun.com/docs/runtime#bun)
- [Dependency lifecycle scripts and `trustedDependencies`](https://bun.com/docs/pm/lifecycle#trusteddependencies)
- [Portable environment-variable prefixes](https://bun.com/docs/runtime/environment-variables#setting-environment-variables)

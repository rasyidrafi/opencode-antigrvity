# 0.5.0 release validation — 2026-10-06

Release preparation only: no commit, publish, global installation, shared-service
restart or sibling staging. Independent review and publication remain pending.

- Registry queried before version selection: latest `0.4.1`; published versions
  `0.2.0`, `0.2.1`, `0.2.2`, `0.3.0`, `0.4.0`, `0.4.1`. Selected unpublished
  next minor `0.5.0`. Manifest and both npm lockfile root versions agree;
  `bun.lock` contains no root version and needs no release-only edit.
- `npm whoami` failed with E401. Renew npm authentication before publishing;
  request an OTP if the account's publication policy requires 2FA.
- Fresh `npm run check`: build succeeded; 137 passed, 3 skipped, 0 failed;
  140 tests across 28 files, 952 assertions. Log:
  `/tmp/opencode/release-0.5.0/check.log`.
- Fresh authenticated `npm run test:live`: 3 passed, 0 failed, 7 assertions.
  Log: `/tmp/opencode/release-0.5.0-live.log`. These ACP checks do not establish
  every live-host or crash boundary; see the linked historical evidence.
- Exact release tarball, pack manifest, export/private-artifact inspection and
  SHA-256 record are retained outside the package in
  `/tmp/opencode/release-0.5.0/`. The checksum is external to avoid a
  self-referential packaged checksum.

Contract limitations remain in [release notes](release-0.5.0.md),
[live host evidence](live-host-validation.md) and
[tool crash evidence](tool-crash-validation.md). Older phase counts are historical,
not the current release result. The sibling client is not shipped here.

# 0.5.0 release notes

Prepared 2026-10-06; publication is pending independent review and npm authentication.

- Durable lifecycle epochs, checkpoint reconciliation, bounded utility inference,
  conservative retention, and validated tool-record migration/quarantine.
- Persisted tool results and fail-closed recovery, with local subprocess SIGKILL
  coverage; uncertain execution never authorizes automatic tool replay.
- Session-scoped context occupancy telemetry and the public `./rpc` export.
  Occupancy is separate from billing; unknown and stale states are explicit.
- Adapter telemetry-driven automatic compaction activation remains disabled:
  effective host policy is unavailable through the reviewed public plugin API.
  Native host automatic compaction is unaffected; manual checkpoints remain supported.
- Model fallback is telemetry only, not a guarded host-selection update. Native
  system-role transport, audio transport and immediate host loop-stop are not claimed.
- Local result handoff is not remote acknowledgement. Fixture process-kill tests
  do not establish power-loss safety or an authenticated live-host crash matrix.

The sibling OpenChamber telemetry consumer is separate work, not included in this
package or its test counts. Historical phase documents retain their original
counts and limitations; current release checks are in `release-validation-0.5.0.md`.

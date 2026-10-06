# Durable tool migration and SIGKILL evidence — 2026-10-06

This local, unreleased slice closes the tool-record schema/local-delivery and
integrated process-kill gates previously left open in `phase8-validation.md`.
It does not claim remote acknowledgement, power-loss simulation, exhaustive
process-death stress, or an authenticated live-host crash matrix.

## Durable contract

- V2 tool records validate their version, conversation/call identity, originating
  host against a surviving binding, arguments/result digests, canonical typed
  tool/model profile and profile digest, epoch, timestamps, typed MCP results,
  terminal acceptance, and delivery state on
  reads. The call must belong to its originating profile's catalog. Retention and
  deletion scans route attributable records through the same validator. Unknown
  ownership/profile is explicit `null` only for unattributed internal records;
  host-owned calls require their verifiable originating profile.
- V1 migration requires the original identity, argument digest and verifiable
  profile. `accepted` becomes only `result-persisted`; ambiguous legacy records
  fail closed. Migration writes and normal reads/writes share a record lock.
- Invalid/unsupported records preserve their original bytes in deduplicated
  private quarantine and leave a durable corrupt tombstone at the original
  identity. Repeated reads/restarts fail nonretryably, not as absent calls.
- Results persist before live waiter release. `delivery-attempted` persists
  before each release. `locally-handed-off` means a JSON Response was constructed
  locally or the SSE result was enqueued locally, with a durable transition. It
  does **not** prove socket delivery, ACP receipt or model processing. A cancelled
  SSE response cannot acquire that state. Delivery state never authorizes replay.
- MCP waiter/delivery correlation survives module reload in the existing
  process-global bridge runtime. No public test hook or compatibility bypass was
  added to shipped runtime code.

## Actual integrated kill matrix

`test/tool-crash.test.ts` launches separate Bun test processes, waits for IPC
barriers, sends actual `SIGKILL`, verifies the terminating signal, then starts
a fresh recovery process. Each case has private HOME/XDG/GEMINI/adapter storage,
real loopback HTTP proxy, HostBridge, session pool, durable store and subprocess
fixture ACP/MCP transport. Test-only method interception inserts the barriers;
it does not replace the runtime with a storage imitation. Fixture executable
compatibility is replaced only by the existing test dependency spy.

The external host executor appends and fsyncs an independent effect counter
before submitting its result. It remains exactly one wherever execution occurred
and zero when killed before execution. No recovery emits executable tool calls.
Persisted results survive and are imported into the actual recovery ACP prompt;
unknown execution rejects rather than retrying. These are local fixture transport
tests, not tests of an authenticated Google service.
The handoff kill barrier waits for the fixture peer to parse the actual HTTP
result, not merely for Response construction. This test observation is not
available to production JSON-RPC and does not become a remote-acknowledgement
state in the durable record.

| Kill barrier | Recovery |
| --- | --- |
| before call persistence | original request receipt blocks replay |
| after call persistence | original request receipt blocks replay |
| before host exposure | original request receipt blocks replay |
| after host exposure | original call execution unknown; nonretryable |
| before result persistence | effect happened once; result unknown; nonretryable |
| after result persistence | stored result recovered without execution |
| before waiter release/delivery intent | stored result recovered without execution |
| after durable delivery intent, before waiter release | stored result recovered without execution |
| after MCP peer parsed the actual HTTP result | stored result recovered without execution |
| after compaction commit, unknown result, before new binding | epoch 1 survives; unknown call blocks execution |
| after compaction commit, known result, before new binding | epoch 1 survives; rebuilt binding uses host epoch 1 and stored result |

The before-result-persistence case additionally corrupts the originating record
and performs **two more real process restarts**. Both reject the unsupported
record with `agy_tool_record_corrupt`, retain its original bytes in quarantine,
retain the tombstone, and preserve the once-only external counter.

`test/tool-record.test.ts` separately covers unsupported/missing versions, wrong
conversation/call/host identity, malformed profile, bad profile/arguments/result
digests, unsupported delivery states, invalid epochs, result tampering,
conservative V1 migration and repeated fail-closed reads.

## Evidence

- `npm run check`: TypeScript build and 134 passed, 3 skipped, 0 failed;
  137 tests / 926 assertions. `/tmp/opencode/tool-slice-check.log`.
- Actual per-boundary process signals, private directories, recovery responses,
  epoch/binding records and external effect counts:
  `/tmp/opencode/tool-crash-evidence.json`. Private raw prompt and PID logs stay
  inside those uniquely named disposable case directories.
- No commit, publication, global installation or shared service restart.

Remaining gates outside this slice still apply: effective host auto-compaction
configuration and guarded model-selection reflection require public capabilities
not established by the installed plugin API; other live-host scenarios are not
implied by this deterministic local kill matrix.

import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { AgyError, retryAfterSeconds } from "../src/errors.js";
import { usageFromAcp, mapAcpEvent, collectTurn } from "../src/translate.js";
import { errorType } from "../src/proxy.js";
import { observeContext, readContextSnapshot } from "../src/telemetry.js";
import { sessionStore } from "../src/session-store.js";
import { classifyProviderFailure } from "@opencode/ai/provider-error";

test("retry durations and timestamps preserve provider hints", () => {
  expect(retryAfterSeconds(new AgyError("quota", "retry in 120000ms"))).toBe(120);
  expect(retryAfterSeconds(new AgyError("quota", "retry in 2 minutes"))).toBe(120);
  expect(retryAfterSeconds(new AgyError("quota", "quota", { details: { retryAfter: 12 } }))).toBe(12);
  expect(retryAfterSeconds(new AgyError("rate_limit", "limited", { details: { retryAfterMs: 120_000 } }))).toBe(120);
  expect(retryAfterSeconds(new AgyError("quota", "quota", { details: { retryAfter: new Date(Date.now() + 120_000).toISOString() } }))).toBe(120);
  expect(retryAfterSeconds(new AgyError("quota", "reset at " + new Date(Date.now() + 120_000).toISOString()))).toBe(120);
});
test("official ACP cached accounting is not occupancy", () => {
  expect(usageFromAcp({ used: 30_000, size: 100_000 })).toBeUndefined();
  expect(usageFromAcp({ inputTokens: 10, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 4 })).toEqual({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
  expect(usageFromAcp({ totalTokens: 100 })).toBeUndefined();
  expect(usageFromAcp({ inputTokens: 0, outputTokens: 0 })).toEqual({ input_tokens: 0, output_tokens: 0 });
  expect(usageFromAcp({ inputTokens: 3, cachedReadTokens: 4 })).toBeUndefined();
});
test("repeated terminal accounting is one aggregate, not another billable step", async () => {
  const result = { event: "result", sessionId: "s", result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 3, cachedWriteTokens: 4 } } } as const;
  const collected = await collectTurn((async function* () { yield result; yield result; })());
  expect(collected.usage).toEqual({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
  await expect(collectTurn((async function* () { yield result; yield { ...result, result: { ...result.result, usage: { inputTokens: 20, outputTokens: 2 } } }; })())).rejects.toThrow("Conflicting terminal");
});
test("actual V2 classifier sees overflow and terminal invalid request", () => {
  for (const [kind, status, tag] of [["context_overflow", 400, "InvalidRequest"], ["invalid_request", 400, "InvalidRequest"], ["rate_limit", 429, "RateLimit"], ["quota", 429, "QuotaExceeded"], ["refusal", 400, "ContentPolicy"], ["overload", 503, "ProviderInternal"]] as const) {
    const error = new AgyError(kind, "provider failure");
    const rawBody = JSON.stringify({ type: "error", error: { type: errorType(error), message: error.message } });
    expect(classifyProviderFailure({ message: `${errorType(error)}: ${error.message}`, rawBody, status })._tag).toBe(tag);
    expect(classifyProviderFailure({ message: `${errorType(error)}: ${error.message}`, rawBody })._tag).toBe(tag);
  }
});
test("refusal remains a refusal", () => {
  const mapped = mapAcpEvent({ event: "result", sessionId: "remote", result: { stopReason: "refusal" } });
  expect(mapped.kind === "result" && mapped.finishReason).toBe("refusal");
});
test("occupancy replaces samples and rejects old epochs", async () => {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp("/tmp/opencode/telemetry-test-");
  try {
    for (const used of [30_000, 31_000, 8_000]) await observeContext("host", 0, "remote", "model", { used, size: 100_000 });
    expect((await readContextSnapshot("host")).used).toBe(8_000);
    expect((await readContextSnapshot("host")).sequence).toBe(3);
    await observeContext("host", 0, "remote", "requested", { used: 120_000, size: 100_000 }, "boundary", "actual-fallback");
    expect(await readContextSnapshot("host")).toMatchObject({ used: 120_000, requestedModel: "requested", model: "actual-fallback" });
    await observeContext("host", 0, "remote", "requested", { used: -1, size: 100_000 });
    expect((await readContextSnapshot("host")).used).toBe(120_000);
    await sessionStore.compaction("host", "commit", "committed");
    await observeContext("host", 0, "remote", "model", { used: 99_000, size: 100_000 });
    expect((await readContextSnapshot("host")).state).toBe("unknown");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
  }
});

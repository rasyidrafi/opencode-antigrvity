import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { admitAutoCompaction, failAutoCompaction } from "../src/auto-compaction.js";
import { sessionStore } from "../src/session-store.js";
import type { ContextSnapshot } from "../src/telemetry.js";

test("auto admission respects effective settings, persists stable IDs, coalesces, and suppresses failed baselines", async () => {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp("/tmp/opencode/auto-compaction-");
  try {
    const snapshot: ContextSnapshot = { version: 1, hostSessionID: "host", epoch: 0, sequence: 1, baseline: "turn-one", state: "measured", used: 90, size: 100, observedAt: Date.now() };
    const calls: Array<{ sessionID: string; id: string }> = [];
    const compact = async (input: { sessionID: string; id: string }) => { calls.push(input); };
    expect(await admitAutoCompaction(snapshot, undefined, compact)).toBe("disabled");
    expect(await admitAutoCompaction(snapshot, { auto: false }, compact)).toBe("disabled");
    expect(await admitAutoCompaction({ ...snapshot, used: 89 }, {}, compact)).toBe("below-threshold");
    expect(await admitAutoCompaction({ ...snapshot, used: 79 }, { modelCapacity: 80, buffer: 0 }, compact)).toBe("below-threshold");
    expect(await admitAutoCompaction({ ...snapshot, used: 75 }, { modelCapacity: 80, buffer: 5 }, compact)).toBe("admitted");
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toMatch(/^msg_[a-f0-9]{32}$/);
    expect((await sessionStore.autoAdmission("host"))?.phase).toBe("admitted");
    expect(await admitAutoCompaction({ ...snapshot, sequence: 2 }, {}, compact)).toBe("coalesced");
    await failAutoCompaction("host");
    expect(await admitAutoCompaction({ ...snapshot, used: 99, sequence: 3 }, {}, compact)).toBe("suppressed");
    expect(await admitAutoCompaction({ ...snapshot, baseline: "turn-two" }, {}, compact)).toBe("admitted");
    expect(calls[1].id).not.toBe(calls[0].id);
    await sessionStore.compaction("host", "commit", "committed");
    expect(await admitAutoCompaction(snapshot, {}, compact)).toBe("suppressed");
    expect(await admitAutoCompaction({ ...snapshot, epoch: 1, state: "unknown" }, {}, compact)).toBe("below-threshold");
    expect(await admitAutoCompaction({ ...snapshot, epoch: 1, observedAt: Date.now() - 300_001 }, {}, compact)).toBe("below-threshold");
    await sessionStore.compaction("manual", "manual-request", "generating");
    expect(await admitAutoCompaction({ ...snapshot, hostSessionID: "manual" }, {}, compact)).toBe("coalesced");
    await expect(admitAutoCompaction({ ...snapshot, hostSessionID: "fixed" }, { fixedTokens: 90 }, compact)).rejects.toThrow("exhaust");
    await expect(admitAutoCompaction(snapshot, { buffer: 100 }, compact)).rejects.toThrow("exhaust");
    expect(calls).toHaveLength(2);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
  }
});

test("lost admission acknowledgment is not a telemetry loop; recovery reuses the durable ID", async () => {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp("/tmp/opencode/auto-recovery-");
  try {
    const snapshot: ContextSnapshot = { version: 1, hostSessionID: "host", epoch: 0, sequence: 1, baseline: "baseline", state: "measured", used: 99, size: 100, observedAt: Date.now() };
    const ids: string[] = [];
    await expect(admitAutoCompaction(snapshot, {}, async input => { ids.push(input.id); throw new Error("lost ack"); })).rejects.toThrow("lost ack");
    expect(await admitAutoCompaction(snapshot, {}, async () => { throw new Error("must not repeat"); })).toBe("coalesced");
    expect(await admitAutoCompaction(snapshot, {}, async input => { ids.push(input.id); }, true)).toBe("admitted");
    expect(ids[0]).toBe(ids[1]);
    // Admission does not wait for a compaction completion event, nor advance epoch.
    expect((await sessionStore.lifecycle("host")).epoch).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
  }
});

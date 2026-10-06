import { createHash } from "node:crypto";
import { AgyError } from "./errors.js";
import { sessionStore } from "./session-store.js";
import type { ContextSnapshot } from "./telemetry.js";

/** Must come from the host's effective configuration, never plugin options. */
export type CompactionSettings = { auto?: boolean; buffer?: number; modelCapacity?: number; fixedTokens?: number };
export type AutoAdmission = {
  version: 1; epoch: number; baseline: string; id: string;
  phase: "pending" | "admitted" | "failed";
};

/** Admission, not completion. The host queues compact at a safe step boundary.
 * This lock is deliberately NOT the conversation turn lock: the active pump
 * must keep running while the host admits the request. */
export async function admitAutoCompaction(snapshot: ContextSnapshot, settings: CompactionSettings | undefined,
  compact: (input: { sessionID: string; id: string }) => Promise<unknown>, resumePending = false): Promise<"disabled" | "below-threshold" | "coalesced" | "suppressed" | "admitted"> {
  if (!settings || settings.auto === false) return "disabled";
  if (snapshot.state !== "measured" || !snapshot.observedAt || Date.now() - snapshot.observedAt >= 300_000 || !snapshot.baseline || snapshot.used === undefined || !snapshot.size) return "below-threshold";
  const capacity = Number.isFinite(settings.modelCapacity) && settings.modelCapacity! > 0 ? Math.min(snapshot.size, settings.modelCapacity!) : snapshot.size;
  const buffer = settings.buffer === undefined ? Math.ceil(capacity * 0.1) : settings.buffer;
  if (!Number.isSafeInteger(buffer) || buffer < 0) throw new AgyError("invalid_request", "Invalid effective compaction buffer");
  if (buffer >= capacity || (settings.fixedTokens !== undefined && settings.fixedTokens >= capacity - buffer)) throw new AgyError("invalid_request", "Fixed instructions/tools or the compaction buffer exhaust the context budget", { code: "agy_context_budget" });
  if (snapshot.used < capacity - buffer) return "below-threshold";
  const unlock = await sessionStore.lockTurn(`auto-admission:${snapshot.hostSessionID}`, 5_000);
  try {
    const lifecycle = await sessionStore.lifecycle(snapshot.hostSessionID);
    if (lifecycle.epoch !== snapshot.epoch) return "suppressed";
    if (lifecycle.transaction?.phase === "generating") return "coalesced";
    let admission = await sessionStore.autoAdmission(snapshot.hostSessionID);
    if (admission?.epoch === snapshot.epoch) {
      if (admission.phase === "admitted") return "coalesced";
      if (admission.phase === "pending" && !resumePending) return "coalesced";
      if (admission.phase === "failed" && admission.baseline === snapshot.baseline) return "suppressed";
      // A pending write may precede a crash after host admission. Reuse that ID,
      // even if a newer sample arrived. Host-side durable dedup handles the race.
    } else admission = undefined;
    if (!admission || admission.phase === "failed") {
      const id = `msg_${createHash("sha256").update(`${snapshot.hostSessionID}:${snapshot.epoch}:${snapshot.baseline}`).digest("hex").slice(0, 32)}`;
      admission = { version: 1, epoch: snapshot.epoch, baseline: snapshot.baseline, id, phase: "pending" };
      await sessionStore.saveAutoAdmission(snapshot.hostSessionID, admission);
    }
    await compact({ sessionID: snapshot.hostSessionID, id: admission.id });
    // A response acknowledges admission only. Events commit/fail the epoch.
    await sessionStore.saveAutoAdmission(snapshot.hostSessionID, { ...admission, phase: "admitted" });
    return "admitted";
  } finally { await unlock(); }
}

export async function failAutoCompaction(hostSessionID: string, expectedID?: string): Promise<void> {
  const unlock = await sessionStore.lockTurn(`auto-admission:${hostSessionID}`, 5_000);
  try {
    const admission = await sessionStore.autoAdmission(hostSessionID);
    if (expectedID !== undefined && admission?.id !== expectedID) return;
    if (admission && admission.epoch === (await sessionStore.lifecycle(hostSessionID)).epoch) await sessionStore.saveAutoAdmission(hostSessionID, { ...admission, phase: "failed" });
  } finally { await unlock(); }
}

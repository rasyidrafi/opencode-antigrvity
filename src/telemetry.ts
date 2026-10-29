import { sessionStore } from "./session-store.js";
import type { ContextOccupancy } from "./protocol.js";

export type ContextSnapshot = {
  version: 1; hostSessionID: string; epoch: number; sourceSessionID?: string;
  sequence: number; observedAt?: number; model?: string;
  used?: number; size?: number; state: "measured" | "unknown" | "stale";
  baseline?: string;
  requestedModel?: string;
  executionGeneration?: string;
};
export type ExecutionBinding = { generation: string; sourceSessionID: string };
export type ContextOccupancyCandidate = { used: number; observedAt: number };

/**
 * Return only a fresh sample from the exact bound ACP execution. Context
 * occupancy is an approximation, not per-request token or billing usage.
 */
export function contextOccupancyForExecution(
  snapshot: ContextSnapshot | undefined,
  binding: ExecutionBinding | undefined,
  hostSessionID: string,
  sourceSessionID: string,
  executionGeneration: string | undefined,
  now = Date.now(),
): ContextOccupancyCandidate | undefined {
  if (!snapshot || !binding || !executionGeneration || !sourceSessionID || !Number.isFinite(now)) return undefined;
  if (snapshot.hostSessionID !== hostSessionID || snapshot.state !== "measured") return undefined;
  if (snapshot.sourceSessionID !== sourceSessionID || snapshot.executionGeneration !== executionGeneration) return undefined;
  if (binding.sourceSessionID !== sourceSessionID || binding.generation !== executionGeneration) return undefined;
  const { used, size, observedAt } = snapshot;
  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0 ||
      typeof size !== "number" || !Number.isFinite(size) || size <= 0 ||
      typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0) return undefined;
  const age = now - observedAt;
  if (age < 0 || age >= 300_000) return undefined;
  return { used, observedAt };
}

/** Freeze a candidate for one new response, rechecking its age at emission. */
export function freezeContextOccupancy(candidate: ContextOccupancyCandidate | undefined, now = Date.now()): ContextOccupancy | undefined {
  if (!candidate || !Number.isSafeInteger(candidate.used) || candidate.used < 0 ||
      !Number.isFinite(candidate.observedAt) || candidate.observedAt <= 0 || !Number.isFinite(now)) return undefined;
  const age = now - candidate.observedAt;
  if (age < 0 || age >= 300_000) return undefined;
  return { used: candidate.used };
}

/** Best-effort seed for turns that receive no usage_update of their own. */
export async function readBoundContextOccupancy(
  hostSessionID: string,
  sourceSessionID: string,
  executionGeneration: string | undefined,
  read: (hostSessionID: string) => Promise<{ snapshot: ContextSnapshot | undefined; binding: ExecutionBinding | undefined }> = async (host) => ({
    snapshot: await sessionStore.contextSnapshot(host),
    binding: await sessionStore.executionBinding(host),
  }),
  now = Date.now(),
): Promise<ContextOccupancyCandidate | undefined> {
  try {
    const { snapshot, binding } = await read(hostSessionID);
    return contextOccupancyForExecution(snapshot, binding, hostSessionID, sourceSessionID, executionGeneration, now);
  } catch {
    // Context usage is optional; a telemetry read failure must not fail a turn.
    return undefined;
  }
}

const listeners = new Set<(snapshot: ContextSnapshot) => void>();
export function onContextSnapshot(listener: (snapshot: ContextSnapshot) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export async function publishContextSnapshot(hostSessionID: string): Promise<void> {
  const snapshot = await readContextSnapshot(hostSessionID);
  for (const listener of listeners) { try { listener(snapshot); } catch { /* Telemetry consumers cannot fail the conversation. */ } }
}
export async function markContextStale(hostSessionID: string): Promise<void> {
  const snapshot = await sessionStore.contextSnapshot(hostSessionID);
  if (!snapshot || snapshot.state === "unknown") return;
  await sessionStore.saveContextSnapshot(hostSessionID, { ...snapshot, state: "stale" });
  await publishContextSnapshot(hostSessionID);
}
export async function readContextSnapshot(hostSessionID: string): Promise<ContextSnapshot> {
  const snapshot = await sessionStore.contextSnapshot(hostSessionID);
  const binding = await sessionStore.executionBinding(hostSessionID);
  if (!snapshot || (binding && (snapshot.executionGeneration !== binding.generation || snapshot.sourceSessionID !== binding.sourceSessionID))) return { version: 1, hostSessionID, epoch: snapshot?.epoch ?? 0, sequence: snapshot?.sequence ?? 0, state: "unknown" };
  const { executionGeneration: _generation, ...wire } = snapshot;
  return { ...wire, state: snapshot.state === "unknown" ? "unknown" : snapshot.state === "stale" || !snapshot.observedAt || Date.now() - snapshot.observedAt >= 300_000 ? "stale" : "measured" };
}
/** Caller owns the conversation turn lock. Occupancy replaces, never adds. */
export async function observeContext(hostSessionID: string, epoch: number, sourceSessionID: string, requestedModel: string, value: unknown, baseline?: string, actualModel?: string, executionGeneration?: string, now = Date.now()): Promise<ContextOccupancyCandidate | undefined> {
  const sample = value as { used?: unknown; size?: unknown };
  if (!sample || typeof sample.used !== "number" || !Number.isFinite(sample.used) || sample.used < 0 || typeof sample.size !== "number" || !Number.isFinite(sample.size) || sample.size <= 0) return undefined;
  const binding = await sessionStore.executionBinding(hostSessionID);
  if (binding && (binding.generation !== executionGeneration || binding.sourceSessionID !== sourceSessionID)) return undefined;
  const previous = await sessionStore.contextSnapshot(hostSessionID);
  const snapshot: ContextSnapshot = { version: 1, hostSessionID, epoch, sourceSessionID, requestedModel, ...(actualModel ? { model: actualModel } : {}), baseline, sequence: (previous?.sequence ?? 0) + 1, observedAt: now, used: sample.used, size: sample.size, state: "measured" };
  if (executionGeneration) snapshot.executionGeneration = executionGeneration;
  await sessionStore.saveContextSnapshot(hostSessionID, snapshot);
  await publishContextSnapshot(hostSessionID);
  return contextOccupancyForExecution(snapshot, binding, hostSessionID, sourceSessionID, executionGeneration, now);
}

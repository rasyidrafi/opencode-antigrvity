import { sessionStore } from "./session-store.js";

export type ContextSnapshot = {
  version: 1; hostSessionID: string; epoch: number; sourceSessionID?: string;
  sequence: number; observedAt?: number; model?: string;
  used?: number; size?: number; state: "measured" | "unknown" | "stale";
  baseline?: string;
  requestedModel?: string;
  executionGeneration?: string;
};
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
export async function observeContext(hostSessionID: string, epoch: number, sourceSessionID: string, requestedModel: string, value: unknown, baseline?: string, actualModel?: string, executionGeneration?: string): Promise<void> {
  const sample = value as { used?: unknown; size?: unknown };
  if (!sample || typeof sample.used !== "number" || !Number.isFinite(sample.used) || sample.used < 0 || typeof sample.size !== "number" || !Number.isFinite(sample.size) || sample.size <= 0) return;
  const binding = await sessionStore.executionBinding(hostSessionID);
  if (binding && (binding.generation !== executionGeneration || binding.sourceSessionID !== sourceSessionID)) return;
  const previous = await sessionStore.contextSnapshot(hostSessionID);
  const snapshot: ContextSnapshot = { version: 1, hostSessionID, epoch, sourceSessionID, requestedModel, ...(actualModel ? { model: actualModel } : {}), baseline, sequence: (previous?.sequence ?? 0) + 1, observedAt: Date.now(), used: sample.used, size: sample.size, state: "measured" };
  if (executionGeneration) snapshot.executionGeneration = executionGeneration;
  await sessionStore.saveContextSnapshot(hostSessionID, snapshot);
  await publishContextSnapshot(hostSessionID);
}

import type { AcpModelCatalog } from "./models.js";

type Listener = (scope: string, catalog: AcpModelCatalog) => void;
const listeners = new Set<Listener>();

export function onAcpCatalog(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitAcpCatalog(scope: string | undefined, catalog: AcpModelCatalog): void {
  if (scope) for (const listener of listeners) listener(scope, catalog);
}

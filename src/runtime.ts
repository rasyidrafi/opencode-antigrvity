import { realpath } from "node:fs/promises";
import { relative, resolve as resolvePath, sep } from "node:path";
import { fallbackAcpModelCatalog, type AcpModelCatalog } from "./models.js";
import { ModelCatalog } from "./model-catalog.js";
import { sessionPool } from "./session-pool.js";
import { closeHostBridges, closeHostBridgesForScope, stopHostBridgeServer } from "./host-tools.js";
import { info } from "./log.js";

/**
 * Process-wide Antigravity runtime: model discovery plus the ACP session pool.
 *
 * The previous adapter also ran a loopback HTTP proxy here. The LanguageModelV3
 * route is in-process, so the runtime only owns the catalog, the workspace
 * boundary and the worker pool. State lives on globalThis so a compatible
 * module reload shares one runtime.
 */

type RuntimeState = {
  directory: string;
  manager: ModelCatalog;
  readonly catalog: AcpModelCatalog;
};

type RuntimeOwner = {
  runtime: RuntimeState | null;
  refs: Map<string, number>;
  /** Serializes retain/release so a replacement cannot start during teardown. */
  lifecycle: Promise<void>;
};

const owner = globalThis as typeof globalThis & { __agyRuntimeV1?: RuntimeOwner };
const state = owner.__agyRuntimeV1 ??= { runtime: null, refs: new Map(), lifecycle: Promise.resolve() };

function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = state.lifecycle.then(operation, operation);
  state.lifecycle = result.then(() => undefined, () => undefined);
  return result;
}

export function onModelCatalogChange(listener: () => void): () => void {
  const listeners = modelCatalogListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Kept separate from the runtime state so a reload keeps the same listeners.
const listenerOwner = globalThis as typeof globalThis & { __agyRuntimeListenersV1?: Set<() => void> };
function modelCatalogListeners(): Set<() => void> {
  return listenerOwner.__agyRuntimeListenersV1 ??= new Set();
}

export function getRuntime(): RuntimeState | null {
  return state.runtime;
}

export async function refreshModels(): Promise<AcpModelCatalog> {
  return state.runtime ? state.runtime.manager.refresh(true) : fallbackAcpModelCatalog();
}

async function pathContains(root: string, candidate: string): Promise<boolean> {
  const [realRoot, realCandidate] = await Promise.all([
    realpath(root).catch(() => resolvePath(root)),
    realpath(candidate).catch(() => resolvePath(candidate)),
  ]);
  const relativePath = relative(realRoot, realCandidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

/** The adapter may only touch directories inside a registered plugin workspace. */
export async function workspaceContains(directory: string): Promise<boolean> {
  const checks = await Promise.all([...state.refs.keys()].map((root) => pathContains(root, directory)));
  return checks.some(Boolean);
}

async function startRuntimeInternal(directory: string): Promise<void> {
  sessionPool.open();
  const manager = new ModelCatalog(directory, {
    onChange: () => {
      for (const listener of modelCatalogListeners()) listener();
    },
    onScopeChange: async (previous) => {
      await closeHostBridgesForScope(previous);
      await sessionPool.retireCatalogScope(previous);
      info("Retired incompatible ACP authentication scope", { reason: "scope_changed" });
    },
  });
  state.runtime = { directory, manager, get catalog() { return manager.catalog; } };
  await manager.start();
  info("Antigravity runtime ready", { directory, models: manager.catalog.models.length, ready: manager.catalog.source !== "empty" });
}

export async function startRuntime(directory = process.cwd()): Promise<void> {
  const root = resolvePath(directory);
  return serializeLifecycle(async () => {
    state.refs.set(root, (state.refs.get(root) ?? 0) + 1);
    if (state.runtime) return;
    await startRuntimeInternal(root);
  });
}

export async function stopRuntime(directory?: string): Promise<void> {
  return serializeLifecycle(async () => {
    if (directory) {
      const root = resolvePath(directory);
      const count = state.refs.get(root) ?? 0;
      if (count > 1) {
        state.refs.set(root, count - 1);
        return;
      }
      state.refs.delete(root);
    } else {
      state.refs.clear();
    }
    if (state.refs.size > 0) return;
    await closeHostBridges();
    await stopHostBridgeServer();
    const manager = state.runtime?.manager;
    state.runtime = null;
    await manager?.close();
    await sessionPool.close();
  });
}

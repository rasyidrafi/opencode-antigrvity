import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { fallbackAcpModelCatalog, type AcpModelCatalog } from "./models.js";
import { catalogContext, ModelCatalog } from "./model-catalog.js";
import { assertAgyCliCompatibility, resolveAgyCli } from "./agy-cli.js";
import { AgyError } from "./errors.js";
import { assertManagedRuntimeCacheTrust, installManagedRuntime, managedRuntimePath } from "./runtime-installer.js";
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
  executable: string;
  selectionVersion: 1;
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

async function startRuntimeInternal(directory: string, executable: string): Promise<void> {
  sessionPool.open();
  const manager = new ModelCatalog(directory, {
    context: () => catalogContext(executable),
    onChange: () => {
      for (const listener of modelCatalogListeners()) listener();
    },
    onScopeChange: async (previous) => {
      await closeHostBridgesForScope(previous);
      await sessionPool.retireCatalogScope(previous);
      info("Retired incompatible ACP authentication scope", { reason: "scope_changed" });
    },
  });
  state.runtime = { directory, executable, selectionVersion: 1, manager, get catalog() { return manager.catalog; } };
  await manager.start();
  info("Antigravity runtime ready", { directory, models: manager.catalog.models.length, ready: manager.catalog.source !== "empty" });
}

async function resolveExplicit(path: string): Promise<string> {
  return resolveAgyCli(assertAgyCliCompatibility, { ...process.env, OPENCODE_ANTIGRAVITY_ACP_PATH: path });
}

/** A managed pair must be regular files, not links into another installation. */
async function existingManaged(): Promise<string | undefined> {
  const path = managedRuntimePath();
  const dir = dirname(path);
  try {
    if (!(await lstat(dir)).isDirectory()) return;
    await assertManagedRuntimeCacheTrust();
    const uid = process.getuid?.();
    for (const path of [dirname(dir), dir]) {
      const st = await lstat(path);
      if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077)) return;
    }
    if ((await readdir(dir)).sort().join("\0") !== ["agy_acp_server.par", "localharness_external"].join("\0")) return;
    for (const name of ["agy_acp_server.par", "localharness_external"]) {
      const entry = await lstat(join(dir, name));
      if (!entry.isFile() || entry.uid !== uid || (entry.mode & 0o077) || !(entry.mode & 0o100)) return;
    }
    return await resolveExplicit(path);
  } catch { return; }
}

async function selectLocalOrInstall(): Promise<string> {
  const managed = await existingManaged();
  if (managed) return managed;
  try { return await resolveAgyCli(assertAgyCliCompatibility, { ...process.env, OPENCODE_ANTIGRAVITY_ACP_PATH: undefined }); }
  catch { /* No admitted PATH candidate; try the pinned artifact. */ }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new AgyError("unsupported", "No admitted ACP runtime was found; automatic installation supports Linux x64 only.", { code: "agy_runtime_platform_unsupported" });
  }
  info("Downloading the pinned Antigravity ACP runtime; first setup may take several minutes (aborts after 120s without progress, 30 minutes overall)");
  try {
    await installManagedRuntime();
    const installed = await existingManaged();
    if (!installed) throw new Error("Installed runtime failed admission");
    return installed;
  } catch (cause) {
    throw new AgyError("process", "Could not install the pinned Antigravity ACP runtime. Check network access and disk space, or configure an admitted local runtime.", { code: "agy_runtime_install_failed", cause });
  }
}

export async function startRuntime(directory = process.cwd(), acpPath?: unknown): Promise<void> {
  const root = resolvePath(directory);
  return serializeLifecycle(async () => {
    if (state.runtime && (state.runtime.selectionVersion !== 1 || typeof state.runtime.executable !== "string" || !state.runtime.executable)) {
      throw new AgyError("busy", "An incompatible older Antigravity runtime is active in this process. Stop its workspaces and restart the OpenCode service before loading this version.", { code: "agy_runtime_reload_incompatible" });
    }
    const envPath = process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
    const explicit = envPath !== undefined ? envPath : acpPath;
    let executable: string;
    if (explicit !== undefined) {
      const source = envPath !== undefined ? "OPENCODE_ANTIGRAVITY_ACP_PATH" : "plugin option acpPath";
      if (typeof explicit !== "string" || !explicit.trim() || (envPath === undefined && !isAbsolute(explicit))) {
        throw new AgyError("invalid_request", `${source} must be a non-empty${envPath === undefined ? " absolute" : ""} path.`, { code: "agy_acp_path_invalid" });
      }
      try { executable = await resolveExplicit(explicit); }
      catch {
        // The generic resolver's diagnostics name the environment override,
        // which is misleading when the option is the winning source. Hosts
        // may render nested causes, so expose only the source-aware message.
        throw new AgyError("unsupported", `The ACP executable selected by ${source} could not be admitted. Check its path, permissions, platform and reviewed file hashes.`, { code: "agy_acp_path_rejected" });
      }
    } else if (state.runtime) {
      executable = state.runtime.executable;
    } else {
      executable = await selectLocalOrInstall();
    }
    if (state.runtime) {
      if (explicit !== undefined && executable !== state.runtime.executable) {
        const source = envPath !== undefined ? "OPENCODE_ANTIGRAVITY_ACP_PATH" : "plugin option acpPath";
        throw new AgyError("busy", `The ACP executable selected by ${source} conflicts with the shared runtime; stop its workspaces before changing it.`, { code: "agy_runtime_path_conflict" });
      }
      state.refs.set(root, (state.refs.get(root) ?? 0) + 1);
      return;
    }
    try {
      await startRuntimeInternal(root, executable);
      state.refs.set(root, (state.refs.get(root) ?? 0) + 1);
    } catch (error) {
      const manager = getRuntime()?.manager;
      state.runtime = null;
      await manager?.close();
      await sessionPool.close();
      throw error;
    }
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

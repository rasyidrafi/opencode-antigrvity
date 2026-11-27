import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { getRuntime, startRuntime, stopRuntime } from "../src/runtime.js";
import * as cli from "../src/agy-cli.js";
import * as installer from "../src/runtime-installer.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const directory = await mkdtemp(join(tmpdir(), "agy-runtime-"));
const env = { ...process.env };
let compatibility: ReturnType<typeof fixtureCompatibility>;

beforeAll(async () => {
  compatibility = fixtureCompatibility();
  process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(directory, "data");
  process.env.GEMINI_HOME = join(directory, "gemini");
  await chmod(fixture, 0o755);
});

afterAll(async () => {
  await stopRuntime(directory);
  compatibility.mockRestore();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  await rm(directory, { recursive: true, force: true });
});

test("a replacement start queued during shutdown gets a usable runtime", async () => {
  await startRuntime(directory);
  const manager = getRuntime()!.manager;
  const originalClose = manager.close.bind(manager);
  let enteredResolve!: () => void;
  const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
  let release!: () => void;
  const gated = new Promise<void>(resolve => { release = resolve; });
  const close = spyOn(manager, "close").mockImplementation(async () => {
    enteredResolve();
    await gated;
    await originalClose();
  });
  try {
    const stopping = stopRuntime(directory);
    await entered;
    // Without serialized lifecycle this increments the refcount and returns
    // while the old shutdown is still closing the shared runtime.
    const restarting = startRuntime(directory);
    await release();
    await Promise.all([stopping, restarting]);
    expect(getRuntime()).not.toBeNull();
  } finally {
    close.mockRestore();
  }
});

test("compatible module reload shares one bridge server", async () => {
  const first = await import("../src/host-tools.js");
  const original = await first.ensureHostBridgeServer();
  const reloaded = await import("../src/host-tools.ts?runtime-reload");
  expect(await reloaded.ensureHostBridgeServer()).toBe(original);
  await reloaded.stopHostBridgeServer();
  const replacement = await first.ensureHostBridgeServer();
  expect(replacement).not.toBe(original);
  await first.stopHostBridgeServer();
});

test("explicit selection is transactional, env wins, and discovery stays pinned", async () => {
  await stopRuntime();
  const other = join(directory, "other.mjs");
  await copyFile(fixture, other);
  await chmod(other, 0o755);
  const validate = spyOn(cli, "assertAgyCliCompatibility").mockImplementation(async (path) => {
    if (path !== fixture && path !== other) throw new Error("unreviewed");
  });
  const root2 = join(directory, "second");
  try {
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
    await startRuntime(directory, other);
    expect(getRuntime()?.executable).toBe(fixture);
    expect(getRuntime()?.catalog.executable).toBe(fixture);
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = other;
    await expect(startRuntime(root2, fixture)).rejects.toMatchObject({ code: "agy_runtime_path_conflict" });
    await stopRuntime(root2);
    expect(getRuntime()?.executable).toBe(fixture);
    await getRuntime()!.manager.refresh(true);
    expect(getRuntime()?.catalog.executable).toBe(fixture);
    await stopRuntime(directory);
    delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
    await expect(startRuntime(directory, "relative")).rejects.toMatchObject({ code: "agy_acp_path_invalid" });
    await expect(startRuntime(directory, join(directory, "missing"))).rejects.toThrow();
    const optionError = await startRuntime(directory, join(directory, "missing")).catch(error => error);
    expect(optionError.message).toContain("plugin option acpPath");
    expect(optionError.cause).toBeUndefined();
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = join(directory, "missing");
    await expect(startRuntime(directory, fixture)).rejects.toThrow("OPENCODE_ANTIGRAVITY_ACP_PATH");
    delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
    expect(getRuntime()).toBeNull();
    const results = await Promise.allSettled([startRuntime(directory, fixture), startRuntime(root2, other)]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(getRuntime()?.executable).toBe(fixture);
    await stopRuntime(directory);
    expect(getRuntime()).toBeNull();
  } finally {
    await stopRuntime();
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
    validate.mockRestore();
  }
});

test("a managed pair behind a symlinked cache ancestor is not selected", async () => {
  await stopRuntime();
  const saved = { ...process.env };
  const real = join(directory, "real-cache"), link = join(directory, "linked-cache");
  const managed = join(real, "opencode-antigravity", "runtime", "registry-1.5.2", "agy_acp_server.par");
  const bin = join(directory, "safe-bin");
  const validate = spyOn(cli, "assertAgyCliCompatibility").mockImplementation(async () => {});
  const install = spyOn(installer, "installManagedRuntime").mockImplementation(async () => { throw new Error("unexpected install"); });
  try {
    await mkdir(join(managed, ".."), { recursive: true, mode: 0o700 });
    await copyFile(fixture, managed); await chmod(managed, 0o700);
    await writeFile(join(managed, "..", "localharness_external"), "fixture", { mode: 0o700 });
    await symlink(real, link);
    await mkdir(bin); await symlink(fixture, join(bin, "agy"));
    delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
    process.env.XDG_CACHE_HOME = link; process.env.PATH = bin;
    await startRuntime(directory);
    expect(getRuntime()?.executable).toBe(fixture);
    expect(install).not.toHaveBeenCalled();
  } finally {
    await stopRuntime(); validate.mockRestore(); install.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("a module reload rejects an active legacy runtime without changing its owner", async () => {
  await stopRuntime();
  const global = globalThis as any;
  const previous = global.__agyRuntimeV1;
  const legacy = { runtime: { directory, manager: {} }, refs: new Map([[directory, 1]]), lifecycle: Promise.resolve() };
  global.__agyRuntimeV1 = legacy;
  try {
    const reloaded = await import("../src/runtime.ts?old-owner-test");
    await expect(reloaded.startRuntime(directory)).rejects.toMatchObject({ code: "agy_runtime_reload_incompatible" });
    expect(global.__agyRuntimeV1).toBe(legacy);
    expect(legacy.refs.get(directory)).toBe(1);
  } finally { global.__agyRuntimeV1 = previous; }
});

test("managed, PATH, then install selection is offline and failed install can retry", async () => {
  await stopRuntime();
  const saved = { ...process.env };
  const cache = join(directory, "selection-cache"), bin = join(directory, "bin");
  const managed = join(cache, "opencode-antigravity", "runtime", "registry-1.5.2", "agy_acp_server.par");
  const originalValidate = cli.assertAgyCliCompatibility;
  const validate = spyOn(cli, "assertAgyCliCompatibility").mockImplementation(async path => {
    if (path === managed || path === fixture) return;
    return originalValidate(path);
  });
  const noNetwork = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("unexpected network"); });
  let calls = 0;
  const install = spyOn(installer, "installManagedRuntime").mockImplementation(async () => {
    calls++;
    if (calls === 1) throw new Error("offline");
    await mkdir(join(managed, ".."), { recursive: true, mode: 0o700 });
    await copyFile(fixture, managed);
    await writeFile(join(managed, "..", "localharness_external"), "fixture", { mode: 0o700 });
    await chmod(managed, 0o700);
    return managed;
  });
  try {
    delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
    process.env.XDG_CACHE_HOME = cache;
    await mkdir(bin, { recursive: true });
    await symlink(fixture, join(bin, "agy"));
    process.env.PATH = bin;
    await startRuntime(directory);
    expect(getRuntime()?.executable).toBe(fixture);
    expect(calls).toBe(0);
    await stopRuntime(directory);
    process.env.PATH = "";
    await expect(cli.detectAgyAcp()).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(startRuntime(directory)).rejects.toMatchObject({ code: "agy_runtime_install_failed" });
    expect(getRuntime()).toBeNull();
    await startRuntime(directory);
    expect(getRuntime()?.executable).toBe(managed);
    expect(calls).toBe(2);
    await stopRuntime(directory);
    process.env.PATH = bin;
    await startRuntime(directory);
    expect(getRuntime()?.executable).toBe(managed);
    expect(calls).toBe(2);
    await stopRuntime(directory);
    expect(noNetwork).not.toHaveBeenCalled();
  } finally {
    await stopRuntime();
    install.mockRestore(); noNetwork.mockRestore(); validate.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("conflicting client identity for a running runtime is rejected; matching identity retains", async () => {
  await stopRuntime();
  const saved = { ...process.env };
  const root2 = join(directory, "identity-second");
  const validate = spyOn(cli, "assertAgyCliCompatibility").mockImplementation(async (path) => {
    if (path === fixture) return;
    return (cli.assertAgyCliCompatibility as any)(path);
  });
  try {
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
    delete process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;
    await startRuntime(directory, fixture, "zed");
    expect(getRuntime()?.clientIdentity?.name).toBe("zed");
    // Same identity: retained (refcounted).
    await startRuntime(root2, fixture, "zed");
    // Conflicting identity (default vs zed): rejected, runtime unchanged.
    await expect(startRuntime(root2, fixture)).rejects.toMatchObject({ code: "agy_runtime_client_identity_conflict" });
    expect(getRuntime()?.clientIdentity?.name).toBe("zed");
    await stopRuntime(root2);
    expect(getRuntime()?.clientIdentity?.name).toBe("zed");
    await stopRuntime(directory);
    expect(getRuntime()).toBeNull();
    // Default identity runtime rejects a zed workspace.
    await startRuntime(directory, fixture);
    expect(getRuntime()?.clientIdentity).toBeUndefined();
    await expect(startRuntime(root2, fixture, "zed")).rejects.toMatchObject({ code: "agy_runtime_client_identity_conflict" });
    await stopRuntime(directory);
    expect(getRuntime()).toBeNull();
  } finally {
    validate.mockRestore();
    await stopRuntime();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("running runtime manager scope equals the real pinned-identity scope", async () => {
  const { catalogContext } = await import("../src/model-catalog.js");
  const validate = spyOn(cli, "assertAgyCliCompatibility").mockImplementation(async (path) => {
    if (path === fixture) return;
    return (cli.assertAgyCliCompatibility as any)(path);
  });
  const savedEnv = { ...process.env };
  try {
    process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = fixture;
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(directory, "scope-data");
    process.env.GEMINI_HOME = join(directory, "scope-gemini");
    delete process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;
    await startRuntime(directory, fixture, "zed");
    try {
      const expected = await catalogContext(fixture, { name: "zed", version: "0.8.0" });
      expect(getRuntime()?.manager.scope).toBe(expected.scope);
      // Env changes after pinning do not move the live manager scope.
      process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = "bogus";
      await getRuntime()!.manager.refresh();
      expect(getRuntime()!.manager.scope).toBe(expected.scope);
    } finally { await stopRuntime(directory); }
    // Default runtime uses the default scope, distinct from zed's.
    delete process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;
    await startRuntime(directory, fixture);
    try {
      const expectedDefault = await catalogContext(fixture);
      expect(getRuntime()?.manager.scope).toBe(expectedDefault.scope);
      expect(getRuntime()!.manager.scope).not.toBe((await catalogContext(fixture, { name: "zed", version: "0.8.0" })).scope);
    } finally { await stopRuntime(directory); }
  } finally {
    validate.mockRestore();
    await stopRuntime();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

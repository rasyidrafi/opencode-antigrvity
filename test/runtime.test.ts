import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
import { getRuntime, startRuntime, stopRuntime } from "../src/runtime.js";

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

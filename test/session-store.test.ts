import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { SessionStore } from "../src/session-store.js";

describe("non-secret session persistence", () => {
  test("defaults to the opencode-antigravity directory under XDG_DATA_HOME", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "opencode-antigravity-xdg-store-"));
    const previousDataDir = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    try {
      delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
      process.env.XDG_DATA_HOME = dataHome;
      await new SessionStore().set("default-location", {
        sessionId: "session-id",
        model: "model",
        cwd: "/workspace",
        cliVersion: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastUsedAt: Date.now(),
      });
      const storePath = join(dataHome, "opencode-antigravity", "sessions.json");
      expect(JSON.parse(await readFile(storePath, "utf8"))["default-location"].sessionId).toBe("session-id");
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
      else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previousDataDir;
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  test("writes restrictive metadata and no credential fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-store-"));
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
    const store = new SessionStore();
    await store.set("hashed-session", {
      sessionId: "session-id",
      model: "model",
      effort: "low",
      cwd: "/workspace",
      cliVersion: "1.1.20",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    const raw = JSON.parse(await readFile(join(directory, "sessions.json"), "utf8"));
    expect(raw["hashed-session"].sessionId).toBe("session-id");
    expect(JSON.stringify(raw)).not.toContain("refresh");
    expect(JSON.stringify(raw)).not.toContain("access");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "sessions.json"))).mode & 0o777).toBe(0o600);
  });
});

test("independent store instances preserve each other's writes", async () => {
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "antigravity-store-concurrent-"));
  const left = new SessionStore();
  const right = new SessionStore();
  await Promise.all([left.entries(), right.entries()]);
  const record = { sessionId: "s", model: "m", cwd: "/workspace", cliVersion: null, createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: Date.now() };
  await Promise.all([left.set("left", record), right.set("right", record)]);
  expect((await left.entries()).map(([key]) => key).sort()).toEqual(["left", "right"]);
  expect((await right.entries()).length).toBe(2);
});

test("turn lock excludes another process and recovers a dead owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-store-process-"));
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  const storeModule = join(import.meta.dir, "..", "src", "session-store.ts");
  const child = Bun.spawn([process.execPath, "--eval", `
    const { SessionStore } = await import(${JSON.stringify(storeModule)});
    await new SessionStore().lockTurn("shared");
    console.log("locked");
    await Bun.stdin.text();
  `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    await expect(new SessionStore().lockTurn("shared")).rejects.toThrow("busy");
    child.kill("SIGKILL");
    await child.exited;
    const unlock = await new SessionStore().lockTurn("shared");
    await unlock();
  } finally {
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
});

test("concurrent processes preserve every session mapping", async () => {
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "antigravity-store-writers-"));
  const storeModule = join(import.meta.dir, "..", "src", "session-store.ts");
  const children = Array.from({ length: 3 }, (_, index) => Bun.spawn([process.execPath, "--eval", `
    const { SessionStore } = await import(${JSON.stringify(storeModule)});
    const store = new SessionStore();
    for (let i = 0; i < 5; i++) await store.set(${JSON.stringify(String(index))} + "-" + i, {
      sessionId: "s", model: "m", cwd: "/workspace", cliVersion: null,
      createdAt: Date.now(), updatedAt: Date.now(), lastUsedAt: Date.now()
    });
  `], { env: { ...process.env }, stdout: "ignore", stderr: "pipe" }));
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0]);
  expect((await new SessionStore().entries()).length).toBe(15);
});

test("pruning preserves sessions locked by another owner", async () => {
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = await mkdtemp(join(tmpdir(), "antigravity-store-prune-"));
  const store = new SessionStore();
  await store.set("active", { sessionId: "s", model: "m", cwd: "/workspace", cliVersion: null,
    createdAt: 1, updatedAt: 1, lastUsedAt: 1 });
  const unlock = await store.lockTurn("active");
  try {
    await new SessionStore().prune(0);
    expect(await store.get("active")).toBeDefined();
  } finally { await unlock(); }
  await store.prune(0);
  expect(await store.get("active")).toBeUndefined();
});

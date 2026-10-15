import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { acquireFileLock } from "../src/file-lock.js";
import { AgyBusyError } from "../src/errors.js";

/** A token whose owner cannot exist: reap the exiting child before using it. */
async function deadOwnerToken(): Promise<string> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return `${child.pid}:00000000-0000-0000-0000-000000000000`;
}

/** Build base plus `levels` reaper chain files, all owned by `token`. */
async function poison(directory: string, levels: number, token: string): Promise<string> {
  const base = join(directory, "resource.lock");
  await writeFile(base, token);
  let path = base;
  for (let index = 0; index < levels; index++) {
    path = `${path}.reap`;
    await writeFile(path, token);
  }
  return base;
}

describe("stale-lock recovery at the reaper guard depth", () => {
  test("acquires a lock whose entire reaper chain is dead", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const base = await poison(directory, 8, await deadOwnerToken());
      const release = await acquireFileLock(base, 2_000);
      await release();
      // The recovered lock must remain reusable.
      const again = await acquireFileLock(base, 2_000);
      await again();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reclaims a single dead owner without a reaper chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const base = await poison(directory, 0, await deadOwnerToken());
      const release = await acquireFileLock(base, 1_000);
      await release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps failing closed while chain owners are alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-lock-"));
    try {
      const base = await poison(directory, 8, `${process.pid}:11111111-1111-1111-1111-111111111111`);
      let busy: unknown;
      try {
        await acquireFileLock(base, 300);
      } catch (error) {
        busy = error;
      }
      expect(busy).toBeInstanceOf(AgyBusyError);
      // No owner was reclaimed: the chain ownership is protected.
      expect((await readdir(directory)).length).toBe(9);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

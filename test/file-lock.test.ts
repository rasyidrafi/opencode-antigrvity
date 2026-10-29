import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";
import koffi from "koffi";
import { acquireFileLock, decodeWindowsProfilePath } from "../src/file-lock.js";
import { AgyBusyError } from "../src/errors.js";

async function isolatedData(): Promise<() => Promise<void>> {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-native-lock-"));
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  return async () => {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  };
}

async function deadOwnerToken(): Promise<string> {
  const child = Bun.spawn([process.execPath, "--eval", ""], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  await child.exited;
  if (pid === undefined) throw new Error("Could not start dead-owner fixture");
  return `${pid}:${randomUUID()}`;
}

async function poison(path: string, levels: number, token: string): Promise<void> {
  await writeFile(path, token);
  for (let depth = 1, current = `${path}.reap`; depth <= levels; depth++, current += ".reap") {
    await writeFile(current, token);
  }
}

async function startHolder(path: string, environment: Record<string, string> = {}) {
  const module = pathToFileURL(join(import.meta.dir, "../src/file-lock.ts")).href;
  const script = `
    const { acquireFileLock } = await import(${JSON.stringify(module)});
    const release = await acquireFileLock(${JSON.stringify(path)}, 5000);
    console.log("acquired");
    await Bun.stdin.text();
    await release();
  `;
  return Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, ...environment },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function expectBusy(path: string, waitMs = 0): Promise<void> {
  await expect(acquireFileLock(path, waitMs)).rejects.toBeInstanceOf(AgyBusyError);
}

describe("crash-released native file locks", () => {
  test("Windows account-profile decoding reads inline UTF-16 buffers", () => {
    const home = "C:\\Users\\Ångström\\AppData\\Local";
    const buffer = Buffer.from(`${home}\0`, "utf16le");
    expect(decodeWindowsProfilePath(koffi, buffer)).toBe(home);
  });

  test("recovers fully dead legacy chains of any historical depth", async () => {
    const restore = await isolatedData();
    try {
      for (const depth of [0, 8, 9, 32]) {
        const path = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, `resource-${depth}.lock`);
        await poison(path, depth, await deadOwnerToken());
        const release = await acquireFileLock(path, 1000);
        await release();
        await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        for (let index = 1, current = `${path}.reap`; index <= depth; index++, current += ".reap") {
          await expect(readFile(current, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    } finally { await restore(); }
  });

  test("preserves live, malformed, and unknown legacy owners", async () => {
    const restore = await isolatedData();
    try {
      const livePath = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, "live.lock");
      const live = `${process.pid}:${randomUUID()}`;
      await writeFile(livePath, live);
      await writeFile(`${livePath}.reap`, await deadOwnerToken());
      await expectBusy(livePath);
      expect(await readFile(livePath, "utf8")).toBe(live);
      expect(await readFile(`${livePath}.reap`, "utf8")).not.toBe("");

      for (const [name, token] of [["malformed", "not-an-owner"], ["unknown", `${process.pid}:not-a-uuid`]]) {
        const path = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, `${name}.lock`);
        await writeFile(path, token);
        await expectBusy(path);
        expect(await readFile(path, "utf8")).toBe(token);
      }
    } finally { await restore(); }
  });

  test("zero and bounded waits preserve ownership; release is idempotent", async () => {
    const restore = await isolatedData();
    try {
      const path = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, "wait.lock");
      const release = await acquireFileLock(path);
      const start = Date.now();
      await expectBusy(path);
      expect(Date.now() - start).toBeLessThan(250);
      const boundedStart = Date.now();
      await expectBusy(path, 100);
      expect(Date.now() - boundedStart).toBeGreaterThanOrEqual(70);
      expect(Date.now() - boundedStart).toBeLessThan(1000);
      await release();
      await release();
      const next = await acquireFileLock(path);
      await next();
    } finally { await restore(); }
  });

  test("independent keys progress and competing processes never overlap", async () => {
    const restore = await isolatedData();
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const path = join(root, "shared.lock");
    const parentRelease = await acquireFileLock(path);
    const other = await acquireFileLock(join(root, "unrelated.lock"));
    await other();
    const child = await startHolder(path);
    const reader = child.stdout.getReader();
    try {
      const pendingOutput = reader.read();
      const acquiredEarly = await Promise.race([pendingOutput.then(() => true), Bun.sleep(100).then(() => false)]);
      expect(acquiredEarly).toBe(false);
      await parentRelease();
      expect(new TextDecoder().decode((await pendingOutput).value)).toContain("acquired");
      child.stdin.end();
      expect(await child.exited).toBe(0);
    } finally {
      reader.releaseLock();
      child.kill();
      await child.exited;
      await parentRelease();
      await restore();
    }
  });

  test("physical path aliases share a guard, including missing descendants", async () => {
    const restore = await isolatedData();
    try {
      const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
      const target = join(root, "physical-target");
      const alias = join(root, "physical-alias");
      await mkdir(target);
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
      const directPath = join(target, "not-created-yet", "resource.lock");
      const aliasPath = join(alias, "not-created-yet", "resource.lock");
      const release = await acquireFileLock(directPath);
      await expectBusy(aliasPath);
      await release();

      if (process.platform === "win32") {
        const differentlyCased = join(dirname(target), basename(target).toUpperCase(), "not-created-yet", "resource.lock");
        const caseRelease = await acquireFileLock(directPath);
        await expectBusy(differentlyCased);
        await caseRelease();
      }
    } finally { await restore(); }
  });

  test("same-store processes share the guard despite HOME and XDG overrides", async () => {
    const restore = await isolatedData();
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const path = join(root, "sessions.lock");
    const holder = await startHolder(path, {
      OPENCODE_ANTIGRAVITY_DATA_DIR: root,
      XDG_DATA_HOME: join(root, "xdg-holder"),
      HOME: join(root, "home-holder"),
    });
    const holderReader = holder.stdout.getReader();
    let contenderReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      expect(new TextDecoder().decode((await holderReader.read()).value)).toContain("acquired");
      const module = pathToFileURL(join(import.meta.dir, "../src/file-lock.ts")).href;
      const script = `
        const { acquireFileLock } = await import(${JSON.stringify(module)});
        try {
          const release = await acquireFileLock(${JSON.stringify(path)});
          await release();
          console.log("acquired");
        } catch (error) {
          if (error.code !== "agy_session_busy") throw error;
          console.log("busy");
        }
      `;
      const contender = Bun.spawn([process.execPath, "--eval", script], {
        env: {
          ...process.env,
          OPENCODE_ANTIGRAVITY_DATA_DIR: root,
          XDG_DATA_HOME: join(root, "xdg-contender"),
          HOME: join(root, "home-contender"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      contenderReader = contender.stdout.getReader();
      const output = new TextDecoder().decode((await contenderReader.read()).value);
      expect(await contender.exited).toBe(0);
      expect(output).toContain("busy");
      holder.stdin.end();
      expect(await holder.exited).toBe(0);
    } finally {
      contenderReader?.releaseLock();
      holderReader.releaseLock();
      holder.kill();
      await holder.exited;
      await restore();
    }
  });

  test("a killed native-lock holder is reclaimed by the OS", async () => {
    const restore = await isolatedData();
    const path = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, "crash.lock");
    const holder = await startHolder(path);
    const reader = holder.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("acquired");
      await expectBusy(path);
      holder.kill();
      await holder.exited;
      const recovered = await acquireFileLock(path, 2000);
      await recovered();
    } finally {
      reader.releaseLock();
      holder.kill();
      await holder.exited;
      await restore();
    }
  });

  test("utility-directory removal cannot replace an active lock inode", async () => {
    const restore = await isolatedData();
    try {
      const utility = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, "utilities", "utility-retention");
      const path = join(utility, ".owner");
      const release = await acquireFileLock(path);
      await rm(utility, { recursive: true, force: true });
      await expectBusy(path);
      await release();
      const next = await acquireFileLock(path);
      await next();
    } finally { await restore(); }
  });
});

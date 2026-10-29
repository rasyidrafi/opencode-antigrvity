import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SessionStore } from "../src/session-store.js";

async function isolatedData(): Promise<() => Promise<void>> {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-deletion-recovery-"));
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  return async () => {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "--eval", ""], { stdout: "ignore", stderr: "ignore" });
  const pid = child.pid;
  await child.exited;
  if (pid === undefined) throw new Error("Could not start dead-owner fixture");
  return pid;
}

test("deletion tombstones are idempotent and never regress from cleaned to pending", async () => {
  const restore = await isolatedData();
  try {
    const store = new SessionStore();
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const host = "stable-deletion-tombstone";
    const path = join(root, "deleted", `${digest(host)}.json`);

    await store.markHostDeleted(host);
    const first = await stat(path);
    const pending = await readFile(path, "utf8");
    expect(JSON.parse(pending)).toEqual({ version: 1, hostSessionID: host });
    expect(await store.deletedHosts()).toContain(host);
    await Bun.sleep(30);
    await store.markHostDeleted(host);
    expect((await stat(path)).mtimeMs).toBe(first.mtimeMs);

    await store.removeHostSession(host);
    const cleaned = JSON.parse(await readFile(path, "utf8"));
    expect(cleaned).toEqual({ version: 1, hostSessionID: host, cleaned: true });
    const cleanedStat = await stat(path);
    await Bun.sleep(30);
    await store.markHostDeleted(host);
    expect(JSON.parse(await readFile(path, "utf8")).cleaned).toBe(true);
    expect((await stat(path)).mtimeMs).toBe(cleanedStat.mtimeMs);
    expect(await store.deletedHosts()).not.toContain(host);
  } finally { await restore(); }
});

test("startup sweeps only exact historical temp names with definitely dead owners", async () => {
  const restore = await isolatedData();
  try {
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const deleted = join(root, "deleted");
    await mkdir(deleted, { recursive: true });
    const base = `${digest("legacy-host")}.json`;
    const dead = join(deleted, `${base}.${await deadPid()}.${randomUUID()}.tmp`);
    const active = join(deleted, `${base}.${process.pid}.${randomUUID()}.tmp`);
    const malformed = join(deleted, `${base}.2147483647.not-a-uuid.tmp`);
    const unrelated = join(deleted, `${base}.2147483647.${randomUUID()}.tmp.extra`);
    await Promise.all([dead, active, malformed, unrelated].map(path => writeFile(path, "staged")));
    // This unrelated legacy marker is intentionally not consulted or required
    // for the tombstone sweep; no sessions.lock acquisition occurs here.
    await writeFile(join(root, "sessions.lock"), "malformed legacy owner");

    expect(await new SessionStore().deletedHosts()).toEqual([]);
    await expect(readFile(dead, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(active, "utf8")).toBe("staged");
    expect(await readFile(malformed, "utf8")).toBe("staged");
    expect(await readFile(unrelated, "utf8")).toBe("staged");
  } finally { await restore(); }
});

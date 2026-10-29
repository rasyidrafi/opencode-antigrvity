import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { zipSync, strToU8 } from "fflate";
import { acpDistribution, installAcpServer, unpackAcpArchive } from "../src/acp-install.js";

test("first-use install extracts the pair once across concurrent requests and reuses it offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-install-"));
  const distribution = acpDistribution();
  const archive = zipSync({
    [`release/${distribution.executable}`]: strToU8("#!/bin/sh\nexit 0\n"),
    [`release/${distribution.companion}`]: strToU8("companion"),
    "../../unwanted": strToU8("must not extract"),
  });
  let calls = 0;
  const download = (async (url: string) => {
    expect(url).toBe(distribution.url);
    calls++;
    return new Response(archive);
  }) as typeof fetch;
  try {
    const directory = join(root, "acp-server-1.3.0");
    await mkdir(directory, { recursive: true });
    const dead = Bun.spawn([process.execPath, "--eval", ""], { stdout: "ignore", stderr: "ignore" });
    const deadPid = dead.pid;
    await dead.exited;
    if (deadPid === undefined) throw new Error("Could not create stale install-lock fixture");
    await writeFile(join(directory, ".install.lock"), `${deadPid}:${randomUUID()}`);
    const paths = await Promise.all([installAcpServer(directory, download), installAcpServer(directory, download)]);
    expect(paths[0]).toBe(paths[1]);
    expect(calls).toBe(1);
    expect(await readFile(join(directory, distribution.companion), "utf8")).toBe("companion");
    if (process.platform !== "win32") expect((await stat(paths[0])).mode & 0o111).toBe(0o111);
    await installAcpServer(directory, download);
    expect(calls).toBe(1);
    expect(() => unpackAcpArchive(zipSync({ other: strToU8("wrong") }), [distribution.executable, distribution.companion])).toThrow(/missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed download leaves no discoverable executable and can be retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-install-fail-"));
  try {
    await expect(installAcpServer(root, (async () => new Response("unavailable", { status: 503 })) as typeof fetch)).rejects.toThrow(/503/);
    await expect(stat(join(root, acpDistribution().executable))).rejects.toThrow();
    await expect(stat(join(root, ".install.lock"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the shared installation lock rendezvouses across different metadata data directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-install-lock-identity-"));
  const installDirectory = join(root, "shared-install");
  const lockPath = join(installDirectory, ".install.lock");
  const module = pathToFileURL(join(import.meta.dir, "../src/file-lock.ts")).href;
  const dataA = join(root, "metadata-a");
  const dataB = join(root, "metadata-b");
  const holderScript = `
    const { acquireFileLock } = await import(${JSON.stringify(module)});
    const release = await acquireFileLock(${JSON.stringify(lockPath)});
    console.log("held");
    await Bun.stdin.text();
    await release();
  `;
  const contenderScript = `
    const { acquireFileLock } = await import(${JSON.stringify(module)});
    try {
      const release = await acquireFileLock(${JSON.stringify(lockPath)});
      await release();
      console.log("acquired");
    } catch (error) {
      if (error.code !== "agy_session_busy") throw error;
      console.log("busy");
    }
  `;
  const holder = Bun.spawn([process.execPath, "--eval", holderScript], {
    env: { ...process.env, OPENCODE_ANTIGRAVITY_DATA_DIR: dataA },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const holderReader = holder.stdout.getReader();
  let contenderReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    expect(new TextDecoder().decode((await holderReader.read()).value)).toContain("held");
    const contender = Bun.spawn([process.execPath, "--eval", contenderScript], {
      env: { ...process.env, OPENCODE_ANTIGRAVITY_DATA_DIR: dataB },
      stdout: "pipe", stderr: "pipe",
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
    await rm(root, { recursive: true, force: true });
  }
});

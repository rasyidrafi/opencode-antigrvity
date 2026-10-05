import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    const paths = await Promise.all([installAcpServer(directory, download), installAcpServer(directory, download)]);
    expect(paths[0]).toBe(paths[1]);
    expect(calls).toBe(1);
    expect(await readFile(join(directory, distribution.companion), "utf8")).toBe("companion");
    expect((await stat(paths[0])).mode & 0o111).toBe(0o111);
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

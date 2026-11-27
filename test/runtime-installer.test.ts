import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { installManagedRuntime, managedRuntimePath } from "../src/runtime-installer.js";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const contents = { "agy_acp_server.par": Buffer.from("launcher"), "localharness_external": Buffer.from("companion") };
  const zip = Buffer.from(zipSync(contents));
  for (let i = 0; i < zip.length - 46; i++) if (zip.readUInt32LE(i) === 0x02014b50) { zip.writeUInt32LE(0x81ed0000, i + 38); i += 45; }
  return { zip, manifest: { archiveHash: hash(zip), archiveLimit: 10000, files: Object.fromEntries(Object.entries(contents).map(([name, data]) => [name, { hash: hash(data), size: data.length }])) } };
}
test("installs atomically, reuses valid files, and repairs a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { zip, manifest } = fixture(); let calls = 0;
    const options = { directory, manifest, fetch: (async () => { calls++; return new Response(zip); }) as typeof fetch };
    const path = await installManagedRuntime(options);
    expect(path).toBe(managedRuntimePath(options)); expect(await readFile(path, "utf8")).toBe("launcher");
    await installManagedRuntime(options); expect(calls).toBe(1);
    await rm(path); await symlink("/etc/passwd", path);
    await installManagedRuntime(options); expect(calls).toBe(2); expect(await readFile(path, "utf8")).toBe("launcher");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("rejects checksum errors without exposing a partial installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { zip, manifest } = fixture();
    const options = { directory, manifest: { ...manifest, archiveHash: "bad" }, fetch: (async () => new Response(zip)) as typeof fetch };
    await expect(installManagedRuntime(options)).rejects.toThrow("checksum");
    await expect(readFile(managedRuntimePath(options))).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("rejects symlink ZIP entries even with a trusted archive hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { zip, manifest } = fixture(); const pos = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); zip.writeUInt32LE(0xa1ff0000, pos + 38);
    await expect(installManagedRuntime({ directory, manifest: { ...manifest, archiveHash: hash(zip) }, fetch: (async () => new Response(zip)) as typeof fetch })).rejects.toThrow("Unexpected ZIP entry");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("enforces download bounds and rejects redirects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { zip, manifest } = fixture();
    await expect(installManagedRuntime({ directory, manifest: { ...manifest, archiveLimit: 4 }, fetch: (async () => new Response(zip)) as typeof fetch })).rejects.toThrow("size limit");
    await expect(installManagedRuntime({ directory, manifest, fetch: (async () => new Response(null, { status: 302, headers: { location: "https://example.com" } })) as typeof fetch })).rejects.toThrow("download failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects unsafe cache permissions and symlink ancestry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { chmod, mkdir } = await import("node:fs/promises");
    await chmod(directory, 0o755);
    await expect(installManagedRuntime({ directory })).rejects.toThrow("private");
    await chmod(directory, 0o700);
    await mkdir(join(directory, "real")); await symlink(join(directory, "real"), join(directory, "link"));
    await expect(installManagedRuntime({ directory: join(directory, "link", "cache") })).rejects.toThrow("Unsafe");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stalled download times out and competing installer waits for lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { zip, manifest } = fixture();
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    const stalled = installManagedRuntime({ directory, manifest, timeoutMs: 150, fetch: (async () => { started(); return await new Promise<Response>(() => {}); }) as typeof fetch });
    const observed = stalled.catch(e => e);
    await ready;
    await expect(installManagedRuntime({ directory, manifest, timeoutMs: 40, fetch: (async () => new Response(zip)) as typeof fetch })).rejects.toThrow("timed out");
    expect((await observed).message).toContain("timed out");
    await installManagedRuntime({ directory, manifest, fetch: (async () => new Response(zip)) as typeof fetch });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reclaims abandoned stages after a killed installer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", `import { installManagedRuntime } from ${JSON.stringify(new URL("../src/runtime-installer.ts", import.meta.url).href)}; await installManagedRuntime({ directory: ${JSON.stringify(directory)}, fetch: async () => { console.log('READY'); return await new Promise(() => {}); } });`], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => { child.stdout.on("data", () => resolve()); child.on("error", reject); child.on("exit", code => reject(new Error(`child exited ${code}`))); });
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(directory)).some(x => x.startsWith(".install-"))).toBe(true);
    child.kill("SIGKILL"); await new Promise(resolve => child.once("exit", resolve));
    const { zip, manifest } = fixture();
    await installManagedRuntime({ directory, manifest, fetch: (async () => new Response(zip)) as typeof fetch });
    expect((await readdir(directory)).some(x => x.startsWith(".install-"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects inconsistent CRC and overlapping local records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    for (const mutation of ["crc", "overlap"]) {
      const { zip, manifest } = fixture();
      const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      if (mutation === "crc") { zip.writeUInt32LE(0, 14); zip.writeUInt32LE(0, central + 16); }
      else { const next = central + 46 + zip.readUInt16LE(central + 28) + zip.readUInt16LE(central + 30) + zip.readUInt16LE(central + 32); zip.writeUInt32LE(0, next + 42); }
      await expect(installManagedRuntime({ directory, manifest: { ...manifest, archiveHash: hash(zip) }, fetch: (async () => new Response(zip)) as typeof fetch })).rejects.toThrow();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.skipIf(!process.env.AGY_INSTALLER_SMOKE_ARCHIVE)("opt-in official cached archive smoke", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-smoke-"));
  try {
    const archive = Bun.file(process.env.AGY_INSTALLER_SMOKE_ARCHIVE!);
    const executable = await installManagedRuntime({ directory, timeoutMs: 300_000, fetch: (async () => new Response(archive.stream())) as typeof fetch });
    expect(executable).toBe(managedRuntimePath({ directory }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 360_000);

test("slow but progressing download survives the total budget; stall still times out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { zip, manifest } = fixture();
    // Stream the archive in chunks with gaps longer than each single gap
    // budget but shorter than the idle window: progress resets the idle
    // deadline, so this completes well past a fixed total timeout.
    const slowFetch = (async () => {
      const step = Math.max(1, Math.floor(zip.length / 5));
      const stream = new ReadableStream({
        async start(controller) {
          let offset = 0;
          while (offset < zip.length) {
            const end = Math.min(offset + step, zip.length);
            controller.enqueue(zip.subarray(offset, end));
            offset = end;
            await new Promise(r => setTimeout(r, 40));
          }
          controller.close();
        },
      });
      return new Response(stream);
    }) as typeof fetch;
    const url = await installManagedRuntime({ directory, manifest, timeoutMs: 120, fetch: slowFetch });
    expect(url).toBe(managedRuntimePath({ directory }));
    expect(await readFile(url, "utf8")).toBe("launcher");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("overall hard cap aborts a trickling download that never stalls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { manifest } = fixture();
    const trickleFetch = (async () => {
      const stream = new ReadableStream({
        async start(controller) {
          // One byte every 30ms keeps the idle deadline perpetually reset,
          // but the 200ms overall cap must still terminate the install.
          for (let i = 0; i < 100; i++) {
            controller.enqueue(new Uint8Array([65]));
            await new Promise(r => setTimeout(r, 30));
          }
          controller.close();
        },
      });
      return new Response(stream);
    }) as typeof fetch;
    await expect(installManagedRuntime({ directory, manifest, idleTimeoutMs: 10_000, maxTimeoutMs: 200, fetch: trickleFetch })).rejects.toThrow("overall");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("honors external cancellation while downloading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const controller = new AbortController(); let started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const promise = installManagedRuntime({ directory, signal: controller.signal, fetch: (async () => { started(); return await new Promise<Response>(() => {}); }) as typeof fetch });
    const result = promise.catch(e => e); await ready; controller.abort(new Error("cancelled by caller"));
    expect((await result).message).toContain("cancelled by caller");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("FIFO in an existing installation does not block verification or retain lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const { spawnSync } = await import("node:child_process");
    const target = join(directory, "registry-1.5.2"); await mkdir(target, { mode: 0o700 });
    expect(spawnSync("mkfifo", [join(target, "agy_acp_server.par")]).status).toBe(0);
    await writeFile(join(target, "localharness_external"), "companion", { mode: 0o700 });
    const { zip, manifest } = fixture();
    const opts = { directory, manifest, timeoutMs: 1000, fetch: (async () => new Response(zip)) as typeof fetch };
    // A separate process and external watchdog are required: a synchronous FIFO open
    // can block the event loop, so an in-process timeout cannot detect it.
    const child = Bun.spawn([process.execPath, "-e", `import { installManagedRuntime } from ${JSON.stringify(new URL("../src/runtime-installer.ts", import.meta.url).href)}; await installManagedRuntime({ directory: ${JSON.stringify(directory)}, timeoutMs: 500, fetch: async () => { throw Error('verified FIFO'); } });`], { stdout: "ignore", stderr: "pipe" });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 2000);
    const code = await child.exited; clearTimeout(watchdog);
    expect(code).not.toBe(137); expect(await new Response(child.stderr).text()).toContain("verified FIFO");
    await installManagedRuntime(opts);
    expect(await readFile(managedRuntimePath(opts), "utf8")).toBe("launcher");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stalled response body aborts and redirect policy is passed to fetch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { manifest } = fixture(); let redirect: RequestRedirect | undefined;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
    }) as typeof fetch;
    await expect(installManagedRuntime({ directory, manifest, fetch: fetcher, timeoutMs: 80 })).rejects.toThrow();
    expect(redirect).toBe("error");
    const { zip } = fixture();
    await installManagedRuntime({ directory, manifest, fetch: (async () => new Response(zip)) as typeof fetch });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("valid archive digest with incorrect payload digest is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  try {
    const { zip, manifest } = fixture();
    manifest.files["agy_acp_server.par"]!.hash = "0".repeat(64);
    await expect(installManagedRuntime({ directory, manifest, fetch: (async () => new Response(zip)) as typeof fetch })).rejects.toThrow("file checksum");
    await expect(readFile(managedRuntimePath({ directory }))).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("independent concurrent installers share one download and publish once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installer-test-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const { zip, manifest } = fixture();
    const moduleUrl = new URL("../src/runtime-installer.ts", import.meta.url).href;
    const script = `import { installManagedRuntime } from ${JSON.stringify(moduleUrl)};
      import { appendFile } from 'node:fs/promises';
      const result = await installManagedRuntime({directory: ${JSON.stringify(directory)}, manifest: ${JSON.stringify(manifest)}, timeoutMs: 5000, fetch: async () => { await appendFile(${JSON.stringify(join(directory, "downloads"))}, 'x'); await new Promise(r => setTimeout(r, 150)); return new Response(Buffer.from(${JSON.stringify(zip.toString("base64"))}, 'base64')); }});
      console.log(result);`;
    for (let i = 0; i < 2; i++) children.push(Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }));
    const watchdog = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 8000);
    try {
      const results = await Promise.all(children.map(async child => ({ code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })));
      for (const result of results) { expect(result.err).toBe(""); expect(result.code).toBe(0); expect(result.out.trim()).toBe(managedRuntimePath({ directory })); }
    } finally { clearTimeout(watchdog); }
    expect(await readFile(join(directory, "downloads"), "utf8")).toBe("x");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(directory)).filter(x => x.startsWith(".install-"))).toEqual([]);
  } finally { for (const child of children) child.kill(); await rm(directory, { recursive: true, force: true }); }
}, 10_000);

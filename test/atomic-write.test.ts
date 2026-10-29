import { mkdtemp, open, readdir, readFile, rm, unlink, mkdir, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { atomicWrite, type AtomicWriteOperations } from "../src/atomic-write.js";

async function isolatedData(): Promise<() => Promise<void>> {
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), "opencode-antigravity-atomic-write-"));
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = directory;
  return async () => {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  };
}

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test("atomic writes serialize and reuse a bounded set of staging names", async () => {
  const restore = await isolatedData();
  try {
    const path = join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, "deleted", "record.json");
    await Promise.all(Array.from({ length: 12 }, (_, index) => atomicWrite(path, { index })));
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ index: expect.any(Number) });
    const names = await readdir(join(process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!, "deleted"));
    expect(names.filter(name => name.includes(".tmp")).length).toBeLessThanOrEqual(4);
    expect(names.some(name => name.includes(".tmp"))).toBe(false);
  } finally { await restore(); }
});

test("atomic staging remains serialized through symlink aliases of a missing target", async () => {
  const restore = await isolatedData();
  try {
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const target = join(root, "physical-target");
    const alias = join(root, "physical-alias");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    const targetPath = join(target, "new", "record.json");
    const aliasPath = join(alias, "new", "record.json");
    let activeStaging = 0;
    let maximumActiveStaging = 0;
    const base: AtomicWriteOperations = { mkdir, open, rename, unlink };
    const tracked: AtomicWriteOperations = {
      ...base,
      open: (async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (!String(args[0]).includes(".tmp-")) return handle;
        activeStaging++;
        maximumActiveStaging = Math.max(maximumActiveStaging, activeStaging);
        return {
          writeFile: async (...writeArgs: Parameters<typeof handle.writeFile>) => {
            await Bun.sleep(25);
            return handle.writeFile(...writeArgs);
          },
          sync: handle.sync.bind(handle),
          close: async () => { try { await handle.close(); } finally { activeStaging--; } },
        } as Awaited<ReturnType<typeof open>>;
      }) as typeof open,
    };
    await Promise.all([
      atomicWrite(targetPath, { writer: "physical" }, tracked),
      atomicWrite(aliasPath, { writer: "alias" }, tracked),
    ]);
    expect(maximumActiveStaging).toBe(1);
    expect(["physical", "alias"]).toContain(JSON.parse(await readFile(targetPath, "utf8")).writer);
  } finally { await restore(); }
});

test("write and sync failures clean staging files without hiding the original error", async () => {
  const restore = await isolatedData();
  try {
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const path = join(root, "write.json");
    const base: AtomicWriteOperations = { mkdir, open, rename, unlink };
    const writeFailure = {
      ...base,
      open: (async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (String(args[0]).includes(".tmp-")) return {
          writeFile: async () => { throw codedError("EIO"); },
          sync: handle.sync.bind(handle),
          close: handle.close.bind(handle),
        } as Awaited<ReturnType<typeof open>>;
        return handle;
      }) as typeof open,
    };
    await expect(atomicWrite(path, { value: 1 }, writeFailure)).rejects.toMatchObject({ code: "EIO" });

    const syncFailure = {
      ...base,
      open: (async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (String(args[0]).includes(".tmp-")) return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => { throw codedError("EIO"); },
          close: handle.close.bind(handle),
        } as Awaited<ReturnType<typeof open>>;
        return handle;
      }) as typeof open,
    };
    await expect(atomicWrite(path, { value: 2 }, syncFailure)).rejects.toMatchObject({ code: "EIO" });
    expect((await readdir(root)).filter(name => name.includes(".tmp")).length).toBe(0);
  } finally { await restore(); }
});

test("repeated rename and unlink failures cannot create unbounded temp files", async () => {
  const restore = await isolatedData();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const directory = join(root, "deleted");
    const path = join(directory, "record.json");
    const activeTemps = new Set<string>();
    const base: AtomicWriteOperations = { mkdir, open, rename, unlink };
    const failing: AtomicWriteOperations = {
      ...base,
      open: (async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (String(args[0]).includes(".tmp-")) activeTemps.add(String(args[0]));
        return handle;
      }) as typeof open,
      rename: async () => { throw codedError("EPERM"); },
      unlink: async file => {
        if (activeTemps.has(String(file))) throw codedError("EPERM");
        return unlink(file);
      },
    };
    for (let attempt = 0; attempt < 5; attempt++) await expect(atomicWrite(path, { attempt }, failing)).rejects.toThrow();
    const staged = (await readdir(directory)).filter(name => name.includes(".tmp-"));
    expect(staged).toHaveLength(4);
    await expect(atomicWrite(path, { attempt: 6 }, failing)).rejects.toThrow(/staging slot/);
    expect((await readdir(directory)).filter(name => name.includes(".tmp-")).length).toBe(4);
  } finally {
    console.warn = originalWarn;
    await restore();
  }
});

test("persistent cleanup warnings contain only sanitized error metadata", async () => {
  const restore = await isolatedData();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => { warnings.push(values); };
  try {
    const root = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR!;
    const directory = join(root, "deleted");
    const path = join(directory, "record.json");
    const activeTemps = new Set<string>();
    const base: AtomicWriteOperations = { mkdir, open, rename, unlink };
    const failure = {
      ...base,
      open: (async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (String(args[0]).includes(".tmp-")) activeTemps.add(String(args[0]));
        return handle;
      }) as typeof open,
      rename: async () => { throw codedError("EPERM"); },
      unlink: async file => {
        if (activeTemps.has(String(file))) throw codedError("EBUSY");
        return unlink(file);
      },
    };
    await expect(atomicWrite(path, { secret: "not-logged" }, failure)).rejects.toMatchObject({ code: "EPERM" });
    expect(warnings.some(values => values.join(" ").includes("code=EBUSY"))).toBe(true);
    expect(warnings.flat().join(" ")).not.toContain("not-logged");
  } finally {
    console.warn = originalWarn;
    await restore();
  }
});

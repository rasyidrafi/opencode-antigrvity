import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("packed source entrypoint resolves its shim from a path containing spaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy packed layout "));
  try {
    const pack = Bun.spawnSync(["bun", "pm", "pack", "--ignore-scripts", "--filename", join(root, "package.tgz")], { cwd: resolve(import.meta.dir, "..") });
    expect(pack.exitCode).toBe(0);
    const extract = Bun.spawnSync(["tar", "-xzf", join(root, "package.tgz"), "-C", root]);
    expect(extract.exitCode).toBe(0);
    const packageDir = join(root, "package");
    await symlink(resolve(import.meta.dir, "../node_modules"), join(packageDir, "node_modules"), "dir");
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    expect(manifest.exports["."].import).toBe("./src/index.ts");
    // Isolate the packed module graph from the suite's shared module mocks.
    const script = `
      import { fileURLToPath } from "node:url";
      import { strict as assert } from "node:assert";
      const entry = await import(${JSON.stringify(pathToFileURL(join(packageDir, manifest.exports["."].import)).href)});
      assert.match(entry.PROVIDER_PACKAGE, /^aisdk:file:/);
      assert.ok(entry.PROVIDER_PACKAGE.includes("%20"));
      const shimUrl = entry.PROVIDER_PACKAGE.slice("aisdk:".length);
      assert.equal(fileURLToPath(shimUrl), ${JSON.stringify(join(packageDir, "src", "sdk-shim.mjs"))});
      const shim = await import(shimUrl);
      assert.equal(typeof shim.createAntigravity, "function");
      assert.throws(() => shim.createAntigravity().languageModel("model"), /placeholder SDK/);
    `;
    const verify = Bun.spawnSync(["bun", "-e", script]);
    expect(verify.stderr.toString()).toBe("");
    expect(verify.exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

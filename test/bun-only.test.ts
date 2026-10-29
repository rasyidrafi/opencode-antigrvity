import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

describe("Bun-only project tooling", () => {
  test("keeps Bun pinned and as the only package manager lockfile", async () => {
    const manifest = await Bun.file(new URL("package.json", root)).json();
    const version = manifest.packageManager.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1];

    expect(version).toBe("1.4.4");
    expect(manifest.engines).toEqual({ bun: ">=1.4.4" });

    const lockfiles = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"];
    const present = await Promise.all(lockfiles.map(async (file) =>
      await Bun.file(new URL(file, root)).exists() ? file : undefined));
    expect(present.filter(Boolean)).toEqual(["bun.lock"]);
  });

  test("runs scripts and CI on the pinned Bun runtime", async () => {
    const manifest = await Bun.file(new URL("package.json", root)).json();
    const commands = Object.values(manifest.scripts) as string[];
    for (const command of commands) {
      expect(command).not.toMatch(/(?:^|[\s;&|])(?:node|npm|npx)(?:\s|$)/i);
    }
    expect(manifest.scripts.build).toContain("bun run --bun tsc");

    const workflow = await Bun.file(new URL(".github/workflows/windows.yml", root)).text();
    const ciPins = [...workflow.matchAll(/bun-version:\s*([^\s]+)/g)].map((match) => match[1]);
    expect(ciPins.length).toBeGreaterThan(0);
    expect(ciPins.every((pin) => pin === "1.4.4")).toBe(true);

    const fakeAcp = await Bun.file(new URL("test/fixtures/fake-acp.mjs", root)).text();
    expect(fakeAcp.split("\n", 1)[0]).toBe("#!/usr/bin/env bun");
  });
});

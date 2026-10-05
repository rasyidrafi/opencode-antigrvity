import { expect, test } from "bun:test";
import { WorkspaceRegistry } from "../src/workspace-registry.js";

test("deduplicates concurrent workspace retains and releases once", async () => {
  const retained: string[] = [];
  const released: string[] = [];
  const registry = new WorkspaceRegistry(
    async (directory) => { retained.push(directory); },
    async (directory) => { released.push(directory); },
  );
  const workspace = "/tmp/opencode-antigravity-concurrent-workspace";

  await Promise.all([registry.add(workspace), registry.add(workspace), registry.add(workspace)]);
  expect(retained).toEqual([workspace]);
  await Promise.all([registry.cleanup(), registry.cleanup()]);
  expect(released).toEqual([workspace]);
});

test("cleanup attempts every retained workspace even when a release fails", async () => {
  const released: string[] = [];
  const registry = new WorkspaceRegistry(
    async () => undefined,
    async (directory) => {
      released.push(directory);
      if (directory.endsWith("workspace-a")) throw new Error("simulated proxy stop failure");
    },
  );
  await Promise.all([registry.add("/tmp/workspace-a"), registry.add("/tmp/workspace-b")]);

  await expect(registry.cleanup()).rejects.toBeInstanceOf(AggregateError);
  expect(released.toSorted()).toEqual(["/tmp/workspace-a", "/tmp/workspace-b"]);
  await expect(registry.cleanup()).rejects.toBeInstanceOf(AggregateError);
  expect(released).toHaveLength(2);
});

import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, type CatalogContext } from "../src/model-catalog.js";
import { acpModelCatalog } from "../src/models.js";
import { emitAcpCatalog } from "../src/catalog-events.js";

test("malformed inventory caches are quarantined and never create available models", async () => {
  const directory = await mkdtemp("/tmp/opencode/agy-corrupt-catalog-");
  await writeFile(join(directory, "account.json"), "broken cache");
  const manager = new ModelCatalog(directory, { context: async () => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory }), probe: async () => { throw new Error("offline"); } });
  try {
    await manager.refresh();
    expect(manager.catalog.models).toEqual([]);
    expect(await readdir(join(directory, "quarantine"))).toHaveLength(1);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("discovery is coalesced, caches last success, isolates accounts, and ignores stale worker updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-catalog-"));
  let account = "account-a", calls = 0, offline = false;
  const changes: string[][] = [];
  const retired: string[] = [];
  const context = async (): Promise<CatalogContext> => ({ scope: account, executable: "fake", args: [], cacheDirectory: directory });
  const probe = async () => {
    calls++;
    if (offline) throw new Error("network unavailable");
    return acpModelCatalog("fake", "test", [[account, account]]);
  };
  const options = { context, probe, onChange: (catalog: ReturnType<typeof acpModelCatalog>) => changes.push(catalog.models.map((m) => m.id)), onScopeChange: async (previous: string) => { retired.push(previous); } };
  let manager = new ModelCatalog(directory, options);
  try {
    await Promise.all([manager.refresh(), manager.refresh()]);
    expect(calls).toBe(1);
    expect(manager.catalog.models[0].id).toBe("account-a");
    offline = true;
    await manager.refresh(true);
    expect(manager.catalog.models[0].id).toBe("account-a");
    await manager.close();
    manager = new ModelCatalog(directory, options);
    await manager.refresh();
    expect(manager.catalog.source).toBe("cache");
    expect(calls).toBe(2);
    const stored = JSON.parse(await readFile(join(directory, "account-a.json"), "utf8"));
    expect(stored.entries).toEqual([["account-a", "account-a"]]);

    account = "account-b";
    await manager.refresh();
    expect(retired).toEqual(["account-a"]);
    expect(manager.catalog.source).toBe("empty");
    expect(manager.catalog.models).toEqual([]);
    emitAcpCatalog("account-a", acpModelCatalog("fake", "test", [["stale-account", "Stale"]]));
    expect(manager.catalog.models).toEqual([]);
    offline = false;
    await manager.refresh(true);
    expect(manager.catalog.models[0].id).toBe("account-b");
    emitAcpCatalog("account-b", acpModelCatalog("fake", "test", [["new-id", "New model"]]));
    expect(manager.catalog.models[0].id).toBe("new-id");
    expect(changes.at(-1)).toEqual(["new-id"]);
    emitAcpCatalog("account-b", acpModelCatalog("fake", "test", []));
    expect(manager.catalog.models).toEqual([]);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an account switch during discovery cannot publish the previous account's result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-catalog-switch-"));
  let account = "before";
  let begin!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const release = new Promise<void>((resolve) => { finish = resolve; });
  const manager = new ModelCatalog(directory, {
    context: async () => ({ scope: account, executable: "fake", args: [], cacheDirectory: directory }),
    probe: async () => { begin(); await release; return acpModelCatalog("fake", "test", [["old-account-model", "Old"]]); },
  });
  try {
    const refresh = manager.refresh();
    await started;
    account = "after";
    finish();
    await refresh;
    expect(manager.scope).toBe("after");
    expect(manager.catalog.models).toEqual([]);
  } finally { finish(); await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

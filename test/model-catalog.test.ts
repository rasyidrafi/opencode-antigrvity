import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, type CatalogContext } from "../src/model-catalog.js";
import { acpModelCatalog, resolveAcpModelSelection } from "../src/models.js";
import { emitAcpCatalog } from "../src/catalog-events.js";

test("malformed inventory caches are quarantined and never create available models", async () => {
  const directory = await mkdtemp(`${process.env.TMPDIR || "/tmp/opencode"}/agy-corrupt-catalog-`);
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

test("cached 1.4 catalogs retain their thinking dialect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-catalog-thinking-"));
  const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory });
  const probe = async () => acpModelCatalog("fake", "1.4.5", [["gemini-3.8-flash", "Gemini 3.8 Flash"]], "gemini-3.8-flash", { values: ["low", "medium", "high"], current: "high" });
  let manager = new ModelCatalog(directory, { context, probe });
  try {
    await manager.refresh();
    expect(manager.catalog.thinking).toEqual({ values: ["low", "medium", "high"], current: "high" });
    await manager.close();
    manager = new ModelCatalog(directory, { context, probe: async () => { throw new Error("offline"); } });
    await manager.refresh();
    expect(manager.catalog.source).toBe("cache");
    expect(manager.catalog.thinking).toEqual({ values: ["low", "medium", "high"], current: "high" });
    expect(resolveAcpModelSelection("gemini-3.8-flash", "high", manager.catalog)).toEqual({ requestedModel: "gemini-3.8-flash", acpModel: "gemini-3.8-flash", effort: "high" });
    expect(resolveAcpModelSelection("gemini-3.8-flash-high", undefined, manager.catalog)).toEqual({ requestedModel: "gemini-3.8-flash-high", acpModel: "gemini-3.8-flash", effort: "high" });
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

test("per-model selectors persist versioned, notify changes, and isolate by client identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-catalog-permodel-"));
  const seen: unknown[] = [];
  const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory });
  const probe = async () => acpModelCatalog("fake", "test", [["model-alpha", "Model Alpha"], ["model-beta", "Model Beta"]], "model-beta", undefined, { "model-beta": { id: "beta_effort", values: ["low", "xhigh"], current: "xhigh" } });
  let manager = new ModelCatalog(directory, { context, probe, onChange: (c) => seen.push(c.thinkingSelectors) });
  try {
    await manager.refresh();
    expect(manager.catalog.thinkingSelectors?.["model-beta"]?.values).toEqual(["low", "xhigh"]);
    // Notify on selector change via emitted catalog (worker snapshot merge).
    emitAcpCatalog("account", acpModelCatalog("fake", "test", [["model-alpha", "Model Alpha"], ["model-beta", "Model Beta"]], "model-beta", undefined, { "model-beta": { id: "beta_effort", values: ["low", "high", "xhigh"], current: "high" } }));
    expect(manager.catalog.thinkingSelectors?.["model-beta"]?.values).toEqual(["low", "high", "xhigh"]);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)).toMatchObject({ "model-beta": { values: ["low", "high", "xhigh"] } });
    await manager.close();
    // Versioned cache (schema 2) round-trips per-model selectors.
    const stored = JSON.parse(await readFile(join(directory, "account.json"), "utf8"));
    expect(stored.schema).toBe(2);
    expect(stored.thinkingSelectors["model-beta"].values).toEqual(["low", "high", "xhigh"]);
    manager = new ModelCatalog(directory, { context, probe: async () => { throw new Error("offline"); } });
    await manager.refresh();
    expect(manager.catalog.source).toBe("cache");
    expect(manager.catalog.thinkingSelectors?.["model-beta"]?.values).toEqual(["low", "high", "xhigh"]);
    // Identity isolation: a cache record naming a different identity is ignored.
    await writeFile(join(directory, "zed-account.json"), JSON.stringify({ schema: 2, discoveredAt: Date.now(), version: "test", currentModel: "model-beta", clientIdentity: "zed", thinkingSelectors: { "model-beta": { id: "beta_effort", values: ["xhigh"] } }, entries: [["model-beta", "Model Beta"]] }), { mode: 0o600 });
    const zedContext = async (): Promise<CatalogContext> => ({ scope: "zed-account", executable: "fake", args: [], cacheDirectory: directory, clientIdentity: { name: "zed", version: "0.8.0" } });
    const zedManager = new ModelCatalog(directory, { context: zedContext, probe: async () => { throw new Error("offline"); } });
    try {
      await zedManager.refresh();
      expect(zedManager.catalog.thinkingSelectors?.["model-beta"]?.values).toEqual(["xhigh"]);
    } finally { await zedManager.close(); }
    // Default identity must not read the zed cache (scope differs, and the
    // identity check rejects cross-identity records).
    const defaultContext = async (): Promise<CatalogContext> => ({ scope: "zed-account", executable: "fake", args: [], cacheDirectory: directory });
    const defaultManager = new ModelCatalog(directory, { context: defaultContext, probe: async () => { throw new Error("offline"); } });
    try {
      await defaultManager.refresh();
      expect(defaultManager.catalog.models).toEqual([]);
    } finally { await defaultManager.close(); }
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy schema-1 caches remain readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-catalog-legacy-"));
  await writeFile(join(directory, "account.json"), JSON.stringify({ schema: 1, discoveredAt: Date.now(), version: "1.4.5", currentModel: "gemini-3.8-flash", thinking: { values: ["low", "medium", "high"], current: "high" }, entries: [["gemini-3.8-flash", "Gemini 3.8 Flash"]] }), { mode: 0o600 });
  const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory });
  const manager = new ModelCatalog(directory, { context, probe: async () => { throw new Error("offline"); } });
  try {
    await manager.refresh();
    expect(manager.catalog.source).toBe("cache");
    expect(manager.catalog.thinking).toEqual({ values: ["low", "medium", "high"], current: "high" });
    expect(resolveAcpModelSelection("gemini-3.8-flash", "high", manager.catalog).effort).toBe("high");
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

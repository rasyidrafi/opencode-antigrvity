import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog, discoveryTimeoutMs, type CatalogContext } from "../src/model-catalog.js";
import { acpModelCatalog, catalogFromSession, mergeCatalog, resolveAcpModelSelection, thinkingForModel, type AcpModelCatalog } from "../src/models.js";
import { buildProviderModels } from "../src/index.js";
// (buildProviderModels imported once at top)
import { emitAcpCatalog } from "../src/catalog-events.js";

const entries: Array<[string, string]> = [["model-alpha", "Model Alpha"], ["model-beta", "Model Beta"]];

function obsCatalog(currentModel: string, selectorValues?: string[]): AcpModelCatalog {
  return catalogFromSession({
    configOptions: [
      { id: "model", category: "model", currentValue: currentModel, options: entries.map(([value, name]) => ({ value, name })) },
      ...(selectorValues ? [{ id: "thought_level", category: "thought_level", currentValue: selectorValues[0], options: selectorValues.map((value) => ({ value })) }] : []),
    ],
  }, "fake")!;
}

function managerFor(directory: string, extra: Record<string, unknown> = {}) {
  const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory });
  return new ModelCatalog(directory, { context, probe: async () => { throw new Error("offline"); }, ...extra });
}

test("cross-worker events merge per-model observations and republish provider variants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-cross-"));
  let changes = 0;
  const manager = managerFor(directory, { onChange: () => { changes += 1; } });
  try {
    await manager.refresh(); // cache empty, probe offline -> empty
    emitAcpCatalog("account", obsCatalog("model-alpha", ["low", "high"]));
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
    const afterAlpha = changes;
    // Second worker observes a different model; alpha must be retained.
    emitAcpCatalog("account", obsCatalog("model-beta", ["low", "xhigh"]));
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
    expect(manager.catalog.thinkingSelectors?.["model-beta"]?.values).toEqual(["low", "xhigh"]);
    expect(thinkingForModel(manager.catalog, "model-alpha")).toEqual(["low", "high"]);
    expect(thinkingForModel(manager.catalog, "model-beta")).toEqual(["low", "xhigh"]);
    expect(changes).toBeGreaterThan(afterAlpha); // republished
    const beta = buildProviderModels(manager.catalog).find((m) => m.id === "model-beta")!;
    const alpha = buildProviderModels(manager.catalog).find((m) => m.id === "model-alpha")!;
    expect(beta.variants.map((v: any) => v.id)).toEqual(expect.arrayContaining(["low", "xhigh"]));
    expect(alpha.variants.map((v: any) => v.id)).toEqual(["low", "high"]);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("selector removal via full snapshot clears and republishes; partial does not clear", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-remove-"));
  let changes = 0;
  const manager = managerFor(directory, { onChange: () => { changes += 1; } });
  try {
    await manager.refresh();
    emitAcpCatalog("account", obsCatalog("model-beta", ["xhigh"]));
    expect(manager.catalog.thinkingSelectors?.["model-beta"]?.values).toEqual(["xhigh"]);
    const before = changes;
    // Full authoritative snapshot: model selector present, current=beta,
    // no thinking selector -> beta's selector cleared, variants dropped.
    emitAcpCatalog("account", obsCatalog("model-beta"));
    expect(manager.catalog.thinkingSelectors?.["model-beta"]).toBeUndefined();
    expect(thinkingForModel(manager.catalog, "model-beta")).toBeUndefined();
    expect(buildProviderModels(manager.catalog).find((m) => m.id === "model-beta")!.variants).toEqual([]);
    expect(changes).toBeGreaterThan(before); // republished removal

    // Unknown/partial: hand-built observation with no authoritative
    // inventory must not clear the alpha selector added afterwards.
    emitAcpCatalog("account", obsCatalog("model-alpha", ["low"]));
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low"]);
    const partial = { ...acpModelCatalog("fake", "test", entries, "model-beta"), observation: { authoritativeInventory: false, confirmedModel: "model-beta", confirmedNoSelector: false } };
    emitAcpCatalog("account", partial);
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low"]);
    expect(manager.catalog.models.map((m) => m.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta"]));
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("authoritative inventory prunes removed models only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-prune-"));
  const manager = managerFor(directory);
  try {
    await manager.refresh();
    emitAcpCatalog("account", obsCatalog("model-beta", ["xhigh"]));
    expect(manager.catalog.thinkingSelectors?.["model-beta"]).toBeDefined();
    // Beta disappears from the advertised inventory.
    emitAcpCatalog("account", catalogFromSession({
      configOptions: [{ id: "model", category: "model", currentValue: "model-alpha", options: [{ value: "model-alpha", name: "Model Alpha" }] }],
    }, "fake")!);
    expect(manager.catalog.models.map((m) => m.id)).toEqual(["model-alpha"]);
    expect(manager.catalog.thinkingSelectors?.["model-beta"]).toBeUndefined();
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent probe preserves worker observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-probe-"));
  let emitDuringProbe = true;
  const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory });
  const probe = async () => {
    if (emitDuringProbe) { emitDuringProbe = false; emitAcpCatalog("account", obsCatalog("model-alpha", ["low"])); }
    return obsCatalog("model-beta", ["high"]);
  };
  const manager = new ModelCatalog(directory, { context, probe });
  try {
    await manager.refresh(true);
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low"]);
    expect(manager.catalog.thinkingSelectors?.["model-beta"]?.values).toEqual(["high"]);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stale replay cannot overwrite newer live updates for the same model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-stale-"));
  const manager = managerFor(directory);
  try {
    await manager.refresh();
    const fresh = obsCatalog("model-alpha", ["low", "high"]);
    fresh.thinkingObservedAt = { "model-alpha": 200 };
    fresh.modelEnteredAt = { "model-alpha": 100, "model-beta": 100 };
    fresh.discoveredAt = 200; fresh.inventoryAt = 200;
    emitAcpCatalog("account", fresh);
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
    // Stale replay: older timestamp, different values.
    const stale = obsCatalog("model-alpha", ["medium"]);
    stale.thinkingObservedAt = { "model-alpha": 100 };
    stale.modelEnteredAt = { "model-alpha": 100, "model-beta": 100 };
    stale.discoveredAt = 100; stale.inventoryAt = 100;
    emitAcpCatalog("account", stale);
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
    // Stale explicit clear also loses to the newer selector.
    const staleClear = obsCatalog("model-alpha");
    staleClear.thinkingObservedAt = { "model-alpha": 100 };
    staleClear.modelEnteredAt = { "model-alpha": 100, "model-beta": 100 };
    staleClear.discoveredAt = 100; staleClear.inventoryAt = 100;
    emitAcpCatalog("account", staleClear);
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
    // Fresh clear (newer) wins.
    const freshClear = obsCatalog("model-alpha");
    freshClear.thinkingObservedAt = { "model-alpha": 300 };
    freshClear.modelEnteredAt = { "model-alpha": 100, "model-beta": 100 };
    freshClear.discoveredAt = 300; freshClear.inventoryAt = 300;
    emitAcpCatalog("account", freshClear);
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]).toBeUndefined();
    expect(manager.catalog.thinkingConfirmedNone).toContain("model-alpha");
    // Resurrection with a newer selector wins over the older clear.
    const resurrect = obsCatalog("model-alpha", ["low"]);
    resurrect.thinkingObservedAt = { "model-alpha": 400 };
    resurrect.modelEnteredAt = { "model-alpha": 100, "model-beta": 100 };
    resurrect.discoveredAt = 400; resurrect.inventoryAt = 400;
    emitAcpCatalog("account", resurrect);
    expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low"]);
    expect(manager.catalog.thinkingConfirmedNone ?? []).not.toContain("model-alpha");
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("inventory ordering is independent of thinking freshness", () => {
  const full = acpModelCatalog("fake", "test", [["model-alpha", "Model Alpha"], ["model-beta", "Model Beta"], ["model-gamma", "Model Gamma"]], "model-alpha");
  full.discoveredAt = 500; full.inventoryAt = 500;
  const staleInventory = acpModelCatalog("fake", "test", [["model-alpha", "Model Alpha"]], "model-alpha");
  staleInventory.discoveredAt = 100; staleInventory.inventoryAt = 100;
  // Stale inventory must not prune newer models.
  const mergedStale = mergeCatalog(full, staleInventory);
  expect(mergedStale.models.map((m) => m.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta", "model-gamma"]));
  const freshInventory = acpModelCatalog("fake", "test", [["model-alpha", "Model Alpha"]], "model-alpha");
  freshInventory.discoveredAt = 600; freshInventory.inventoryAt = 600;
  const mergedFresh = mergeCatalog(full, freshInventory);
  expect(mergedFresh.models.map((m) => m.id)).toEqual(["model-alpha"]);
});

test("partial observation for a model absent from authoritative inventory is ignored", () => {
  const base = obsCatalog("model-alpha", ["low"]);
  const partial = { ...acpModelCatalog("fake", "test", [], "model-absent", undefined, { "model-absent": { id: "absent_effort", values: ["xhigh"] } }),
    observation: { authoritativeInventory: false, confirmedModel: "model-absent", confirmedNoSelector: false } };
  const merged = mergeCatalog(base, partial);
  expect(merged.thinkingSelectors?.["model-absent"]).toBeUndefined();
  expect(merged.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low"]);
  expect(merged.models.map((m) => m.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta"]));
});

test("mergeCatalog distinguishes unknown from explicit removal", () => {
  const withAlpha = obsCatalog("model-alpha", ["low", "high"]);
  const unknown = { ...acpModelCatalog("fake", "test", entries, "model-alpha"), observation: { authoritativeInventory: false, confirmedModel: "model-alpha", confirmedNoSelector: false } };
  const mergedUnknown = mergeCatalog(withAlpha, unknown);
  expect(mergedUnknown.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
  const removed = obsCatalog("model-alpha");
  const mergedRemoved = mergeCatalog(withAlpha, removed);
  expect(mergedRemoved.thinkingSelectors?.["model-alpha"]).toBeUndefined();
  expect(mergedRemoved.models.find((m) => m.id === "model-alpha")?.variantEfforts).toBeUndefined();
});

test("schema-1 thinking is preserved for resolution but never promoted into variants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-schema1-"));
  await writeFile(join(directory, "account.json"), JSON.stringify({ schema: 1, discoveredAt: Date.now(), version: "1.4.5", currentModel: "gemini-3.8-flash", thinking: { values: ["low", "high"], current: "high" }, entries: [["gemini-3.8-flash", "Gemini 3.8 Flash"]] }), { mode: 0o600 });
  const manager = managerFor(directory);
  try {
    await manager.refresh();
    expect(manager.catalog.source).toBe("cache");
    expect(manager.catalog.thinking).toEqual({ values: ["low", "high"], current: "high" });
    expect(manager.catalog.thinkingSelectors).toBeUndefined();
    expect(manager.catalog.thinkingSource).toBe("legacy");
    // Resolution arches through the legacy current-model fallback...
    expect(resolveAcpModelSelection("gemini-3.8-flash", "high", manager.catalog).effort).toBe("high");
    // ...but published variants stay empty (never promoted).
    expect(buildProviderModels(manager.catalog)[0].variants).toEqual([]);
    expect(manager.catalog.models[0].variantEfforts).toBeUndefined();
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy -xhigh ids are never inferred; family default stays high", () => {
  const c = acpModelCatalog("fake", "1.3.0", [
    ["fam-high", "Fam (High)"], ["fam-medium", "Fam (Medium)"], ["fam-low", "Fam (Low)"],
    ["fam2-high", "Fam2 (High)"], ["fam2-xhigh", "Fam2 (XHigh)"], ["fam2-medium", "Fam2 (Medium)"],
  ]);
  const fam = c.models.find((m) => m.id === "fam")!;
  const fam2 = c.models.find((m) => m.id === "fam2")!;
  expect(fam.acpModel).toBe("fam-high");
  expect(fam2.acpModel).toBe("fam2-high"); // high default preserved over xhigh
  // Unadvertised -xhigh id: unknown, not inferred.
  expect(() => resolveAcpModelSelection("fam-xhigh", undefined, c)).toThrow(/Unknown/);
  expect(() => resolveAcpModelSelection("fam", "xhigh", c)).toThrow(/Unsupported effort/);
  // Advertised -xhigh sibling routes normally.
  expect(resolveAcpModelSelection("fam2-xhigh", undefined, c).acpModel).toBe("fam2-xhigh");
  expect(resolveAcpModelSelection("fam2", "xhigh", c).acpModel).toBe("fam2-xhigh");
});

test("discovery timeout values and abort settle a hanging probe", async () => {
  expect(discoveryTimeoutMs("win32")).toBe(120_000);
  expect(discoveryTimeoutMs("linux")).toBe(45_000);
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-timeout-"));
  const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory });
  // Probe that only settles when the discovery signal aborts (timeout here).
  const hangingProbe = (_ctx: CatalogContext, _dir: string, signal: AbortSignal) => new Promise<AcpModelCatalog>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const manager = new ModelCatalog(directory, { context, probe: hangingProbe as never, timeoutMs: 50 });
  try {
    const started = Date.now();
    await manager.refresh(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(manager.lastError).toBeDefined();
    expect(manager.catalog.models).toEqual([]);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

test("close aborts an in-flight probe and refresh settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-close-"));
  const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory });
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => { release = resolve; });
  const hangingProbe = (_ctx: CatalogContext, _dir: string, signal: AbortSignal) => new Promise<AcpModelCatalog>((resolve) => {
    signal.addEventListener("abort", () => resolve(obsCatalog("model-alpha", ["low"])), { once: true });
    release();
  });
  const manager = new ModelCatalog(directory, { context, probe: hangingProbe as never });
  try {
    const pending = manager.refresh(true);
    await started;
    await manager.close();
    await pending; // settles without hanging for the full discovery timeout
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real production probe interleaving: newer live event wins over probe for same model", async () => {
  const { chmod } = await import("node:fs/promises");
  const { fixtureCompatibility } = await import("./fixtures/compatibility.js");
  const compatibility = fixtureCompatibility();
  const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-realprobe-"));
  const savedEnv = { ...process.env };
  process.env.FAKE_ACP_PER_MODEL = "1";
  try {
    const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: fixture, args: [], cacheDirectory: directory });
    // Real production probe (no injected probe fn): per-model workers run
    // against the fake ACP and observe alpha [low,high] / beta [xhigh...].
    const manager = new ModelCatalog(directory, { context });
    try {
      const pending = manager.refresh(true);
      // Wait until the probe has started (scope set), then emit a newer live
      // update for beta while discovery is still running.
      for (let i = 0; i < 200 && manager.scope !== "account"; i++) await new Promise((r) => setTimeout(r, 10));
      const live = obsCatalog("model-beta", ["low"]);
      live.thinkingObservedAt = { "model-beta": Date.now() + 60_000 };
      live.discoveredAt = Date.now() + 60_000;
      emitAcpCatalog("account", live);
      await pending;
      // Probe's older beta observation must not overwrite the newer live one.
      expect(manager.catalog.thinkingSelectors?.["model-beta"]?.values).toEqual(["low"]);
      // Alpha came from the probe and is present.
      expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
    } finally { await manager.close(); }
  } finally {
    compatibility.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  }
});

test("thought-only events and rejected stale inventories do not advance inventory time", () => {
  const base = acpModelCatalog("fake", "test", entries, "model-alpha", undefined, { "model-alpha": { id: "alpha_effort", values: ["low"] } });
  (base as any).discoveredAt = 100;
  // acpModelCatalog stamps inventoryAt=now; normalize all fixture times coherently.
  base.inventoryAt = 100;
  base.modelEnteredAt = { "model-alpha": 100, "model-beta": 100 };
  base.thinkingObservedAt = { "model-alpha": 100 };
  // Thought-only delta carries no inventory.
  const thoughtOnly = { ...acpModelCatalog("fake", "test", [], "model-alpha", undefined, { "model-alpha": { id: "alpha_effort", values: ["high"] } }),
    observation: { authoritativeInventory: false, confirmedModel: "model-alpha", confirmedNoSelector: false } };
  (thoughtOnly as any).discoveredAt = 999;
  delete (thoughtOnly as any).inventoryAt;
  delete (thoughtOnly as any).modelEnteredAt;
  thoughtOnly.thinkingObservedAt = { "model-alpha": 999 };
  const merged = mergeCatalog(base, thoughtOnly);
  expect(merged.models.map((m) => m.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta"]));
  expect(merged.discoveredAt).toBe(100);
  expect(merged.inventoryAt).toBe(100);
  expect(merged.thinkingSelectors?.["model-alpha"]?.values).toEqual(["high"]);
  // A genuinely newer inventory (150, between 100 and 999) now prunes beta:
  // proves the thought-only timestamp did not block it.
  const newer = acpModelCatalog("fake", "test", [["model-alpha", "Model Alpha"]], "model-alpha");
  (newer as any).discoveredAt = 150; newer.inventoryAt = 150; newer.thinkingObservedAt = {};
  const pruned = mergeCatalog(merged, newer);
  expect(pruned.models.map((m) => m.id)).toEqual(["model-alpha"]);
  expect(pruned.inventoryAt).toBe(150);

  // Rejected stale inventory: retained models, no time advance, but a fresh
  // thinking observation in the same stale catalog still applies.
  const stale = acpModelCatalog("fake", "test", [["model-alpha", "Model Alpha"]], "model-alpha", undefined, { "model-alpha": { id: "alpha_effort", values: ["low"] } });
  (stale as any).discoveredAt = 50; stale.inventoryAt = 50;
  stale.thinkingObservedAt = { "model-alpha": 1000 };
  const rejected = mergeCatalog(pruned, stale);
  expect(rejected.models.map((m) => m.id)).toEqual(["model-alpha"]);
  expect(rejected.inventoryAt).toBe(150);
  expect(rejected.discoveredAt).toBe(150);
  expect(rejected.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low"]);
});

test("winning inventory exclusively owns sibling metadata", () => {
  const grouped = acpModelCatalog("fake", "1.3.0", [["fam-high", "Fam (High)"], ["fam-low", "Fam (Low)"]]);
  (grouped as any).discoveredAt = 100; grouped.inventoryAt = 100;
  expect(grouped.models.find((m) => m.id === "fam")?.variantEfforts).toEqual(["high", "low"]);
  const winner = acpModelCatalog("fake", "test", [["other", "Other"]], "other");
  (winner as any).discoveredAt = 200; winner.inventoryAt = 200;
  const merged = mergeCatalog(grouped, winner);
  expect(merged.models.map((m) => m.id)).toEqual(["other"]);
  expect(merged.models[0].variantEfforts).toBeUndefined();
  // Stale grouped inventory cannot resurrect fam sibling metadata.
  const staleGrouped = acpModelCatalog("fake", "1.3.0", [["fam-high", "Fam (High)"], ["fam-low", "Fam (Low)"]]);
  (staleGrouped as any).discoveredAt = 150; staleGrouped.inventoryAt = 150;
  const rejected = mergeCatalog(merged, staleGrouped);
  expect(rejected.models.map((m) => m.id)).toEqual(["other"]);
});

test("real production probe negative interleaving: older confirmed-none cannot clear newer live selector", async () => {
  const { chmod } = await import("node:fs/promises");
  const { fixtureCompatibility } = await import("./fixtures/compatibility.js");
  const compatibility = fixtureCompatibility();
  const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-probenone-"));
  const savedEnv = { ...process.env };
  process.env.FAKE_ACP_PER_MODEL = "1";
  try {
    const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: fixture, args: [], cacheDirectory: directory });
    const manager = new ModelCatalog(directory, { context });
    try {
      const pending = manager.refresh(true);
      for (let i = 0; i < 200 && manager.scope !== "account"; i++) await new Promise((r) => setTimeout(r, 10));
      // Gamma confirmed-none comes from the probe (older). A newer live
      // selector for gamma emitted during discovery must survive it.
      const live = obsCatalog("model-gamma", ["low"]);
      live.thinkingObservedAt = { "model-gamma": Date.now() + 60_000 };
      live.discoveredAt = Date.now() + 60_000;
      emitAcpCatalog("account", live);
      await pending;
      expect(manager.catalog.thinkingSelectors?.["model-gamma"]?.values).toEqual(["low"]);
      expect(manager.catalog.thinkingConfirmedNone ?? []).not.toContain("model-gamma");
      // Positive peer is still covered by the probe.
      expect(manager.catalog.thinkingSelectors?.["model-beta"]?.values).toContain("xhigh");
    } finally { await manager.close(); }
  } finally {
    compatibility.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  }
});

test("real production probe interleaving: newer authoritative empty wins, probe inventory time preserved", async () => {
  const { chmod } = await import("node:fs/promises");
  const { fixtureCompatibility } = await import("./fixtures/compatibility.js");
  const compatibility = fixtureCompatibility();
  const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-probe-empty-"));
  const savedEnv = { ...process.env };
  process.env.FAKE_ACP_PER_MODEL = "1";
  try {
    const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: fixture, args: [], cacheDirectory: directory });
    const manager = new ModelCatalog(directory, { context });
    try {
      const pending = manager.refresh(true);
      for (let i = 0; i < 200 && manager.scope !== "account"; i++) await new Promise((r) => setTimeout(r, 10));
      // Let the base discovery worker establish its inventory first, then
      // emit a newer authoritative EMPTY inventory during per-model probing.
      await new Promise((r) => setTimeout(r, 250));
      const liveEmpty = catalogFromSession({ configOptions: [{ id: "model", category: "model", currentValue: "model-alpha", options: [] }] }, "fake")!;
      expect(liveEmpty.models).toEqual([]);
      const liveInventoryAt = liveEmpty.inventoryAt ?? liveEmpty.discoveredAt;
      emitAcpCatalog("account", liveEmpty);
      await pending;
      // The probe result (base inventory, aggregation-stamped thinking only)
      // must not resurrect models: both lists stay empty.
      expect(manager.catalog.models).toEqual([]);
      expect(manager.catalog.exactModels).toEqual([]);
      expect(manager.catalog.inventoryAt).toBe(liveInventoryAt);
    } finally { await manager.close(); }
  } finally {
    compatibility.mockRestore();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale losing inventory cannot retain selector for absent model or restore it on re-add", () => {
  // t=100: full inventory [A,B], B has xhigh.
  const full = acpModelCatalog("fake", "test", entries, "model-beta", undefined, { "model-beta": { id: "beta_effort", values: ["xhigh"] } });
  full.discoveredAt = 100; full.inventoryAt = 100; full.thinkingObservedAt = { "model-beta": 100 };
  expect(mergeCatalog(undefined, full).thinkingSelectors?.["model-beta"]?.values).toEqual(["xhigh"]);
  // t=200: newer authoritative inventory without B.
  const withoutB = acpModelCatalog("fake", "test", [["model-alpha", "Model Alpha"]], "model-alpha");
  withoutB.discoveredAt = 200; withoutB.inventoryAt = 200;
  const winner = mergeCatalog(full, withoutB);
  expect(winner.models.map((m) => m.id)).toEqual(["model-alpha"]);
  expect(winner.thinkingSelectors?.["model-beta"]).toBeUndefined();
  expect(winner.thinkingObservedAt?.["model-beta"]).toBeUndefined();
  // t=150 delayed stale inventory re-adding B with xhigh must lose entirely.
  const stale = acpModelCatalog("fake", "test", entries, "model-beta", undefined, { "model-beta": { id: "beta_effort", values: ["xhigh"] } });
  stale.discoveredAt = 150; stale.inventoryAt = 150; stale.thinkingObservedAt = { "model-beta": 150 };
  const afterStale = mergeCatalog(winner, stale);
  expect(afterStale.models.map((m) => m.id)).toEqual(["model-alpha"]);
  expect(afterStale.thinkingSelectors?.["model-beta"]).toBeUndefined();
  expect(thinkingForModel(afterStale, "model-beta")).toBeUndefined();
  // t=300: B re-added WITHOUT a selector: xhigh must not be exposed.
  const readded = acpModelCatalog("fake", "test", entries, "model-alpha");
  readded.discoveredAt = 300; readded.inventoryAt = 300;
  readded.modelEnteredAt = { "model-alpha": 200, "model-beta": 300 }; // B (re)entered at this inventory
  const final = mergeCatalog(afterStale, readded);
  expect(final.models.map((m) => m.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta"]));
  expect(final.thinkingSelectors?.["model-beta"]).toBeUndefined();
  expect(final.models.find((m) => m.id === "model-beta")?.variantEfforts ?? []).not.toContain("xhigh");
  expect(thinkingForModel(final, "model-beta")).toBeUndefined();
  // Not exposed anywhere: no selector, no published variant. Resolution
  // defers to wire validation for unconfirmed models (worker fails closed
  // pre-prompt); it never synthesizes xhigh availability.
  expect(buildProviderModels(final).find((m) => m.id === "model-beta")?.variants.map((v: any) => v.id) ?? []).not.toContain("xhigh");
  // A fresh B selector observation after re-add still works (resurrection).
  const resurrect = acpModelCatalog("fake", "test", entries, "model-beta", undefined, { "model-beta": { id: "beta_effort", values: ["xhigh"] } });
  resurrect.discoveredAt = 400; resurrect.inventoryAt = 400; resurrect.thinkingObservedAt = { "model-beta": 400 };
  resurrect.modelEnteredAt = { "model-alpha": 200, "model-beta": 300 };
  const revived = mergeCatalog(final, resurrect);
  expect(thinkingForModel(revived, "model-beta")).toContain("xhigh");
});

test("availability epoch rejects delayed pre-removal observations after re-add, preserves unchanged models", () => {
  const mk = (time: number, betaSelector?: string[]) => {
    const c = acpModelCatalog("fake", "test", entries, "model-beta", undefined,
      betaSelector ? { "model-beta": { id: "beta_effort", values: betaSelector } } : undefined);
    c.discoveredAt = time; c.inventoryAt = time;
    c.modelEnteredAt = Object.fromEntries(c.exactModels.map((m) => [m.id, time]));
    if (betaSelector) c.thinkingObservedAt = { "model-beta": time };
    return c;
  };
  // T2 original B selector.
  let catalog = mk(200, ["xhigh"]);
  // T3 empty inventory: B removed.
  const emptying = acpModelCatalog("fake", "test", [], "model-alpha");
  emptying.discoveredAt = 300; emptying.inventoryAt = 300;
  catalog = mergeCatalog(catalog, emptying);
  expect(catalog.models).toEqual([]);
  expect(catalog.thinkingSelectors?.["model-beta"]).toBeUndefined();
  // T4 B re-added without selector.
  catalog = mergeCatalog(catalog, mk(400));
  expect(catalog.models.map((m) => m.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta"]));
  expect(catalog.modelEnteredAt?.["model-beta"]).toBe(400);
  expect(catalog.modelEnteredAt?.["model-alpha"]).toBe(400); // removed at T3 too, re-entered at T4
  // Delayed T2 selector (200) arriving after re-add: rejected.
  const delayed = mk(200, ["xhigh"]);
  const afterDelayed = mergeCatalog(catalog, delayed);
  expect(afterDelayed.thinkingSelectors?.["model-beta"]).toBeUndefined();
  expect(thinkingForModel(afterDelayed, "model-beta")).toBeUndefined();
  expect(afterDelayed.models.find((m) => m.id === "model-beta")?.variantEfforts ?? []).not.toContain("xhigh");
  // Delayed T2 clear also rejected (no false clearing of fresh state).
  const delayedClear = mk(200);
  delayedClear.observation = { authoritativeInventory: true, confirmedModel: "model-beta", confirmedNoSelector: true, confirmedNoneModels: ["model-beta"] };
  delayedClear.thinkingObservedAt = { "model-beta": 200 };
  const afterClear = mergeCatalog(afterDelayed, delayedClear);
  expect(afterClear.thinkingConfirmedNone ?? []).not.toContain("model-beta");
  // Genuinely fresh B observation (450) accepted after re-add.
  const fresh = mk(450, ["xhigh"]);
  const revived = mergeCatalog(afterClear, fresh);
  expect(thinkingForModel(revived, "model-beta")).toContain("xhigh");
  // Unchanged model A observations still flow after B churn.
  const alphaLate = acpModelCatalog("fake", "test", entries, "model-alpha", undefined, { "model-alpha": { id: "alpha_effort", values: ["low"] } });
  alphaLate.discoveredAt = 460; alphaLate.inventoryAt = 400;
  alphaLate.modelEnteredAt = { "model-alpha": 300, "model-beta": 400 };
  alphaLate.thinkingObservedAt = { "model-alpha": 460 };
  const withAlpha = mergeCatalog(revived, alphaLate);
  expect(thinkingForModel(withAlpha, "model-alpha")).toEqual(["low"]);
  expect(thinkingForModel(withAlpha, "model-beta")).toContain("xhigh");
});

test("availability epoch survives schema-2 cache roundtrip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-merge-epoch-cache-"));
  const context = async (): Promise<CatalogContext> => ({ scope: "account", executable: "fake", args: [], cacheDirectory: directory });
  let manager = new ModelCatalog(directory, { context, probe: async () => {
    const c = acpModelCatalog("fake", "test", entries, "model-beta", undefined, { "model-beta": { id: "beta_effort", values: ["xhigh"] } });
    c.discoveredAt = 400; c.inventoryAt = 400;
    c.modelEnteredAt = { "model-alpha": 100, "model-beta": 400 };
    c.thinkingObservedAt = { "model-beta": 450 };
    return c;
  } });
  try {
    await manager.refresh(true);
    expect(manager.catalog.modelEnteredAt?.["model-beta"]).toBeGreaterThanOrEqual(400);
    await manager.close();
    // Delayed pre-re-add selector emitted against the reloaded catalog.
    manager = new ModelCatalog(directory, { context, probe: async () => { throw new Error("offline"); } });
    await manager.refresh();
    expect(manager.catalog.source).toBe("cache");
    expect(manager.catalog.modelEnteredAt?.["model-beta"]).toBeGreaterThanOrEqual(400);
    const delayed = acpModelCatalog("fake", "test", entries, "model-beta", undefined, { "model-beta": { id: "beta_effort", values: ["xhigh"] } });
    delayed.discoveredAt = 250; delayed.inventoryAt = 250; delayed.thinkingObservedAt = { "model-beta": 250 };
    const { mergeCatalog: mc } = await import("../src/models.js");
    const merged = mc(manager.catalog, delayed);
    // Freshness vs entered 400: delayed 250 must not replace the 450 observation.
    expect(merged.thinkingSelectors?.["model-beta"]?.values).toEqual(["xhigh"]);
    expect(merged.thinkingObservedAt?.["model-beta"]).toBeGreaterThanOrEqual(450);
  } finally { await manager.close(); await rm(directory, { recursive: true, force: true }); }
});

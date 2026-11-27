import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createAcpWorker } from "./acp-process.js";
import { agyProfileScope, assertAgyCliCompatibility, detectAgyAcp, isRegistryRuntime } from "./agy-cli.js";
import { onAcpCatalog } from "./catalog-events.js";
import { acpModelCatalog, fallbackAcpModelCatalog, mergeCatalog, type AcpModelCatalog, type AcpThinkingSelector } from "./models.js";
import { type AcpClientIdentity } from "./constants.js";
import { warn } from "./log.js";

export type CatalogContext = { scope: string; executable: string; args: string[]; cacheDirectory: string; credentialRevision?: string | null; clientIdentity?: AcpClientIdentity };

/** Windows cold discovery can exceed one minute; keep every probe bounded. */
export function discoveryTimeoutMs(platform = process.platform): number {
  return platform === "win32" ? 120_000 : 45_000;
}

async function jsonFile(path: string): Promise<Record<string, any>> {
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }
  catch (error) {
    if (error instanceof SyntaxError && raw !== undefined) {
      const directory = join(dirname(path), "quarantine");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, `${createHash("sha256").update(path + raw).digest("hex")}.json`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ reason: "invalid_catalog_cache", raw }), { mode: 0o600, flag: "wx" }); await rename(temporary, target); }
      finally { await rm(temporary, { force: true }); }
      warn("Corrupt model catalog cache quarantined; probing account inventory", { reason: "catalog_cache_corrupt" });
    }
    return {};
  }
}

/** Cache filenames contain only a digest. Never persist or log source credentials.
 * `clientIdentity` is the exact pinned identity resolved by the shared
 * runtime (`startRuntime` resolves env/option once). When provided it is
 * hashed verbatim; this function never rereads `OPENCODE_ANTIGRAVITY_CLIENT_NAME`
 * itself, so later environment changes cannot move the scope. Callers that
 * want env resolution must resolve it first and pass the result in. */
export async function catalogContext(executable?: string, clientIdentity?: AcpClientIdentity): Promise<CatalogContext> {
  const detection = executable
    ? { executable, args: isRegistryRuntime(executable) ? ["--uid="] : ["acp"] }
    : await detectAgyAcp(assertAgyCliCompatibility);
  if (executable) await assertAgyCliCompatibility(executable);
  const binary = await stat(detection.executable);
  const profile = await agyProfileScope(process.env, isRegistryRuntime(detection.executable));
  const scope = createHash("sha256").update(JSON.stringify({
    client: "opencode-antigravity-agy-cli", protocol: 1, profile,
    executable: detection.executable, args: detection.args, size: binary.size, modified: binary.mtimeMs,
    clientIdentity: clientIdentity ?? null,
  })).digest("hex");
  const data = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
    join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-antigravity");
  return { scope, executable: detection.executable, args: detection.args, cacheDirectory: join(data, "model-catalogs"), credentialRevision: profile.revision, ...(clientIdentity ? { clientIdentity } : {}) };
}

async function probe(context: CatalogContext, directory: string, signal: AbortSignal): Promise<AcpModelCatalog> {
  const worker = await createAcpWorker({
    cwd: directory, executable: context.executable,
    credentialRevision: context.credentialRevision,
    hostTools: true, catalogScope: undefined,
    ...(context.clientIdentity ? { clientIdentity: context.clientIdentity } : {}),
    // Discovery does not select a model and never sends an inference prompt.
  }, signal);
  try {
    if (!worker.catalog) throw new Error("ACP did not return model choices in session/new");
    let catalog = worker.catalog;
    // First-load per-model coverage: probe each advertised model with a
    // prompt-free disposable worker (session/new + set_model only, no
    // prompt). Observations are bounded (whole discovery already has a
    // timeout signal) and merged; missing coverage is simply absent —
    // availability is never invented.
    if (!signal.aborted) {
      // Collect one prompt-free observation per model lacking coverage.
      // Each probe gets the same bounded signal; abort stops the loop and
      // the observations collected so far are still merged (coverage is
      // best-effort, never invented).
      const collected: Record<string, AcpThinkingSelector> = { ...(catalog.thinkingSelectors ?? {}) };
      const observedAtByModel: Record<string, number> = { ...(catalog.thinkingObservedAt ?? {}) };
      // Confirmed no-selector (probe selected the model and the full
      // snapshot showed no selector) is recorded distinctly from a failed
      // probe (unknown: retain any previous state, never clear).
      const confirmedNone = new Set(catalog.thinkingConfirmedNone ?? []);
      const noneObservedAt: Record<string, number> = {};
      for (const modelId of confirmedNone) {
        const at = catalog.thinkingObservedAt?.[modelId];
        if (at !== undefined) noneObservedAt[modelId] = at;
      }
      for (const model of catalog.exactModels) {
        if (signal.aborted) break;
        if (collected[model.id] || confirmedNone.has(model.id)) continue;
        signal.throwIfAborted();
        const probeWorker = await createAcpWorker({
          cwd: directory, executable: context.executable,
          credentialRevision: context.credentialRevision,
          hostTools: true, catalogScope: undefined,
          model: model.id,
          ...(context.clientIdentity ? { clientIdentity: context.clientIdentity } : {}),
        }, signal).catch(() => undefined);
        try {
          if (signal.aborted) break;
          const observed = probeWorker?.catalog?.thinkingSelectors?.[model.id];
          if (observed) {
            collected[model.id] = observed;
            observedAtByModel[model.id] = probeWorker?.catalog?.thinkingObservedAt?.[model.id] ?? probeWorker?.catalog?.discoveredAt ?? Date.now();
          }
          else if (probeWorker?.catalog?.observation?.confirmedNoSelector && probeWorker.catalog.observation.confirmedModel === model.id) {
            confirmedNone.add(model.id);
            noneObservedAt[model.id] = probeWorker.catalog.thinkingObservedAt?.[model.id] ?? probeWorker.catalog.discoveredAt ?? Date.now();
          }
          // else: probe failed / incomplete -> unknown, record nothing.
        } finally { await probeWorker?.stop(true).catch(() => undefined); }
      }
      if (Object.keys(collected).length || confirmedNone.size) {
        // Aggregate per model so each observation keeps its true timestamp;
        // a single rebuilt catalog would stamp everything "now" and could
        // overwrite newer live updates. The aggregate's discoveredAt keeps
        // the base inventory's time, so inventory ordering stays independent
        // of thinking freshness (mergeCatalog prunes by inventory freshness).
        for (const [modelId, selector] of Object.entries(collected)) {
          const at = observedAtByModel[modelId];
          const fresh = acpModelCatalog(context.executable, catalog.version,
            catalog.exactModels.map((m): [string, string] => [m.id, m.name]),
            catalog.currentModel, catalog.thinking, { [modelId]: selector },
            { observation: { authoritativeInventory: true, confirmedModel: catalog.currentModel, confirmedNoSelector: false } });
          if (at !== undefined) { fresh.discoveredAt = catalog.discoveredAt; fresh.thinkingObservedAt = { [modelId]: at }; }
          // Preserve the original inventory time: rebuilding must never
          // stamp the inventory at aggregation time.
          fresh.inventoryAt = catalog.inventoryAt ?? catalog.discoveredAt;
          catalog = mergeCatalog(catalog, fresh);
        }
        if (confirmedNone.size) {
          const fresh = acpModelCatalog(context.executable, catalog.version,
            catalog.exactModels.map((m): [string, string] => [m.id, m.name]),
            catalog.currentModel, catalog.thinking, undefined,
            { observation: { authoritativeInventory: true, confirmedModel: catalog.currentModel, confirmedNoSelector: false },
              confirmedNone: [...confirmedNone] });
          fresh.discoveredAt = catalog.discoveredAt;
          fresh.inventoryAt = catalog.inventoryAt ?? catalog.discoveredAt;
          // Retain the original per-model clear timestamps, not aggregation time.
          fresh.thinkingObservedAt = Object.fromEntries([...confirmedNone].map((modelId) => [modelId, noneObservedAt[modelId] ?? catalog.discoveredAt]));
          catalog = mergeCatalog(catalog, fresh);
        }
      }
    }
    return catalog;
  } finally { await worker.stop(true); }
}

type Options = {
  context?: () => Promise<CatalogContext>;
  probe?: typeof probe;
  onChange?: (catalog: AcpModelCatalog) => void;
  onScopeChange?: (previous: string, next: string) => Promise<void>;
  ttlMs?: number;
  /** Discovery timeout override (tests only; production uses discoveryTimeoutMs). */
  timeoutMs?: number;
};

export class ModelCatalog {

  catalog = fallbackAcpModelCatalog();
  scope = "";
  lastError: unknown;
  private context?: CatalogContext;
  get credentialRevision() { return this.context?.credentialRevision; }
  private inFlight?: Promise<AcpModelCatalog>;
  private writes: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private closed = false;
  private lastAttempt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private unlisten: () => void;

  constructor(private directory: string, private options: Options = {}) {
    this.unlisten = onAcpCatalog((scope, catalog) => {
      if (this.closed || scope !== this.scope) return;
      // Merge exact-model observations across workers/conccurrent probes:
      // authoritative inventories prune, confirmed absence clears, partial
      // snapshots retain. Stale/removed selectors republish via adopt's
      // change detection (onChange -> provider reload).
      this.adopt(mergeCatalog(this.catalog, catalog));
    });
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.closed) return;
    this.timer = setInterval(() => { void this.refresh(); }, 60_000);
    this.timer.unref?.();
  }

  refresh(force = false): Promise<AcpModelCatalog> {
    if (this.closed) return Promise.resolve(this.catalog);
    if (!this.inFlight) this.inFlight = this.refreshInternal(force).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async refreshInternal(force: boolean): Promise<AcpModelCatalog> {
    try {
      const context = await (this.options.context ?? catalogContext)();
      if (this.closed) return this.catalog;
      const changed = context.scope !== this.scope;
      if (changed) {
        const previous = this.scope;
        this.scope = context.scope;
        this.context = context;
        this.lastAttempt = 0;
        this.adopt(fallbackAcpModelCatalog(context.executable), false);
        if (previous) await this.options.onScopeChange?.(previous, context.scope);
        await this.loadCache(context);
      }
      const ttl = this.options.ttlMs ?? 10 * 60_000;
      if (!force && this.catalog.source !== "empty" && Date.now() - this.catalog.discoveredAt < ttl) return this.catalog;
      // Retry failed discovery at most once a minute, even on busy workspaces.
      if (!force && !changed && Date.now() - this.lastAttempt < Math.min(ttl, 60_000)) return this.catalog;
      this.lastAttempt = Date.now();
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? discoveryTimeoutMs())]);
      const catalog = await (this.options.probe ?? probe)(context, this.directory, signal);
      const latest = await (this.options.context ?? catalogContext)();
      if (!this.closed && latest.scope === context.scope) { this.adopt(mergeCatalog(this.catalog, catalog)); this.lastError = undefined; }
      else if (!this.closed) {
        const previous = this.scope;
        this.scope = latest.scope;
        this.context = latest;
        this.lastAttempt = 0;
        this.adopt(fallbackAcpModelCatalog(latest.executable), false);
        if (previous) await this.options.onScopeChange?.(previous, latest.scope);
        await this.loadCache(latest);
      }
    } catch (error) {
      this.lastError = error;
      if (!this.closed) warn("ACP model discovery failed; retaining this account's last successful catalog", { kind: error instanceof Error ? error.name : "unknown" });
    }
    return this.catalog;
  }

  private adopt(catalog: AcpModelCatalog, persist = true): void {
    const changed = JSON.stringify(this.catalog.models) !== JSON.stringify(catalog.models) ||
      JSON.stringify(this.catalog.thinkingSelectors ?? null) !== JSON.stringify(catalog.thinkingSelectors ?? null) ||
      JSON.stringify(this.catalog.thinking ?? null) !== JSON.stringify(catalog.thinking ?? null) ||
      this.catalog.currentModel !== catalog.currentModel ||
      this.catalog.version !== catalog.version || this.catalog.source === "empty" && catalog.source !== "empty";
    this.catalog = catalog;
    if (changed) this.options.onChange?.(catalog);
    if (!persist || !this.context) return;
    const context = this.context;
    this.writes = this.writes.then(async () => {
      await mkdir(context.cacheDirectory, { recursive: true, mode: 0o700 });
      const path = join(context.cacheDirectory, `${context.scope}.json`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        // Store choices, not arbitrary server payloads or authentication data.
        await writeFile(temporary, JSON.stringify({ schema: 2, discoveredAt: catalog.discoveredAt,
          version: catalog.version, currentModel: catalog.currentModel,
          ...(catalog.thinking ? { thinking: catalog.thinking } : {}),
          ...(catalog.thinkingSelectors ? { thinkingSelectors: catalog.thinkingSelectors } : {}),
          ...(catalog.thinkingConfirmedNone?.length ? { thinkingConfirmedNone: catalog.thinkingConfirmedNone } : {}),
          ...(catalog.modelEnteredAt ? { modelEnteredAt: catalog.modelEnteredAt } : {}),
          entries: catalog.exactModels.map((model) => [model.id, model.name]),
          ...(context.clientIdentity ? { clientIdentity: context.clientIdentity.name } : {}),
        }), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }).catch(() => { warn("Could not persist ACP model catalog", { kind: "cache" }); });
  }

  private async loadCache(context: CatalogContext): Promise<void> {
    const data = await jsonFile(join(context.cacheDirectory, `${context.scope}.json`));
    if ((data.schema !== 1 && data.schema !== 2) || !Array.isArray(data.entries) || !Number.isFinite(data.discoveredAt) || data.discoveredAt > Date.now() ||
        !data.entries.every((entry: unknown) => Array.isArray(entry) && entry.length === 2 && entry.every((value) => typeof value === "string"))) return;
    // Identity isolation: a cache written under a different client identity
    // must never be reused (the scope digest already separates them, but a
    // schema-2 record naming another identity is rejected here too).
    const cachedIdentity = typeof data.clientIdentity === "string" ? data.clientIdentity : undefined;
    const expectedIdentity = context.clientIdentity?.name;
    if (cachedIdentity !== expectedIdentity) return;
    const thinking = data.thinking && typeof data.thinking === "object" && Array.isArray(data.thinking.values) &&
      data.thinking.values.every((value: unknown) => typeof value === "string") &&
      (data.thinking.current === undefined || typeof data.thinking.current === "string")
      ? { values: data.thinking.values as string[], ...(typeof data.thinking.current === "string" ? { current: data.thinking.current } : {}) }
      : undefined;
    const confirmedNone = data.schema === 2 && Array.isArray(data.thinkingConfirmedNone)
      ? (data.thinkingConfirmedNone as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined;
    const enteredAt = data.schema === 2 && data.modelEnteredAt && typeof data.modelEnteredAt === "object" && !Array.isArray(data.modelEnteredAt)
      ? Object.fromEntries(Object.entries(data.modelEnteredAt as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])))
      : undefined;
    let selectors: Record<string, AcpThinkingSelector> | undefined;
    if (data.schema === 2 && data.thinkingSelectors && typeof data.thinkingSelectors === "object" && !Array.isArray(data.thinkingSelectors)) {
      selectors = {};
      for (const [model, value] of Object.entries(data.thinkingSelectors as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.id !== "string" || !Array.isArray(entry.values) || !entry.values.every((v: unknown) => typeof v === "string")) continue;
        selectors[model] = { id: entry.id, values: entry.values as string[], ...(typeof entry.current === "string" ? { current: entry.current } : {}) };
      }
      if (!Object.keys(selectors).length) selectors = undefined;
    }
    const catalog = acpModelCatalog(context.executable, typeof data.version === "string" ? data.version : null, data.entries,
      typeof data.currentModel === "string" ? data.currentModel : undefined, thinking, selectors,
      data.schema === 2 ? { confirmedNone, enteredAt } : { thinkingSource: "legacy" as const });
    catalog.source = "cache";
    catalog.discoveredAt = data.discoveredAt;
    if (!this.closed) this.adopt(catalog, false);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unlisten();
    clearInterval(this.timer);
    this.controller.abort();
    await this.inFlight;
    await this.writes;
  }
}

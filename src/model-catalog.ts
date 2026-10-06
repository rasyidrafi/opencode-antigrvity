import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createAcpWorker } from "./acp-process.js";
import { ensureAcpServer } from "./acp-detect.js";
import { onAcpCatalog } from "./catalog-events.js";
import { acpModelCatalog, fallbackAcpModelCatalog, type AcpModelCatalog } from "./models.js";
import { warn } from "./log.js";
import { effectiveAuth } from "./effective-auth.js";

export type CatalogContext = { scope: string; executable: string; args: string[]; cacheDirectory: string };

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

/** Cache filenames contain only a digest. Never persist or log source credentials. */
export async function catalogContext(): Promise<CatalogContext> {
  const detection = await ensureAcpServer();
  const binary = await stat(detection.executable);
  const auth = await effectiveAuth();
  const scope = createHash("sha256").update(JSON.stringify({
    client: "opencode-antigravity", protocol: 1, auth: auth.scope,
    executable: detection.executable, args: detection.args, size: binary.size, modified: binary.mtimeMs,
  })).digest("hex");
  const data = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
    join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-antigravity");
  return { scope, executable: detection.executable, args: detection.args, cacheDirectory: join(data, "model-catalogs") };
}

async function probe(context: CatalogContext, directory: string, signal: AbortSignal): Promise<AcpModelCatalog> {
  const worker = await createAcpWorker({
    cwd: directory, executable: context.executable, executableArgs: context.args, nonInteractive: true,
    hostTools: true, catalogScope: undefined,
    // Discovery does not select a model and never sends an inference prompt.
  }, signal);
  try {
    if (!worker.catalog) throw new Error("ACP did not return model choices in session/new");
    return worker.catalog;
  } finally { await worker.stop(true); }
}

type Options = {
  context?: () => Promise<CatalogContext>;
  probe?: typeof probe;
  onChange?: (catalog: AcpModelCatalog) => void;
  onScopeChange?: (previous: string, next: string) => Promise<void>;
  ttlMs?: number;
};

export class ModelCatalog {
  catalog = fallbackAcpModelCatalog();
  scope = "";
  lastError: unknown;
  private context?: CatalogContext;
  private inFlight?: Promise<AcpModelCatalog>;
  private writes: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private closed = false;
  private lastAttempt = 0;
  private timer?: ReturnType<typeof setInterval>;
  private unlisten: () => void;

  constructor(private directory: string, private options: Options = {}) {
    this.unlisten = onAcpCatalog((scope, catalog) => {
      if (!this.closed && scope === this.scope) this.adopt(catalog);
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
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(45_000)]);
      const catalog = await (this.options.probe ?? probe)(context, this.directory, signal);
      const latest = await (this.options.context ?? catalogContext)();
      if (!this.closed && latest.scope === context.scope) { this.adopt(catalog); this.lastError = undefined; }
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
        await writeFile(temporary, JSON.stringify({ schema: 1, discoveredAt: catalog.discoveredAt,
          version: catalog.version, currentModel: catalog.currentModel,
          entries: catalog.exactModels.map((model) => [model.id, model.name]),
        }), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }).catch(() => { warn("Could not persist ACP model catalog", { kind: "cache" }); });
  }

  private async loadCache(context: CatalogContext): Promise<void> {
    const data = await jsonFile(join(context.cacheDirectory, `${context.scope}.json`));
    if (data.schema !== 1 || !Array.isArray(data.entries) || !Number.isFinite(data.discoveredAt) || data.discoveredAt > Date.now() ||
        !data.entries.every((entry: unknown) => Array.isArray(entry) && entry.length === 2 && entry.every((value) => typeof value === "string"))) return;
    const catalog = acpModelCatalog(context.executable, typeof data.version === "string" ? data.version : null, data.entries,
      typeof data.currentModel === "string" ? data.currentModel : undefined);
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

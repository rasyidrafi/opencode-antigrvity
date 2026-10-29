import { Integration, Model, Plugin, Provider } from "@opencode/plugin";
import { resolve as resolvePath } from "node:path";
import {
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MODEL_HEADER,
  MESSAGE_HEADER,
  PROVIDER_ID,
  PROVIDER_NAME,
  REQUEST_KIND_HEADER,
  SESSION_HEADER,
} from "./constants.js";
import { refreshModelMetadata, researchedMetadataFor } from "./model-metadata.js";
import { fallbackAcpModelCatalog, type AcpModel, type AcpModelCatalog } from "./models.js";
import { getProxyBaseUrl, getProxyRuntime, onModelCatalogChange, startProxy, stopProxy } from "./proxy.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { closeHostBridges } from "./host-tools.js";
import { sessionStore } from "./session-store.js";
import { sessionPool } from "./session-pool.js";
import { BoundedRetryQueue } from "./bounded-retry-queue.js";
import { ContextTelemetry } from "./telemetry-rpc.js";
import { onContextSnapshot, readContextSnapshot, markContextStale } from "./telemetry.js";
import { AgyError, retryAfterSeconds } from "./errors.js";
import { withAgentSystem } from "./request-instructions.js";
import { warn, info as lifecycleInfo } from "./log.js";

export const PLUGIN_ID = "opencode-antigravity";
export const INTEGRATION_ID = PROVIDER_ID;
const PROVIDER_PACKAGE = "@opencode/ai/providers/anthropic";

async function retainWorkspace(directory: string): Promise<string> {
  const root = resolvePath(directory);
  await startProxy(root);
  return root;
}

async function releaseWorkspace(directory: string): Promise<void> {
  const root = resolvePath(directory);
  await stopProxy(root);
}

function providerModel(model: AcpModel): Model.Info {
  const id = Model.ID.make(model.id);
  const base = Model.Info.default(Provider.ID.make(PROVIDER_ID), id);
  const metadata = researchedMetadataFor(model);
  return {
    ...base,
    modelID: id,
    name: metadata ? model.name : `${model.name} (limits estimated)`,
    ...(model.family ? { family: Model.Family.make(model.family) } : {}),
    capabilities: {
      tools: true,
      input: ["text", "image"],
      output: ["text"],
    },
    limit: {
      context: metadata?.context ?? 32_768,
      output: metadata?.output ?? 8_192,
    },
    variants: Object.keys(model.variants ?? {}).map((variant) => ({ id: Model.VariantID.make(variant) })),
  };
}

export function buildProviderModels(catalog: AcpModelCatalog): Model.Info[] {
  return catalog.models.map(providerModel);
}

function requestKind(kind: string): string {
  if (kind === "title") return "title";
  if (kind === "compaction") return "compaction";
  if (kind === "generate") return "generate";
  return "chat";
}

let warnedTemperature = false;
function stripAcpOwnedOptions(event: { options: Record<string, unknown> }): void {
  // ACP's own effort variants control reasoning; its Anthropic adapter does
  // not support model temperature overrides.
  delete event.options.reasoningEffort;
  if (event.options.temperature !== undefined && !warnedTemperature) {
    warnedTemperature = true;
    warn("Ignoring temperature: generation sampling is owned by ACP", { reason: "unsupported_temperature" });
  }
  delete event.options.temperature;
}

/** V2 plugin entrypoint. ACP owns Google auth; OpenCode sees only a local marker. */
export const AntigravityPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const workspaces = new WorkspaceRegistry(retainWorkspace, releaseWorkspace);
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    let metadataTimer: ReturnType<typeof setInterval> | undefined;
    const events = new AbortController();
    let stopTelemetry: (() => void) | undefined;
    let disposeTelemetry: (() => Promise<void>) | undefined;
    const deletionQueue = new BoundedRetryQueue(async (sessionID: string) => {
      await sessionStore.markHostDeleted(sessionID);
      await closeHostBridges(sessionID);
      await sessionPool.quiesceHostSession(sessionID);
      await sessionStore.removeHostSession(sessionID);
    }, {
      concurrency: 4,
      retryDelayMs: 15_000,
      onError: () => warn("Deleted session cleanup waiting for ownership release", { reason: "deletion_cleanup_pending" }),
    });

    try {
      for (const sessionID of await sessionStore.deletedHosts()) deletionQueue.enqueue(sessionID);
      await workspaces.add(ctx.location.directory);
      if (ctx.rpc) {
        const registration = await ctx.rpc.register(ContextTelemetry, {
          read: async (input, context) => {
            const { sessionID } = input as { sessionID: string };
            const session = await ctx.session.get({ sessionID: sessionID as Parameters<typeof ctx.session.get>[0]["sessionID"] });
            if (resolvePath(session.location.directory) !== resolvePath(ctx.location.directory)) return context.error("wrong_location", "Context telemetry belongs to another location", { sessionID });
            return readContextSnapshot(sessionID);
          },
        });
        disposeTelemetry = registration.dispose;
        stopTelemetry = onContextSnapshot(snapshot => {
          void ctx.session.get({ sessionID: snapshot.hostSessionID as Parameters<typeof ctx.session.get>[0]["sessionID"] }).then(session => {
            if (resolvePath(session.location.directory) === resolvePath(ctx.location.directory)) return registration.events.emit("changed", snapshot);
          }).catch(() => undefined);
        });
      }
      const providerID = Provider.ID.make(PROVIDER_ID);
      const info: Provider.Info = {
        ...Provider.Info.empty(providerID),
        name: PROVIDER_NAME,
        activation: "enabled",
        integrationID: Integration.ID.make(INTEGRATION_ID),
        package: PROVIDER_PACKAGE,
        settings: {
          baseURL: getProxyBaseUrl(),
          provider: PROVIDER_ID,
          apiKey: LOCAL_API_KEY,
        },
      };

      await ctx.integration.transform((editor) => {
        editor.update(INTEGRATION_ID, (integration) => {
          integration.name = PROVIDER_NAME;
        });
        // This is a local adapter, not a Google API-key provider. Keep the
        // integration ID equal to the provider ID for clients such as OpenChamber.
        editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "key", label: "Local Antigravity" } });
      });

      // Match V1: install the non-secret loopback marker automatically. Google
      // authentication comes only from the already-authenticated agy CLI.
      const connection = await ctx.integration.connection.active(INTEGRATION_ID);
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
      if (credential?.type !== "key" || credential.key !== LOCAL_API_KEY) {
        await ctx.integration.connect.key({ integrationID: INTEGRATION_ID, key: LOCAL_API_KEY });
      }

      await ctx.provider.transform((editor) => {
        editor.add({ info, models: buildProviderModels(getProxyRuntime()?.catalog ?? fallbackAcpModelCatalog()) });
      });
      unsubscribe = onModelCatalogChange(() => { void ctx.provider.reload().catch(() => undefined); });
      const refreshMetadata = () => { void refreshModelMetadata().then(() => { if (!disposed) return ctx.provider.reload(); }).catch(() => undefined); };
      refreshMetadata();
      metadataTimer = setInterval(refreshMetadata, 24 * 60 * 60_000);
      metadataTimer.unref?.();
      void (async () => {
        let attempts = 0;
        const lostBindings = new Map<string, Array<[string, string | undefined]>>();
        while (!events.signal.aborted) {
        try {
          if (attempts) {
            // Missing events never authorize resume: force alignment/rebuild
            // from the next authoritative request, retaining durable results.
            for (const [sessionID, expectedBindings] of lostBindings) {
              if (await sessionStore.isHostDeleted(sessionID)) { await sessionStore.removeHostSession(sessionID); continue; }
              await sessionStore.reconcileLostBinding(sessionID, expectedBindings, async () => {
                await closeHostBridges(sessionID);
                await sessionPool.quiesceHostSession(sessionID);
                await sessionStore.invalidateHostSession(sessionID);
              });
            }
            lostBindings.clear();
            lifecycleInfo("Host lifecycle subscription reconnecting", { reason: "event_reconcile", attempt: attempts });
          }
          for await (const event of ctx.event.subscribe({ signal: events.signal })) {
            attempts = 0;
            const e = event as { id?: string; type?: string; data?: { sessionID?: string; messageID?: string; id?: string } };
            if (e.type === "session.deleted" && e.data?.sessionID) {
              // The queue owns tombstone persistence too. Enqueue first so a
              // transient write failure remains retryable instead of losing
              // this lifecycle event before it reaches the durable backlog.
              await deletionQueue.enqueue(e.data.sessionID);
              continue;
            }
            if (e.data?.sessionID && await sessionStore.isHostDeleted(e.data.sessionID)) continue;
            if ((e.type === "session.execution.interrupted" || e.type === "session.execution.failed") && e.data?.sessionID) await closeHostBridges(e.data.sessionID);
          }
        } catch { /* Intentional cleanup exits below; unexpected loss retries. */ }
        if (events.signal.aborted) break;
        try {
          lostBindings.clear();
          for (const [key, record] of await sessionStore.entries()) if (record.conversation?.hostSessionID) {
            const sessionID = record.conversation.hostSessionID;
            const bindings = lostBindings.get(sessionID) ?? [];
            bindings.push([key, record.revision]); lostBindings.set(sessionID, bindings);
          }
          for (const sessionID of lostBindings.keys()) {
            try { await markContextStale(sessionID); } catch { warn("Could not mark disconnected context stale", { sessionID, reason: "event_stale_failed" }); }
          }
        } catch { warn("Could not reconcile disconnected session metadata", { reason: "event_metadata_failed" }); }
        attempts++;
        const delay = Math.min(30_000, 250 * 2 ** Math.min(attempts - 1, 7)) * (0.8 + Math.random() * 0.4);
        warn("Host lifecycle subscription lost", { reason: "event_disconnect", attempt: attempts });
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); events.signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, delay); timer.unref?.();
          events.signal.addEventListener("abort", finish, { once: true });
          if (events.signal.aborted) finish();
        });
        }
      })();

      for (const kind of ["context", "compaction", "generate", "title"] as const) {
        await ctx.session.hook(kind, stripAcpOwnedOptions, { providerID: PROVIDER_ID });
      }

      // Read the agent itself, not the system assembled from host instructions,
      // skills and environment. A failed lookup must not leak the generated system.
      await ctx.session.hook("http.request", async event => {
        if (event.kind !== "primary") return;
        const agent = await ctx.agent.get({ agentID: event.agent });
        event.request = await withAgentSystem(event.request, agent.data.system);
      }, { providerID: PROVIDER_ID });

      await ctx.session.hook("retry", event => {
        if (!event.decision.retry) return;
        // Older adapter instances reported a permanently closed pool as 502.
        // Repeating that request cannot revive its runtime; never loop on it.
        if (event.error.message.includes("The Antigravity session pool has been shut down")) {
          event.decision = { retry: false };
          return;
        }
        // Mid-stream Anthropic errors have no HTTP Retry-After header. V2
        // retains the raw provider body on SessionError, so honor our normalized
        // seconds hint here without changing the host's retry eligibility.
        try {
          const payload = JSON.parse(event.error.response?.body ?? "null");
          const seconds = payload?.error?.retry_after;
          if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) event.decision.delay = Math.ceil(seconds * 1000);
          else if (/rate.?limit|quota|overload/i.test(event.error.message) && /retry|reset/i.test(event.error.message)) {
            const parsed = retryAfterSeconds(new AgyError("rate_limit", event.error.message));
            if (parsed) event.decision.delay = parsed * 1000;
          }
        } catch { /* Malformed provider data must not replace host retry policy. */ }
      }, { providerID: PROVIDER_ID });

      await ctx.session.hook(
        "model.request",
        async (event) => {
          if (await sessionStore.isHostDeleted(event.sessionID)) throw new AgyError("invalid_request", "Host session has been deleted");
          const session = await ctx.session.get({ sessionID: event.sessionID });
          const directory = session.location.directory;
          await workspaces.add(directory);
          event.baseURL = getProxyBaseUrl();
          event.headers["x-api-key"] = LOCAL_API_KEY;
          for (const header of Object.keys(event.headers)) {
            if (header.toLowerCase() === "authorization") delete event.headers[header];
          }
          event.headers[MODEL_HEADER] = event.model.id;
          if (event.model.variant && event.model.variant !== "default") event.headers[EFFORT_HEADER] = event.model.variant;
          else delete event.headers[EFFORT_HEADER];
          event.headers[DIRECTORY_HEADER] = directory;
          event.headers[SESSION_HEADER] = event.sessionID;
          event.headers["x-opencode-antigravity-host-tools"] = "1";
          event.headers[REQUEST_KIND_HEADER] = requestKind(event.kind);
          // V2's model.request event has no messageID. The proxy uses its stable
          // request-content hash for replay protection when this header is absent.
          delete event.headers[MESSAGE_HEADER];
        },
        { providerID: PROVIDER_ID },
      );

      return async () => { disposed = true; events.abort(); clearInterval(metadataTimer); deletionQueue.close(); unsubscribe?.(); stopTelemetry?.(); await deletionQueue.drain(); await disposeTelemetry?.(); await workspaces.cleanup(); };
    } catch (error) {
      disposed = true;
      events.abort();
      clearInterval(metadataTimer);
      deletionQueue.close();
      await deletionQueue.drain();
      unsubscribe?.();
      stopTelemetry?.();
      await disposeTelemetry?.();
      try {
        await workspaces.cleanup();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Plugin setup failed and workspace cleanup also failed");
      }
      throw error;
    }
  },
});

export { acpModelCatalog, fallbackAcpModelCatalog } from "./models.js";
export { detectAcpServer } from "./acp-detect.js";
export {
  getProxyBaseUrl,
  getProxyPort,
  getProxyRuntime,
  refreshModels,
  startProxy,
  stopProxy,
} from "./proxy.js";
export { sessionPool } from "./session-pool.js";

export default AntigravityPlugin;

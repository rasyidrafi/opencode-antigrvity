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
import { createAcpWorker } from "./acp-process.js";
import { ensureAcpServer } from "./acp-detect.js";
import { refreshModelMetadata, researchedMetadataFor } from "./model-metadata.js";
import { fallbackAcpModelCatalog, type AcpModel, type AcpModelCatalog } from "./models.js";
import { getProxyBaseUrl, getProxyRuntime, onModelCatalogChange, startProxy, stopProxy } from "./proxy.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

export const PLUGIN_ID = "opencode-antigravity";
export const INTEGRATION_ID = PROVIDER_ID;
export const AUTH_METHOD_ID = "antigravity-acp";
const PROVIDER_PACKAGE = "@opencode/ai/providers/anthropic";
const AUTH_REGISTRY_URL = "https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp";

const AUTH_METHODS = [
  { value: "oauth-personal", label: "Personal Google account", description: "Sign in with a personal Google account" },
  { value: "oauth-business", label: "Gemini Enterprise", description: "Sign in with a Gemini Enterprise account" },
  { value: "gemini-api-key", label: "Gemini API key", description: "Enter the key through the official ACP server" },
  { value: "agent-platform", label: "Agent Platform", description: "Use ADC or an Agent Platform key" },
] as const;

const workspaceReferences = new Map<string, number>();

async function retainWorkspace(directory: string): Promise<string> {
  const root = resolvePath(directory);
  await startProxy(root);
  workspaceReferences.set(root, (workspaceReferences.get(root) ?? 0) + 1);
  return root;
}

async function releaseWorkspace(directory: string): Promise<void> {
  const root = resolvePath(directory);
  const references = workspaceReferences.get(root) ?? 0;
  if (references > 1) {
    workspaceReferences.set(root, references - 1);
    return;
  }
  workspaceReferences.delete(root);
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
      tools: false,
      input: ["text", "image", "audio"],
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

async function authorizeAcp(directory: string, answer: Record<string, unknown>) {
  const requested = answer.method;
  const method = AUTH_METHODS.some((item) => item.value === requested)
    ? requested as (typeof AUTH_METHODS)[number]["value"]
    : "oauth-personal";
  const detection = await ensureAcpServer();
  const callback = (async () => {
    const worker = await createAcpWorker({
      cwd: directory,
      executable: detection.executable,
      executableArgs: detection.args,
      authMethod: method,
      skipSession: true,
    });
    try {
      // OpenCode receives only a synthetic local proxy credential. ACP owns all
      // Google authentication and credential persistence.
      return {
        type: "oauth" as const,
        methodID: Integration.MethodID.make(AUTH_METHOD_ID),
        access: LOCAL_API_KEY,
        refresh: LOCAL_API_KEY,
        expires: Number.MAX_SAFE_INTEGER,
        metadata: { source: PLUGIN_ID, authMethod: method },
      };
    } finally {
      await worker.stop(true);
    }
  })();

  return {
    // ACP owns the actual provider URL; V2's OAuth contract still needs a
    // navigable link, so point the client at the official ACP registry entry.
    url: AUTH_REGISTRY_URL,
    instructions:
      "The official Antigravity ACP server performs sign-in and stores its credentials locally. OpenCode stores only the fixed loopback proxy marker; never paste a Google credential into OpenCode.",
    mode: "auto" as const,
    callback,
  };
}

function requestKind(kind: string): string {
  if (kind === "title") return "title";
  if (kind === "compaction") return "summary";
  if (kind === "generate") return "generate";
  return "chat";
}

function stripAcpOwnedOptions(event: { options: Record<string, unknown> }): void {
  // ACP's own effort variants control reasoning; its Anthropic adapter does
  // not support model temperature overrides.
  delete event.options.reasoningEffort;
  delete event.options.temperature;
}

/** V2 plugin entrypoint. ACP owns Google auth; OpenCode sees only a local marker. */
export const AntigravityCliPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const workspaces = new WorkspaceRegistry(retainWorkspace, releaseWorkspace);
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    let metadataTimer: ReturnType<typeof setInterval> | undefined;

    try {
      await workspaces.add(ctx.location.directory);
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
        editor.method.update({
          integrationID: INTEGRATION_ID,
          method: {
            id: AUTH_METHOD_ID,
            type: "oauth",
            label: "Sign in with the official Antigravity ACP server",
            form: [{
              key: "method",
              type: "string",
              title: "Antigravity authentication method",
              description: "The selected method is handled by the official ACP server, not OpenCode.",
              required: true,
              default: "oauth-personal",
              options: AUTH_METHODS.map(({ value, label, description }) => ({ value, label, description })),
            }],
          },
          authorize: (answer) => authorizeAcp(ctx.location.directory, answer),
        });
        // This is a local adapter, not a Google API-key provider. Keep the
        // integration ID equal to the provider ID for clients such as OpenChamber.
        editor.method.update({ integrationID: INTEGRATION_ID, method: { type: "key", label: "Local Antigravity CLI" } });
      });

      // Match V1: install the non-secret loopback marker automatically. Google
      // authentication stays in the CLI/ACP worker; no user-facing connect flow.
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

      for (const kind of ["context", "compaction", "generate", "title"] as const) {
        await ctx.session.hook(kind, stripAcpOwnedOptions, { providerID: PROVIDER_ID });
      }

      await ctx.session.hook(
        "model.request",
        async (event) => {
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
          event.headers[REQUEST_KIND_HEADER] = requestKind(event.kind);
          // V2's model.request event has no messageID. The proxy uses its stable
          // request-content hash for replay protection when this header is absent.
          delete event.headers[MESSAGE_HEADER];
        },
        { providerID: PROVIDER_ID },
      );

      return () => { disposed = true; clearInterval(metadataTimer); unsubscribe?.(); return workspaces.cleanup(); };
    } catch (error) {
      disposed = true;
      clearInterval(metadataTimer);
      unsubscribe?.();
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

export default AntigravityCliPlugin;

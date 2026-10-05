import type { AcpModel } from "./models.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ResearchedModelMetadata = {
  context: number;
  output: number;
  source: "models.dev" | "google-api" | "models.dev+google-api";
  sources: string[];
  underlying: {
    input: string[];
    output: string[];
    attachment: boolean;
    reasoning: boolean;
    toolcall: boolean;
    structured: boolean;
    temperature: boolean;
  };
};

const MODELS_DEV = "https://models.dev/models";
const GOOGLE_API = "https://ai.google.dev/gemini-api/docs";

const GOOGLE_MULTIMODAL = ["text", "image", "video", "audio", "pdf"];
const TEXT_OUTPUT = ["text"];

/**
 * Canonical model facts are deliberately separate from the ACP catalog. The
 * ACP server exposes model choices per session, but does not publish a global
 * token-limit metadata endpoint. These entries are only used when the
 * canonical model is unambiguous in models.dev and/or Google's public Gemini
 * API documentation.
 */
const RESEARCHED: Record<string, ResearchedModelMetadata> = {
  "gemini-3.8-flash": {
    context: 1_048_576,
    output: 65_536,
    source: "models.dev+google-api",
    sources: [`${MODELS_DEV}/google/gemini-3.8-flash/`, `${GOOGLE_API}/models/gemini-3.8-flash`],
    underlying: { input: GOOGLE_MULTIMODAL, output: TEXT_OUTPUT, attachment: true, reasoning: true, toolcall: true, structured: true, temperature: false },
  },
  "gemini-3.7-flash": {
    context: 1_048_576,
    output: 65_536,
    source: "models.dev+google-api",
    sources: [`${MODELS_DEV}/google/gemini-3.7-flash/`, `${GOOGLE_API}/latest-model`],
    underlying: { input: GOOGLE_MULTIMODAL, output: TEXT_OUTPUT, attachment: true, reasoning: true, toolcall: true, structured: true, temperature: false },
  },
  "gemini-3.6-flash": {
    context: 1_048_576,
    output: 65_536,
    source: "models.dev+google-api",
    sources: [`${MODELS_DEV}/google/gemini-3.6-flash/`, `${GOOGLE_API}/models/gemini-3.6-flash`],
    underlying: { input: GOOGLE_MULTIMODAL, output: TEXT_OUTPUT, attachment: true, reasoning: true, toolcall: true, structured: true, temperature: false },
  },
  "gemini-3.5-flash": {
    context: 1_048_576,
    output: 65_536,
    source: "models.dev+google-api",
    sources: [`${MODELS_DEV}/google/gemini-3.5-flash/`, `${GOOGLE_API}/whats-new-gemini-3.5`],
    underlying: { input: GOOGLE_MULTIMODAL, output: TEXT_OUTPUT, attachment: true, reasoning: true, toolcall: true, structured: true, temperature: false },
  },
  // The catalog slug omits the preview suffix used by Google's public API docs.
  "gemini-3.1-pro-preview": {
    context: 1_048_576,
    output: 65_536,
    source: "models.dev+google-api",
    sources: [`${MODELS_DEV}/google/gemini-3.1-pro-preview/`, `${GOOGLE_API}/models/gemini-3.1-pro-preview`],
    underlying: { input: GOOGLE_MULTIMODAL, output: TEXT_OUTPUT, attachment: true, reasoning: true, toolcall: true, structured: true, temperature: false },
  },
  "claude-sonnet-4-6": {
    context: 1_000_000,
    output: 128_000,
    source: "models.dev",
    sources: [`${MODELS_DEV}/anthropic/claude-sonnet-4-6/`],
    underlying: { input: ["text", "image", "pdf"], output: TEXT_OUTPUT, attachment: true, reasoning: true, toolcall: true, structured: false, temperature: true },
  },
  "claude-opus-4-6": {
    context: 1_000_000,
    output: 128_000,
    source: "models.dev",
    sources: [`${MODELS_DEV}/anthropic/claude-opus-4-6/`],
    underlying: { input: ["text", "image", "pdf"], output: TEXT_OUTPUT, attachment: true, reasoning: true, toolcall: true, structured: true, temperature: true },
  },
  "gpt-oss-120b": {
    context: 131_072,
    output: 32_768,
    source: "models.dev",
    sources: [`${MODELS_DEV}/openai/gpt-oss-120b/`],
    underlying: { input: ["text"], output: TEXT_OUTPUT, attachment: false, reasoning: true, toolcall: true, structured: true, temperature: true },
  },
};

function canonicalId(model: AcpModel): string {
  let id = model.id.toLowerCase().replace(/^antigravity-cli\//, "");
  if (model.family) id = model.family.toLowerCase();
  else id = id.replace(/-(?:low|medium|high)$/i, "");
  if (id === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
  if (id === "claude-opus-4-6-thinking") return "claude-opus-4-6";
  return id;
}

export function researchedMetadataFor(model: AcpModel): ResearchedModelMetadata | undefined {
  return discovered[canonicalId(model)] ?? RESEARCHED[canonicalId(model)];
}

export function allResearchedMetadata(): Readonly<Record<string, ResearchedModelMetadata>> {
  return { ...RESEARCHED, ...discovered };
}

let discovered: Record<string, ResearchedModelMetadata> = {};
let pending: Promise<void> | undefined;
let lastRefresh = 0;

/** Enrichment only: no returned entry can create an available ACP model. */
export function parseModelsDev(document: Record<string, any>): Record<string, ResearchedModelMetadata> {
  const result: Record<string, ResearchedModelMetadata> = {};
  for (const provider of ["google", "anthropic", "openai"]) {
    for (const [id, value] of Object.entries(document[provider]?.models ?? {})) {
      const model = value as Record<string, any>;
      const context = model?.limit?.context, output = model?.limit?.output;
      if (!Number.isFinite(context) || !Number.isFinite(output) || context <= 0 || output <= 0) continue;
      result[id] = {
        context, output, source: "models.dev", sources: [`https://models.dev/models/${provider}/${id}/`],
        underlying: {
          input: Array.isArray(model.modalities?.input) ? model.modalities.input.filter((v: unknown) => typeof v === "string") : ["text"],
          output: ["text"], attachment: model.attachment === true, reasoning: model.reasoning === true,
          toolcall: model.tool_call === true, structured: model.structured_output === true, temperature: model.temperature === true,
        },
      };
    }
  }
  return result;
}

export function refreshModelMetadata(): Promise<void> {
  if (process.env.OPENCODE_ANTIGRAVITY_MODELS_DEV === "0" || Date.now() - lastRefresh < 24 * 60 * 60_000) return Promise.resolve();
  if (!pending) pending = (async () => {
    lastRefresh = Date.now();
    const directory = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
      join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-antigravity");
    const path = join(directory, "models-dev.json");
    try {
      const cached = JSON.parse(await readFile(path, "utf8"));
      discovered = parseModelsDev(cached.document);
      if (Number.isFinite(cached.time) && cached.time <= Date.now() && Date.now() - cached.time < 24 * 60 * 60_000) return;
    } catch { /* Metadata is optional; keep bundled estimates when offline. */ }
    try {
      const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return;
      const document = await response.json() as Record<string, any>;
      const parsed = parseModelsDev(document);
      if (!Object.keys(parsed).length) return;
      discovered = parsed;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ time: Date.now(), document }), { mode: 0o600 });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    } catch { /* A failed enrichment request never changes availability. */ }
  })().finally(() => { pending = undefined; });
  return pending;
}

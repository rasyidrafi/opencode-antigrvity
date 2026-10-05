import { AgyError } from "./errors.js";
import { SUPPORTED_EFFORTS, type AcpEffort } from "./constants.js";

export type AcpModel = {
  id: string;
  name: string;
  acpModel: string;
  family?: string;
  effort?: AcpEffort;
  variants?: Record<string, { effort: AcpEffort; acpModel: string }>;
};

export type AcpModelCatalog = {
  models: AcpModel[];
  exactModels: AcpModel[];
  version: string | null;
  executable: string;
  discoveredAt: number;
  source: "acp" | "fallback";
};

export const FALLBACK_MODELS: Array<[string, string]> = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
  ["gemini-3.7-flash-medium", "Gemini 3.7 Flash (Medium)"],
  ["gemini-3.7-flash-low", "Gemini 3.7 Flash (Low)"],
  ["gemini-3.6-flash-high", "Gemini 3.6 Flash (High)"],
  ["gemini-3.6-flash-medium", "Gemini 3.6 Flash (Medium)"],
  ["gemini-3.6-flash-low", "Gemini 3.6 Flash (Low)"],
  ["gemini-3.5-flash-high", "Gemini 3.5 Flash (High)"],
  ["gemini-3.5-flash-medium", "Gemini 3.5 Flash (Medium)"],
  ["gemini-3.5-flash-low", "Gemini 3.5 Flash (Low)"],
  ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
  ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"],
  ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];

const EFFORT_SUFFIX = /^(.*)-(low|medium|high)$/i;

function buildModels(entries: Array<[string, string]>): { exact: AcpModel[]; all: AcpModel[] } {
  const exact = entries.map(([id, name]) => {
    const match = id.match(EFFORT_SUFFIX);
    const effort = match ? (match[2].toLowerCase() as AcpEffort) : undefined;
    return {
      id,
      name,
      acpModel: id,
      ...(match ? { family: match[1], effort } : {}),
    } satisfies AcpModel;
  });
  const families = new Map<string, AcpModel[]>();
  for (const model of exact) {
    if (!model.family || !model.effort) continue;
    const list = families.get(model.family) ?? [];
    list.push(model);
    families.set(model.family, list);
  }
  const aliases: AcpModel[] = [];
  const groupedFamilies = new Set<string>();
  for (const [family, members] of families) {
    if (members.length < 2) continue;
    const variants = Object.fromEntries(
      members
        .filter((member) => member.effort)
        .map((member) => [member.effort!, { effort: member.effort!, acpModel: member.acpModel }]),
    );
    aliases.push({
      id: family,
      name: (members[0].name.replace(/\s*\((?:low|medium|high)\)\s*$/i, "").trim() || family),
      // The ACP server accepts concrete model values through its session
      // config options. Use the first listed tier as the default and replace
      // it with an exact sibling when a variant is selected.
      acpModel: members[0].acpModel,
      family,
      variants,
    });
    groupedFamilies.add(family);
  }
  // Effort-suffixed model ids are retained in exactModels for validation and
  // direct API requests, but the OpenCode catalog exposes one named family
  // with variants instead of rendering the same model three or four times.
  const ungroupedExact = exact.filter((model) => !model.family || !groupedFamilies.has(model.family));
  return { exact, all: [...aliases, ...ungroupedExact] };
}

/**
 * ACP does not expose a global model-list method. Model choices are session
 * config options, so the provider publishes the known Antigravity catalog and
 * validates the selected value again when `session/new` returns its options.
 */
export async function discoverAcpModels(executable = "agy_acp_server.par"): Promise<AcpModelCatalog> {
  return acpModelCatalog(executable);
}

export function acpModelCatalog(executable = "agy_acp_server.par", version: string | null = null): AcpModelCatalog {
  return { ...fallbackAcpModelCatalog(executable, version), source: "acp" };
}

export function fallbackAcpModelCatalog(executable = "agy_acp_server.par", version: string | null = null): AcpModelCatalog {
  const built = buildModels(FALLBACK_MODELS);
  return {
    models: built.all,
    exactModels: built.exact,
    version,
    executable,
    discoveredAt: Date.now(),
    source: "fallback",
  };
}

export type AcpModelSelection = {
  requestedModel: string;
  acpModel: string;
  effort?: AcpEffort;
};

export function resolveAcpModelSelection(
  requestedModel: string | undefined,
  requestedEffort: string | undefined,
  catalog: AcpModelCatalog,
): AcpModelSelection {
  const raw = (requestedModel ?? catalog.models[0]?.id ?? "").replace(/^antigravity-cli\//, "").trim();
  if (!raw) throw new AgyError("unknown_model", "No Antigravity model is available", { code: "agy_no_model" });
  const model = catalog.models.find((entry) => entry.id === raw) ?? catalog.exactModels.find((entry) => entry.id === raw);
  if (!model) {
    throw new AgyError("unknown_model", `Unknown Antigravity model "${raw}"`, {
      code: "agy_unknown_model",
      details: { available: catalog.exactModels.map((entry) => entry.id) },
    });
  }
  const effort = requestedEffort?.trim().toLowerCase();
  if (effort && !(SUPPORTED_EFFORTS as readonly string[]).includes(effort)) {
    throw new AgyError("invalid_request", `Unsupported effort "${requestedEffort}"; use low, medium, or high`, {
      code: "agy_invalid_effort",
    });
  }
  if (!effort) return { requestedModel: raw, acpModel: model.acpModel, ...(model.effort ? { effort: undefined } : {}) };
  const wanted = effort as AcpEffort;
  if (model.variants?.[wanted]) {
    return { requestedModel: raw, acpModel: model.variants[wanted].acpModel };
  }
  if (model.family) {
    const sibling = catalog.exactModels.find((entry) => entry.id === `${model.family}-${wanted}`);
    if (sibling) return { requestedModel: raw, acpModel: sibling.acpModel };
  }
  // For a model without an effort-suffixed sibling, use the ACP effort config
  // option. Exact suffixed ids are preferred when the catalog lists one.
  return { requestedModel: raw, acpModel: model.acpModel, effort: wanted };
}

export function providerModelEntries(catalog: AcpModelCatalog): AcpModel[] {
  return catalog.models;
}

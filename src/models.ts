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
  currentModel?: string;
  source: "acp" | "cache" | "empty";
};

/** Unknown/opaque IDs stay opaque. Only advertised, explicitly named effort
 * siblings form aliases; the alias always retains each exact wire ID. */
export function acpModelCatalog(
  executable: string,
  version: string | null = null,
  entries: Array<[string, string]> = [],
  currentModel?: string,
): AcpModelCatalog {
  const ids = new Set(entries.map(([id]) => id));
  const seen = new Set<string>();
  const exact: AcpModel[] = [];
  for (const [id, name] of entries) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const suffix = id.match(/^(.*)-(low|medium|high)$/);
    const namedEffort = name.match(/\((low|medium|high)\)$/i)?.[1].toLowerCase();
    const grouped = suffix && suffix[2] === namedEffort && !ids.has(suffix[1]);
    exact.push({ id, name, acpModel: id, ...(grouped ? { family: suffix[1], effort: suffix[2] as AcpEffort } : {}) });
  }
  const families = new Map<string, AcpModel[]>();
  for (const model of exact) {
    if (!model.family) continue;
    const members = families.get(model.family) ?? [];
    members.push(model);
    families.set(model.family, members);
  }
  const models: AcpModel[] = [];
  const emitted = new Set<string>();
  for (const model of exact) {
    const members = model.family ? families.get(model.family)! : [];
    if (members.length < 2) { models.push(model); continue; }
    if (emitted.has(model.family!)) continue;
    emitted.add(model.family!);
    models.push({
      id: model.family!, family: model.family,
      name: model.name.replace(/\s*\((low|medium|high)\)$/i, ""),
      acpModel: members.find((member) => member.effort === "high")?.id ?? members.find((member) => member.effort === "medium")?.id ?? model.id,
      variants: Object.fromEntries(members.map((member) => [member.effort!, { effort: member.effort!, acpModel: member.id }])),
    });
  }
  return { models, exactModels: exact, executable, version, currentModel, discoveredAt: Date.now(), source: "acp" };
}

/** No invented availability when discovery has never succeeded. */
export function fallbackAcpModelCatalog(executable = "agy_acp_server.par", version: string | null = null): AcpModelCatalog {
  return { ...acpModelCatalog(executable, version), source: "empty", discoveredAt: 0 };
}

/** Missing model state means "no update"; an advertised empty list is authoritative. */
export function catalogFromSession(response: unknown, executable: string, version: string | null = null): AcpModelCatalog | undefined {
  if (!response || typeof response !== "object") return;
  const data = response as Record<string, any>;
  const model = Array.isArray(data.configOptions)
    ? data.configOptions.find((option: any) => option?.category === "model") ?? data.configOptions.find((option: any) => option?.id === "model")
    : undefined;
  const entries: Array<[string, string]> = [];
  const flatten = (options: unknown[]) => {
    for (const option of options) {
      if (!option || typeof option !== "object") continue;
      const entry = option as Record<string, any>;
      if (Array.isArray(entry.options)) flatten(entry.options);
      else if (typeof entry.value === "string" && entry.value) entries.push([entry.value, typeof entry.name === "string" ? entry.name : entry.value]);
    }
  };
  if (model && Array.isArray(model.options)) {
    flatten(model.options);
    return acpModelCatalog(executable, version, entries, typeof model.currentValue === "string" ? model.currentValue : undefined);
  }
  if (Array.isArray(data.models?.availableModels)) {
    for (const entry of data.models.availableModels) {
      if (typeof entry?.modelId === "string" && entry.modelId) entries.push([entry.modelId, typeof entry.name === "string" ? entry.name : entry.modelId]);
    }
    return acpModelCatalog(executable, version, entries, data.models.currentModelId);
  }
}

export type AcpModelSelection = { requestedModel: string; acpModel: string; effort?: AcpEffort };

export function resolveAcpModelSelection(requestedModel: string | undefined, requestedEffort: string | undefined, catalog: AcpModelCatalog): AcpModelSelection {
  const raw = (requestedModel ?? catalog.models[0]?.id ?? "").replace(/^antigravity\//, "").trim();
  if (!raw) throw new AgyError("unknown_model", "Antigravity model discovery has not returned any available models", { code: "agy_no_model" });
  const model = catalog.models.find((entry) => entry.id === raw) ?? catalog.exactModels.find((entry) => entry.id === raw);
  if (!model) throw new AgyError("unknown_model", `Unknown Antigravity model "${raw}"`, { code: "agy_unknown_model", details: { available: catalog.exactModels.map((entry) => entry.id) } });
  const effort = requestedEffort?.trim().toLowerCase();
  if (!effort || effort === "default") return { requestedModel: raw, acpModel: model.acpModel };
  if (!(SUPPORTED_EFFORTS as readonly string[]).includes(effort)) throw new AgyError("invalid_request", `Unsupported effort "${effort}"`, { code: "agy_invalid_effort" });
  const variant = model.variants?.[effort];
  if (variant) return { requestedModel: raw, acpModel: variant.acpModel };
  const sibling = model.family && catalog.exactModels.find((entry) => entry.family === model.family && entry.effort === effort);
  if (sibling) return { requestedModel: raw, acpModel: sibling.acpModel };
  if (model.effort === effort) return { requestedModel: raw, acpModel: model.acpModel };
  throw new AgyError("invalid_request", `Antigravity did not advertise effort "${effort}" for "${raw}"`, { code: "agy_invalid_effort" });
}

export function providerModelEntries(catalog: AcpModelCatalog): AcpModel[] { return catalog.models; }

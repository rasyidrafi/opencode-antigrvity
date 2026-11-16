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

/** Runtime 1.4 reports thinking as its own session option instead of encoding
 * it in the model id. The values are the same effort names. */
export type AcpThinking = { values: string[]; current?: string };

export type AcpModelCatalog = {
  models: AcpModel[];
  exactModels: AcpModel[];
  version: string | null;
  executable: string;
  discoveredAt: number;
  currentModel?: string;
  thinking?: AcpThinking;
  source: "acp" | "cache" | "empty";
};

/** Unknown/opaque IDs stay opaque. Only advertised, explicitly named effort
 * siblings form aliases; the alias always retains each exact wire ID. */
export function acpModelCatalog(
  executable: string,
  version: string | null = null,
  entries: Array<[string, string]> = [],
  currentModel?: string,
  thinking?: AcpThinking,
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
  return { models, exactModels: exact, executable, version, currentModel, ...(thinking ? { thinking } : {}), discoveredAt: Date.now(), source: "acp" };
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
  const thinkingOption = Array.isArray(data.configOptions)
    ? data.configOptions.find((option: any) => option?.category === "thought_level" || option?.id === "thought_level" || option?.id === "effort" || option?.id === "reasoning_effort")
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
  const thinkingValues: string[] = [];
  if (thinkingOption && Array.isArray(thinkingOption.options)) {
    for (const option of thinkingOption.options) {
      if (!option || typeof option !== "object") continue;
      const entry = option as Record<string, any>;
      if (Array.isArray(entry.options)) {
        for (const nested of entry.options) if (typeof nested?.value === "string" && nested.value) thinkingValues.push(nested.value);
      } else if (typeof entry.value === "string" && entry.value) {
        thinkingValues.push(entry.value);
      }
    }
  }
  const thinking: AcpThinking | undefined = thinkingOption && thinkingValues.length
    ? { values: thinkingValues, ...(typeof thinkingOption.currentValue === "string" ? { current: thinkingOption.currentValue } : {}) }
    : undefined;
  if (model && Array.isArray(model.options)) {
    flatten(model.options);
    return acpModelCatalog(executable, version, entries, typeof model.currentValue === "string" ? model.currentValue : undefined, thinking);
  }
  if (Array.isArray(data.models?.availableModels)) {
    for (const entry of data.models.availableModels) {
      if (typeof entry?.modelId === "string" && entry.modelId) entries.push([entry.modelId, typeof entry.name === "string" ? entry.name : entry.modelId]);
    }
    return acpModelCatalog(executable, version, entries, data.models.currentModelId, thinking);
  }
}

export type AcpModelSelection = { requestedModel: string; acpModel: string; effort?: AcpEffort };

export function resolveAcpModelSelection(requestedModel: string | undefined, requestedEffort: string | undefined, catalog: AcpModelCatalog): AcpModelSelection {
  const raw = (requestedModel ?? catalog.models[0]?.id ?? "").replace(/^antigravity\//, "").trim();
  if (!raw) throw new AgyError("unknown_model", "Antigravity model discovery has not returned any available models", { code: "agy_no_model" });
  let model = catalog.models.find((entry) => entry.id === raw) ?? catalog.exactModels.find((entry) => entry.id === raw);
  let effort = requestedEffort?.trim().toLowerCase();
  if (!model) {
    // Runtime 1.4 lists the family id (`gemini-3.8-flash`) where 1.3 listed
    // effort-suffixed ids. The agent still accepts the old id, so map it back
    // to the family and carry the suffix as the thinking level.
    const legacy = raw.match(/^(.*)-(low|medium|high)$/);
    if (legacy) {
      const family = catalog.models.find((entry) => entry.id === legacy[1]) ?? catalog.exactModels.find((entry) => entry.id === legacy[1]);
      if (family) {
        model = family;
        effort = effort ?? legacy[2];
      }
    }
  }
  if (!model) throw new AgyError("unknown_model", `Unknown Antigravity model "${raw}"`, { code: "agy_unknown_model", details: { available: catalog.exactModels.map((entry) => entry.id) } });
  if (!effort || effort === "default") return { requestedModel: raw, acpModel: model.acpModel };
  if (!(SUPPORTED_EFFORTS as readonly string[]).includes(effort)) throw new AgyError("invalid_request", `Unsupported effort "${effort}"`, { code: "agy_invalid_effort" });
  const level = effort as AcpEffort;
  if (catalog.thinking) {
    // 1.4 applies thinking through its own session option, not a model id.
    if (catalog.thinking.values.length && !catalog.thinking.values.includes(level)) {
      throw new AgyError("invalid_request", `Antigravity did not advertise effort "${level}" for "${raw}"`, { code: "agy_invalid_effort", details: { available: catalog.thinking.values } });
    }
    return { requestedModel: raw, acpModel: model.acpModel, effort: level };
  }
  const variant = model.variants?.[level];
  if (variant) return { requestedModel: raw, acpModel: variant.acpModel };
  const sibling = model.family && catalog.exactModels.find((entry) => entry.family === model.family && entry.effort === level);
  if (sibling) return { requestedModel: raw, acpModel: sibling.acpModel };
  if (model.effort === level) return { requestedModel: raw, acpModel: model.acpModel };
  throw new AgyError("invalid_request", `Antigravity did not advertise effort "${level}" for "${raw}"`, { code: "agy_invalid_effort" });
}

export function providerModelEntries(catalog: AcpModelCatalog): AcpModel[] { return catalog.models; }

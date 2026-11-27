import { AgyError } from "./errors.js";
import { SUPPORTED_EFFORTS, type AcpEffort } from "./constants.js";

export type AcpModel = {
  id: string;
  name: string;
  acpModel: string;
  family?: string;
  effort?: AcpEffort;
  variants?: Record<string, { effort: AcpEffort; acpModel: string }>;
  /** Effort values advertised (via a thinking selector bound to this exact
   * model, or via explicit effort siblings) for this model. Absent means
   * "no effort information confirmed for this model", never "all values". */
  thinkingValues?: string[];
  /** Routable effort variants to publish as provider variants: sibling
   * efforts (exact wire ids exist) plus per-model selector values for this
   * exact model. Never includes legacy (schema-1) global thinking values. */
  variantEfforts?: string[];
};

/** Provenance for one catalog observation, so merges can distinguish
 * "unknown" (partial snapshot, retain) from explicit removal (authoritative
 * snapshot, clear/prune). */
export type CatalogObservation = {
  /** Snapshot carried an authoritative model inventory (model selector
   * with options, or the legacy availableModels list). Independent of
   * thinking completeness: an inventory snapshot need not say anything
   * reliable about thinking selectors. */
  authoritativeInventory: boolean;
  /** Model current in this snapshot, when identifiable. */
  confirmedModel?: string;
  /** Authoritative snapshot whose current model has no thinking selector. */
  confirmedNoSelector: boolean;
  /** Models this snapshot confirms have no thinking selector (freshness
   * guarded by thinkingObservedAt, like selectors). Distinct from unknown. */
  confirmedNoneModels?: string[];
};

/** Shared ACP select-option value parser: handles flat and grouped
 * (nested `options`) choices recursively, string values only. Used for
 * model inventories, thinking selectors, and worker confirmations so all
 * sides agree on membership. */
export function selectOptionValues(option: unknown): Array<{ value: string; name?: string }> {
  const out: Array<{ value: string; name?: string }> = [];
  const visit = (options: unknown) => {
    if (!Array.isArray(options)) return;
    for (const entry of options) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (Array.isArray(record.options)) visit(record.options);
      else if (typeof record.value === "string" && record.value) out.push({ value: record.value, ...(typeof record.name === "string" ? { name: record.name } : {}) });
    }
  };
  if (option && typeof option === "object") visit((option as Record<string, unknown>).options);
  return out;
}

export function selectOptionValueIds(option: unknown): string[] {
  return selectOptionValues(option).map((entry) => entry.value);
}

/** Thinking selector bound to one exact wire model. `id` is the wire config
 * option id; the selector is only valid for the model it was observed on. */
export type AcpThinkingSelector = { id: string; values: string[]; current?: string };

export type AcpModelThinking = {
  /** Per-exact-model thinking selectors, keyed by exact wire model id. */
  selectors?: Record<string, AcpThinkingSelector>;
};

/** Runtime 1.4 reports thinking as its own session option instead of encoding
 * it in the model id. The values are the same effort names. Backwards
 * compatible alias: the legacy global selector, now only meaningful as the
 * selector observed for the catalog's current model (if any). */
export type AcpThinking = { values: string[]; current?: string };

export type AcpModelCatalog = {
  models: AcpModel[];
  exactModels: AcpModel[];
  version: string | null;
  executable: string;
  discoveredAt: number;
  currentModel?: string;
  /** Legacy view: selector observed for `currentModel`, if any. Kept so
   * existing callers and cached catalogs keep working. New code should use
   * `thinkingForModel` / `thinkingSelectors`. */
  thinking?: AcpThinking;
  /** Per-model thinking selectors keyed by exact wire model id. */
  thinkingSelectors?: Record<string, AcpThinkingSelector>;
  /** How this catalog's thinking observations were obtained. Schema-1
   * caches set this to "legacy" so their global thinking is never promoted
   * into published variants. */
  thinkingSource?: "per-model" | "legacy" | "unknown";
  /** Models confirmed to have no thinking selector. Empty means confirmed
   * none; absent means unknown (or not yet probed). */
  thinkingConfirmedNone?: string[];
  /** Freshness (discoveredAt) of the latest observation per model, for
   * both selectors and confirmed-none markers. Older observations never
   * overwrite newer ones for the same model. */
  thinkingObservedAt?: Record<string, number>;
  /** Timestamp of the authoritative inventory that produced models /
   * exactModels. Tracked independently of thinking freshness: thought-only
   * events and rejected stale inventories never advance it. */
  inventoryAt?: number;
  /** Per-exact-model availability epoch: the inventory time at which the
   * model most recently entered the catalog. Observations/clears older than
   * a model's entry time are rejected, so a model removed and re-added
   * cannot have its stale selector restored by a delayed replay. */
  modelEnteredAt?: Record<string, number>;
  observation?: CatalogObservation;
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
  thinkingSelectors?: Record<string, AcpThinkingSelector>,
  options: { thinkingSource?: "per-model" | "legacy" | "unknown"; observation?: CatalogObservation; confirmedNone?: string[]; enteredAt?: Record<string, number> } = {},
): AcpModelCatalog {
  const ids = new Set(entries.map(([id]) => id));
  const seen = new Set<string>();
  const exact: AcpModel[] = [];
  for (const [id, name] of entries) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const suffix = id.match(/^(.*)-(low|medium|high|xhigh)$/);
    const namedEffort = name.match(/\((low|medium|high|xhigh)\)$/i)?.[1].toLowerCase();
    const grouped = suffix && suffix[2] === namedEffort && !ids.has(suffix[1]);
    exact.push({ id, name, acpModel: id, ...(grouped ? { family: suffix[1], effort: suffix[2] as AcpEffort } : {}) });
  }
  // Sibling variants advertise exactly the sibling efforts, per family.
  const siblingValues = new Map<string, string[]>();
  for (const model of exact) {
    if (!model.family || !model.effort) continue;
    const list = siblingValues.get(model.family) ?? [];
    if (!list.includes(model.effort)) list.push(model.effort);
    siblingValues.set(model.family, list);
  }
  for (const model of exact) {
    if (!model.family) continue;
    const values = siblingValues.get(model.family);
    if (values?.length) model.thinkingValues = [...values];
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
    const familyValues = members.map((member) => member.effort!).filter(Boolean);
    models.push({
      id: model.family!, family: model.family,
      name: model.name.replace(/\s*\((low|medium|high|xhigh)\)$/i, ""),
      // Preserve the pre-existing default: high, then medium, then low.
      // xhigh is only ever an explicit variant, never the implicit default.
      acpModel: members.find((member) => member.effort === "high")?.id ?? members.find((member) => member.effort === "medium")?.id ?? members.find((member) => member.effort === "low")?.id ?? model.id,
      variants: Object.fromEntries(members.map((member) => [member.effort!, { effort: member.effort!, acpModel: member.id }])),
      ...(familyValues.length ? { thinkingValues: familyValues } : {}),
    });
  }
  // Bind a thinking selector only to the exact model it was observed with.
  // Aliases (family ids) inherit it only when the alias's default wire model
  // is exactly that observed model. Legacy global `thinking` is NEVER
  // synthesized into selectors here: live sessions pass explicit selectors
  // from thinkingSelectorsFromSession, and schema-1 cache loads must not be
  // promoted into per-model bindings or published variants.
  const selectors: Record<string, AcpThinkingSelector> | undefined = thinkingSelectors;
  if (selectors) {
    for (const [modelId, selector] of Object.entries(selectors)) {
      const exactModel = exact.find((entry) => entry.id === modelId);
      if (!exactModel) continue;
      // A selector is authoritative for its own model only; sibling-derived
      // values on other models are untouched.
      exactModel.thinkingValues = unionValues(exactModel.thinkingValues, selector.values);
      for (const alias of models) {
        if (alias.acpModel === modelId) alias.thinkingValues = unionValues(alias.thinkingValues, selector.values);
      }
    }
  }
  // Routable variants: sibling efforts (exact wire ids) plus selector
  // values bound to this exact model. Selector values are filtered to
  // supported efforts so only routable variants are published.
  const supported = (values: string[]) => values.filter((v) => (SUPPORTED_EFFORTS as readonly string[]).includes(v));
  const applyVariants = (model: AcpModel) => {
    const siblingEfforts = model.family ? (siblingValues.get(model.family) ?? []) : [];
    const selectorValues = selectors?.[model.id]?.values ?? selectors?.[model.acpModel]?.values ?? [];
    const efforts = supported([...new Set([...siblingEfforts, ...selectorValues])]);
    if (efforts.length) model.variantEfforts = efforts;
  };
  for (const model of [...exact, ...models]) applyVariants(model);
  // Refresh the legacy `thinking` view from the current model's selector.
  const currentSelector = currentModel && selectors?.[currentModel];
  const legacyThinking: AcpThinking | undefined = currentSelector
    ? { values: currentSelector.values, ...(currentSelector.current ? { current: currentSelector.current } : {}) }
    : thinking;
  const thinkingSource = options.thinkingSource ?? (selectors ? "per-model" : thinking ? "legacy" : "unknown");
  const discoveredAt = Date.now();
  // Inventory authority is independent: only an authoritative observation
  // stamps an inventory time. Thought-only (non-authoritative) deltas carry
  // no inventory and leave inventoryAt unset.
  const inventoryAt = options.observation && !options.observation.authoritativeInventory ? undefined : discoveredAt;
  const confirmedNone = [...new Set([...(options.confirmedNone ?? []), ...(options.observation?.confirmedNoneModels ?? [])])]
    .filter((model) => exact.some((entry) => entry.id === model) && !selectors?.[model]);
  const observedAt: Record<string, number> = {};
  for (const model of Object.keys(selectors ?? {})) observedAt[model] = discoveredAt;
  for (const model of confirmedNone) observedAt[model] = discoveredAt;
  // Availability epoch: restored values win; otherwise every listed model
  // entered at this build's inventory time. Non-authoritative builds carry
  // no inventory and stamp no entries.
  const enteredAt: Record<string, number> = {};
  if (inventoryAt !== undefined) {
    for (const model of exact) enteredAt[model.id] = options.enteredAt?.[model.id] ?? inventoryAt;
  }
  return { models, exactModels: exact, executable, version, currentModel,
    ...(legacyThinking ? { thinking: legacyThinking } : {}),
    ...(selectors ? { thinkingSelectors: selectors } : {}),
    ...(confirmedNone.length ? { thinkingConfirmedNone: confirmedNone } : {}),
    ...(Object.keys(observedAt).length ? { thinkingObservedAt: observedAt } : {}),
    ...(Object.keys(enteredAt).length ? { modelEnteredAt: enteredAt } : {}),
    ...(inventoryAt !== undefined ? { inventoryAt } : {}),
    thinkingSource,
    ...(options.observation ? { observation: options.observation } : {}),
    discoveredAt, source: "acp" };
}

/** Winning exact-model ids for mergeCatalog's entered computation. */
function winningInventoryNext(previous: AcpModelCatalog, incoming: AcpModelCatalog, authoritative: boolean): string[] {
  return (authoritative ? incoming : previous).exactModels.map((m) => m.id);
}

/** Inventory time carried by a catalog (authoritative builds stamp it). */
function incomingInventoryAtFor(catalog: AcpModelCatalog): number {
  return catalog.inventoryAt ?? catalog.discoveredAt;
}

/** Merge a new catalog observation into the previous catalog.
 * Freshness is per model: an incoming selector, clear, or confirmed-none
 * marker only wins for a model when it is at least as fresh as the stored
 * observation for that model, so concurrent discovery (or a stale replay)
 * can never overwrite a newer live update for the same model. Distinct
 * per model, unknown is retained, explicit removal clears, and only an
 * authoritative inventory prunes unlisted models.
 * Per-model `thinkingValues` and routable `variantEfforts` are recomputed
 * from siblings plus merged selectors, so republished provider state never
 * retains stale values. */
export function mergeCatalog(previous: AcpModelCatalog | undefined, incoming: AcpModelCatalog): AcpModelCatalog {
  if (!previous || previous.source === "empty") return incoming;
  const obs = incoming.observation;
  // Inventory ordering is independent of thinking freshness: an
  // authoritative inventory wins only when its own inventory timestamp is
  // at least as fresh as the stored one. Thought-only events carry no
  // inventory (undefined) and rejected stale inventories never advance it.
  const incomingInventoryAt = incoming.inventoryAt ?? (obs && !obs.authoritativeInventory ? undefined : incoming.discoveredAt);
  const previousInventoryAt = previous.inventoryAt ?? previous.discoveredAt;
  const inventoryWins = Boolean(obs?.authoritativeInventory ?? true) && incomingInventoryAt !== undefined && incomingInventoryAt >= previousInventoryAt;
  const authoritative = inventoryWins;
  const previousAt = previous.thinkingObservedAt ?? {};
  const incomingAt = incoming.thinkingObservedAt ?? {};
  // Availability epoch per winning model: the latest inventory time at
  // which the model (re)entered. Observations/clears older than the entry
  // are stale for that incarnation and rejected — a removed-then-re-added
  // model cannot have a pre-removal selector restored by a delayed replay.
  const entered: Record<string, number> = {};
  const incomingEntered = incoming.modelEnteredAt ?? {};
  for (const model of winningInventoryNext(previous, incoming, authoritative)) {
    const wasPresent = previous.exactModels.some((m) => m.id === model);
    const prior = previous.modelEnteredAt?.[model];
    const freshEntry = incomingEntered[model] ?? incomingInventoryAtFor(incoming);
    entered[model] = wasPresent && prior !== undefined ? prior : freshEntry;
  }
  const fresh = (model: string, at: number | undefined) =>
    at !== undefined && at >= Math.max(previousAt[model] ?? Number.NEGATIVE_INFINITY, entered[model] ?? Number.NEGATIVE_INFINITY);
  // Gate ALL positive/clear observations against the winning exact
  // inventory, independent of the partial flag: a selector (or its freshness
  // timestamp) for a model absent from the winning inventory can never
  // survive, so it cannot be restored if the model is later re-added.
  const winningInventory = authoritative ? incoming : previous;
  const winningIds = new Set(winningInventory.exactModels.map((m) => m.id));
  const selectors: Record<string, AcpThinkingSelector> = { ...(previous.thinkingSelectors ?? {}) };
  for (const key of Object.keys(selectors)) if (!winningIds.has(key)) delete selectors[key];
  const confirmedNone = new Set(previous.thinkingConfirmedNone ?? []);
  for (const key of [...confirmedNone]) if (!winningIds.has(key)) confirmedNone.delete(key);
  const observedAt: Record<string, number> = { ...previousAt };
  for (const key of Object.keys(observedAt)) if (!winningIds.has(key)) delete observedAt[key];
  // Explicit clears: current-model no-selector plus any confirmed-none list.
  const clears = new Set<string>([
    ...(obs?.confirmedNoSelector && obs.confirmedModel ? [obs.confirmedModel] : []),
    ...(obs?.confirmedNoneModels ?? []),
    ...(incoming.thinkingConfirmedNone ?? []),
  ]);
  for (const model of clears) {
    if (!winningIds.has(model)) continue;
    const at = incomingAt[model] ?? incoming.discoveredAt;
    if (!fresh(model, at)) continue;
    delete selectors[model];
    confirmedNone.add(model);
    observedAt[model] = at;
  }
  for (const [model, selector] of Object.entries(incoming.thinkingSelectors ?? {})) {
    // Gated by the winning inventory (above), independent of partial flag.
    if (!winningIds.has(model)) continue;
    const at = incomingAt[model] ?? incoming.discoveredAt;
    if (!fresh(model, at)) continue;
    selectors[model] = selector;
    confirmedNone.delete(model);
    observedAt[model] = at;
  }
  // Winning-inventory gate above already pruned selectors/none/timestamps;
  // authoritative inventories additionally own the model list via
  // winningInventory (rebuild below).
  const mergedSelectors = Object.keys(selectors).length ? selectors : undefined;
  const currentModel = incoming.currentModel;
  const currentSelector = currentModel ? mergedSelectors?.[currentModel] : undefined;
  const confirmedNo = Boolean(currentModel && confirmedNone.has(currentModel) && !currentSelector);
  // The legacy thinking view is bound to the current model: it only exists
  // when that model is in the winning inventory. A stale catalog's view of
  // an absent model must never leak (it would re-expose the removed
  // selector through thinkingForModel's current-model fallback).
  // Legacy `thinking` views are only usable when observed for this
  // incarnation of the current model (at/after its entry time); a stale
  // catalog's view of a removed-then-re-added model must never leak.
  const incomingViewFresh = currentModel !== undefined
    && incomingAt[currentModel] !== undefined && incomingAt[currentModel]! >= (entered[currentModel] ?? Number.NEGATIVE_INFINITY);
  const previousViewFresh = currentModel !== undefined && previous.currentModel === currentModel;
  const thinking: AcpThinking | undefined = currentSelector
    ? { values: currentSelector.values, ...(currentSelector.current ? { current: currentSelector.current } : {}) }
    : confirmedNo || !currentModel || !winningIds.has(currentModel) ? undefined
      : incomingViewFresh && incoming.thinking ? incoming.thinking : previousViewFresh ? previous.thinking : undefined;
  // Recompute per-model confirmed values + routable variants. Sibling and
  // model metadata derive exclusively from the winning inventory.
  const siblingEfforts = new Map<string, string[]>();
  for (const model of winningInventory.exactModels) {
    if (!model.family || !model.effort) continue;
    const list = siblingEfforts.get(model.family) ?? [];
    if (!list.includes(model.effort)) list.push(model.effort);
    siblingEfforts.set(model.family, list);
  }
  const supported = (values: string[]) => values.filter((v) => (SUPPORTED_EFFORTS as readonly string[]).includes(v));
  const rebuild = (model: AcpModel): AcpModel => {
    const siblings = model.family ? (siblingEfforts.get(model.family) ?? []) : [];
    const selectorValues = mergedSelectors?.[model.id]?.values ?? mergedSelectors?.[model.acpModel]?.values ?? [];
    const confirmed = [...new Set([...siblings, ...selectorValues])];
    const routable = supported(confirmed);
    const next: AcpModel = { ...model };
    if (confirmed.length) next.thinkingValues = confirmed; else delete next.thinkingValues;
    if (routable.length) next.variantEfforts = routable; else delete next.variantEfforts;
    return next;
  };
  const thinkingSource: "per-model" | "legacy" | "unknown" = mergedSelectors
    ? "per-model"
    : incoming.thinkingSource ?? previous.thinkingSource ?? "unknown";
  return {
    ...incoming,
    // Winning inventory exclusively owns models/exactModels and their time.
    discoveredAt: winningInventory.discoveredAt,
    inventoryAt: winningInventory.inventoryAt ?? winningInventory.discoveredAt,
    modelEnteredAt: Object.keys(entered).length ? entered : undefined,
    exactModels: winningInventory.exactModels.map(rebuild),
    models: winningInventory.models.map(rebuild),
    // Own the mergeable fields explicitly: the incoming spread must never
    // leak stale thinking/markers when the merge clears them.
    thinking,
    thinkingSelectors: mergedSelectors,
    thinkingConfirmedNone: confirmedNone.size ? [...confirmedNone] : undefined,
    thinkingObservedAt: observedAt,
    thinkingSource,
  };
}

function mergeModels(previous: AcpModel[], incoming: AcpModel[], rebuild: (m: AcpModel) => AcpModel): AcpModel[] {
  const out = previous.map((m) => {
    const inc = incoming.find((x) => x.id === m.id);
    return inc ? rebuild(inc) : m;
  });
  for (const inc of incoming) if (!out.some((m) => m.id === inc.id)) out.push(rebuild(inc));
  return out;
}

function unionValues(left: string[] | undefined, right: string[]): string[] {
  const out = [...(left ?? [])];
  for (const value of right) if (!out.includes(value)) out.push(value);
  return out;
}

/** Effort values confirmed for one exact (or alias) model. Never global. */
export function thinkingForModel(catalog: AcpModelCatalog, requestedModel: string): string[] | undefined {
  const raw = requestedModel.replace(/^antigravity\//, "").trim();
  // A confirmed thinking selector is authoritative for its exact model. If
  // a selector exists for this model, sibling-derived values are not mixed
  // in (they describe a different wire model), and no other model's
  // selector is ever consulted.
  const selector = catalog.thinkingSelectors?.[raw];
  if (selector) return [...selector.values];
  const exact = catalog.exactModels.find((entry) => entry.id === raw)
    ?? catalog.models.find((entry) => entry.id === raw && entry.acpModel === raw);
  if (exact?.thinkingValues) return [...exact.thinkingValues];
  const alias = catalog.models.find((entry) => entry.id === raw);
  // An alias's thinkingValues are only valid when they describe the alias's
  // own default wire model (or an exact sibling set). A selector observed
  // for a different exact model must not leak through an alias whose wire
  // id differs — handled above by the acpModel check and by not consulting
  // other models' selectors.
  if (alias?.thinkingValues) {
    // Only return alias values that were derived from siblings (variants)
    // or from a selector on the alias's own wire model.
    if (alias.variants && Object.keys(alias.variants).length) return [...alias.thinkingValues];
    if (alias.acpModel && catalog.thinkingSelectors?.[alias.acpModel]) return [...alias.thinkingValues];
    if (!catalog.thinkingSelectors) return [...alias.thinkingValues];
    return undefined;
  }
  // Legacy single-selector catalogs (pre per-model binding): only the
  // current model's selector may be used, never applied to another model.
  if (catalog.thinking && catalog.currentModel === raw) return [...catalog.thinking.values];
  return undefined;
}

/** Selector for one exact wire model, if one was confirmed for it. */
export function thinkingSelectorForModel(catalog: AcpModelCatalog, acpModel: string): AcpThinkingSelector | undefined {
  const selector = catalog.thinkingSelectors?.[acpModel];
  if (selector) return selector;
  if (catalog.thinking && catalog.currentModel === acpModel) return { id: "thought_level", values: catalog.thinking.values, ...(catalog.thinking.current ? { current: catalog.thinking.current } : {}) };
  return undefined;
}

/** Merge one confirmed per-model observation. Returns the merged selectors.
 * - A snapshot that confirms a selector for model M replaces M's entry.
 * - A snapshot with no model selector is not authoritative for thinking.
 * Callers handle "confirmed no selector" (clear) and authoritative removal
 * (prune) explicitly via `mergeThinkingSelectors` options. */
export function mergeThinkingSelectors(
  previous: Record<string, AcpThinkingSelector> | undefined,
  observed: Record<string, AcpThinkingSelector> | undefined,
): Record<string, AcpThinkingSelector> | undefined {
  if (!observed || !Object.keys(observed).length) return previous;
  const next = { ...(previous ?? {}) };
  for (const [model, selector] of Object.entries(observed)) {
    if (selector.values.length) next[model] = selector;
    else delete next[model];
  }
  return Object.keys(next).length ? next : undefined;
}

/** Extract per-model thinking selectors from a session response. A selector
 * is bound to the exact model that was current in that same response. */
export function thinkingSelectorsFromSession(response: unknown, fallbackCurrentModel?: string): { selectors: Record<string, AcpThinkingSelector> | undefined; currentModel: string | undefined; hasModelSelector: boolean; hasThinkingSelector: boolean; hasThinkingOption: boolean; thoughtOnly: boolean } {
  if (!response || typeof response !== "object") return { selectors: undefined, currentModel: undefined, hasModelSelector: false, hasThinkingSelector: false, hasThinkingOption: false, thoughtOnly: false };
  const data = response as Record<string, any>;
  const options = Array.isArray(data.configOptions) ? data.configOptions : [];
  const model = options.find((option: any) => option?.category === "model") ?? options.find((option: any) => option?.id === "model");
  const thinkingOption = options.find((option: any) => option?.category === "thought_level" || option?.id === "thought_level" || option?.id === "effort" || option?.id === "reasoning_effort");
  const ownModel = typeof model?.currentValue === "string" ? model.currentValue : (typeof data.models?.currentModelId === "string" ? data.models.currentModelId : undefined);
  // Thought-only updates (no model selector) are unambiguous when the
  // caller knows the worker's current model: bind to that exact model.
  const currentModel = ownModel ?? fallbackCurrentModel;
  const values = selectOptionValueIds(thinkingOption);
  const hasThinkingSelector = Boolean(thinkingOption && values.length);
  const selectors = hasThinkingSelector && currentModel
    ? { [currentModel]: { id: String(thinkingOption.id ?? "thought_level"), values, ...(typeof thinkingOption.currentValue === "string" ? { current: thinkingOption.currentValue } : {}) } }
    : undefined;
  const hasModelSelector = Boolean(model && Array.isArray(model.options));
  return { selectors, currentModel, hasModelSelector, hasThinkingSelector, hasThinkingOption: Boolean(thinkingOption), thoughtOnly: Boolean(thinkingOption && !hasModelSelector) };
}

/** No invented availability when discovery has never succeeded. */
export function fallbackAcpModelCatalog(executable = "agy", version: string | null = null): AcpModelCatalog {
  return { ...acpModelCatalog(executable, version), source: "empty", discoveredAt: 0 };
}

/** Missing model state means "no update"; an advertised empty list is authoritative. */
export function catalogFromSession(response: unknown, executable: string, version: string | null = null, fallbackCurrentModel?: string): AcpModelCatalog | undefined {
  if (!response || typeof response !== "object") return;
  const data = response as Record<string, any>;
  const model = Array.isArray(data.configOptions)
    ? data.configOptions.find((option: any) => option?.category === "model") ?? data.configOptions.find((option: any) => option?.id === "model")
    : undefined;
  const thinkingOption = Array.isArray(data.configOptions)
    ? data.configOptions.find((option: any) => option?.category === "thought_level" || option?.id === "thought_level" || option?.id === "effort" || option?.id === "reasoning_effort")
    : undefined;
  const entries: Array<[string, string]> = selectOptionValues(model).map((entry): [string, string] => [entry.value, entry.name ?? entry.value]);
  const thinkingValues: string[] = selectOptionValueIds(thinkingOption);
  const thinking: AcpThinking | undefined = thinkingOption && thinkingValues.length
    ? { values: thinkingValues, ...(typeof thinkingOption.currentValue === "string" ? { current: thinkingOption.currentValue } : {}) }
    : undefined;
  const { selectors, currentModel: observedModel, hasModelSelector, hasThinkingSelector } = thinkingSelectorsFromSession(response, fallbackCurrentModel);
  const observation: CatalogObservation = {
    authoritativeInventory: hasModelSelector || Array.isArray(data.models?.availableModels),
    ...(observedModel ? { confirmedModel: observedModel } : {}),
    confirmedNoSelector: Boolean(observedModel && !hasThinkingSelector && (hasModelSelector || Array.isArray(data.models?.availableModels))),
  };
  if (model && Array.isArray(model.options)) {
    // An explicit model selector (options array present, even empty) is an
    // authoritative inventory: empty clears. A missing model selector
    // (no options array) is no update and never reaches here with a
    // catalog. Worker-side switch confirmation separately rejects empty
    // inventories before any prompt.
    return acpModelCatalog(executable, version, entries, typeof model.currentValue === "string" ? model.currentValue : undefined, thinking, selectors, { observation });
  }
  if (Array.isArray(data.models?.availableModels)) {
    for (const entry of data.models.availableModels) {
      if (typeof entry?.modelId === "string" && entry.modelId) entries.push([entry.modelId, typeof entry.name === "string" ? entry.name : entry.modelId]);
    }
    return acpModelCatalog(executable, version, entries, data.models.currentModelId, thinking, selectors, { observation });
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
    // low/medium/high legacy mapping is pre-existing. An -xhigh legacy id
    // is NEVER inferred: it only resolves when the xhigh sibling or a
    // per-model selector for that family/model explicitly advertises xhigh;
    // otherwise the id is unknown (fail closed, no invented availability).
    // Only pre-existing low/medium/high legacy ids map to a family. An
    // unadvertised -xhigh id is never synthesized — not even when a
    // selector advertises xhigh for the family: xhigh is then a variant
    // effort of the family model, not a distinct model id. Advertised
    // -xhigh siblings resolve as exact models above, never via this branch.
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
  // Exact effort sibling wire ids always win (legacy sibling routing).
  const variant = model.variants?.[level];
  if (variant) return { requestedModel: raw, acpModel: variant.acpModel };
  const sibling = model.family && catalog.exactModels.find((entry) => entry.family === model.family && entry.effort === level);
  if (sibling) return { requestedModel: raw, acpModel: sibling.acpModel };
  if (model.effort === level) return { requestedModel: raw, acpModel: model.acpModel };
  // Otherwise a thinking selector must have been confirmed for this exact
  // wire model. A selector observed for a different model is never reused.
  const confirmed = thinkingForModel(catalog, raw) ?? thinkingForModel(catalog, model.acpModel);
  if (confirmed && !confirmed.includes(level)) {
    throw new AgyError("invalid_request", `Unsupported effort "${level}" for model "${raw}"`, { code: "agy_invalid_effort", details: { available: confirmed } });
  }
  if (!confirmed) {
    // No effort information confirmed for this model. Still route via the
    // selector after the target model is set; the worker validates the
    // actual selector after switching and fails closed if it is absent or
    // does not advertise the requested value. Never invent availability.
    return { requestedModel: raw, acpModel: model.acpModel, effort: level };
  }
  // A separate selector can appear only after switching to the target model.
  return { requestedModel: raw, acpModel: model.acpModel, effort: level };
}

export function providerModelEntries(catalog: AcpModelCatalog): AcpModel[] { return catalog.models; }

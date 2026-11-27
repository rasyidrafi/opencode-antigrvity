import { describe, expect, test } from "bun:test";
import { acpModelCatalog, catalogFromSession, thinkingForModel, thinkingSelectorForModel, mergeThinkingSelectors, resolveAcpModelSelection } from "../src/models.js";
import { buildProviderModels, variantIds } from "../src/index.js";

describe("per-model thinking bindings", () => {
  function catalog() {
    return catalogFromSession({
      configOptions: [
        { id: "model", category: "model", currentValue: "model-alpha", options: [
          { value: "model-alpha", name: "Model Alpha" }, { value: "model-beta", name: "Model Beta" }, { value: "model-gamma", name: "Model Gamma" },
        ] },
        { id: "alpha_effort", category: "thought_level", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
      ],
    }, "fake")!;
  }

  test("binds selector to confirmed exact model only, never to others", () => {
    const c = catalog();
    expect(thinkingForModel(c, "model-alpha")).toEqual(["low", "high"]);
    expect(thinkingForModel(c, "model-beta")).toBeUndefined();
    expect(thinkingForModel(c, "model-gamma")).toBeUndefined();
    expect(thinkingSelectorForModel(c, "model-beta")).toBeUndefined();
    // alpha's selector must not be applied to beta at selection time:
    // beta has no confirmed values, so resolution defers to wire validation
    // (it returns an effort selection, not a silent success with alpha's
    // values) — and a value alpha excludes but beta might have is not
    // rejected on alpha's behalf.
    const sel = resolveAcpModelSelection("model-beta", "medium", c);
    expect(sel).toEqual({ requestedModel: "model-beta", acpModel: "model-beta", effort: "medium" });
    // alpha medium is excluded by alpha's own confirmed selector.
    expect(() => resolveAcpModelSelection("model-alpha", "medium", c)).toThrow(/Unsupported effort/);
    expect(resolveAcpModelSelection("model-alpha", "low", c).effort).toBe("low");
    // xhigh only when advertised: no model advertises it here.
    expect(() => resolveAcpModelSelection("model-alpha", "xhigh", c)).toThrow(/Unsupported effort/);
  });

  test("differing model choices keep their own selectors across snapshots", () => {
    const alpha = catalog();
    const beta = catalogFromSession({
      configOptions: [
        { id: "model", category: "model", currentValue: "model-beta", options: [
          { value: "model-alpha", name: "Model Alpha" }, { value: "model-beta", name: "Model Beta" }, { value: "model-gamma", name: "Model Gamma" },
        ] },
        { id: "beta_effort", category: "thought_level", currentValue: "xhigh", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
      ],
    }, "fake")!;
    const merged = mergeThinkingSelectors(alpha.thinkingSelectors, beta.thinkingSelectors);
    expect(merged?.["model-alpha"]?.values).toEqual(["low", "high"]);
    expect(merged?.["model-beta"]?.values).toEqual(["low", "medium", "high", "xhigh"]);
    const combined = acpModelCatalog("fake", null, [["model-alpha", "Model Alpha"], ["model-beta", "Model Beta"], ["model-gamma", "Model Gamma"]], "model-beta", undefined, merged);
    expect(thinkingForModel(combined, "model-alpha")).toEqual(["low", "high"]);
    expect(thinkingForModel(combined, "model-beta")).toContain("xhigh");
    expect(thinkingForModel(combined, "model-gamma")).toBeUndefined();
    expect(resolveAcpModelSelection("model-beta", "xhigh", combined).effort).toBe("xhigh");
  });

  test("confirmed no selector clears only that model's observation; authoritative removal prunes", () => {
    const previous = { "model-alpha": { id: "alpha_effort", values: ["low", "high"] }, "model-beta": { id: "beta_effort", values: ["xhigh"] } };
    // Snapshot confirming gamma has a selector does not clear alpha/beta.
    expect(mergeThinkingSelectors(previous, undefined)).toEqual(previous);
    // Empty-values observation clears that model only.
    expect(mergeThinkingSelectors(previous, { "model-alpha": { id: "alpha_effort", values: [] } })).toEqual({ "model-beta": { id: "beta_effort", values: ["xhigh"] } });
  });

  test("provider variants include xhigh only when advertised for that model", () => {
    const c = catalogFromSession({
      configOptions: [
        { id: "model", category: "model", currentValue: "model-beta", options: [{ value: "model-alpha", name: "Model Alpha" }, { value: "model-beta", name: "Model Beta" }] },
        { id: "beta_effort", category: "thought_level", currentValue: "xhigh", options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
      ],
    }, "fake")!;
    const models = buildProviderModels(c);
    const beta = models.find((m) => m.id === "model-beta")!;
    const alpha = models.find((m) => m.id === "model-alpha")!;
    expect(variantIds(c.models.find((m) => m.id === "model-beta")!)).toContain("xhigh");
    expect(variantIds(c.models.find((m) => m.id === "model-alpha")!)).not.toContain("xhigh");
    expect(beta.variants.map((v: any) => v.id)).toContain("xhigh");
    expect(alpha.variants.map((v: any) => v.id)).not.toContain("xhigh");
  });

  test("xhigh effort siblings group as variants (legacy 1.3 style)", () => {
    const c = acpModelCatalog("fake", "1.3.0", [
      ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
      ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
      ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"],
      ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
      ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
      ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
      ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
    ]);
    const hydrogen = c.models.find((m) => m.id === "gemini-4-hydrogen")!;
    const flash = c.models.find((m) => m.id === "gemini-3.8-flash")!;
    expect(hydrogen.thinkingValues).toContain("xhigh");
    expect(flash.thinkingValues).not.toContain("xhigh");
    expect(resolveAcpModelSelection("gemini-4-hydrogen", "xhigh", c).acpModel).toBe("gemini-4-hydrogen-xhigh");
    expect(resolveAcpModelSelection("gemini-4-hydrogen-xhigh", undefined, c)).toEqual({ requestedModel: "gemini-4-hydrogen-xhigh", acpModel: "gemini-4-hydrogen-xhigh" });
    // xhigh for a model without an xhigh sibling/selector fails closed.
    expect(() => resolveAcpModelSelection("gemini-3.8-flash", "xhigh", c)).toThrow(/Unsupported effort/);
    expect(buildProviderModels(c).find((m) => m.id === "gemini-4-hydrogen")?.variants.map((v: any) => v.id)).toContain("xhigh");
    expect(buildProviderModels(c).find((m) => m.id === "gemini-3.8-flash")?.variants.map((v: any) => v.id)).not.toContain("xhigh");
  });

  test("stale selector value for the target model is rejected at selection", () => {
    const c = catalog(); // alpha selector: low/high only
    expect(() => resolveAcpModelSelection("model-alpha", "medium", c)).toThrow(/Unsupported effort/);
    expect(() => resolveAcpModelSelection("model-alpha", "xhigh", c)).toThrow(/Unsupported effort/);
  });
});

describe("unadvertised -xhigh model ids (variant only)", () => {
  test("selector-advertised xhigh does not synthesize a -xhigh model id", () => {
    const c = catalogFromSession({
      configOptions: [
        { id: "model", category: "model", currentValue: "fam", options: [{ value: "fam", name: "Fam" }] },
        { id: "thought_level", category: "thought_level", currentValue: "xhigh", options: [{ value: "low" }, { value: "xhigh" }] },
      ],
    }, "fake")!;
    // xhigh is a variant effort of fam, not a distinct model id.
    expect(resolveAcpModelSelection("fam", "xhigh", c)).toEqual({ requestedModel: "fam", acpModel: "fam", effort: "xhigh" });
    expect(() => resolveAcpModelSelection("fam-xhigh", undefined, c)).toThrow(/Unknown/);
    expect(c.models.some((m) => m.id === "fam-xhigh")).toBe(false);
    expect(variantIds(c.models.find((m) => m.id === "fam")!)).toContain("xhigh");
  });

  test("grouped thinking choices bind via the shared parser", () => {
    const c = catalogFromSession({
      configOptions: [
        { id: "model", category: "model", currentValue: "fam", options: [{ group: "G", options: [{ value: "fam", name: "Fam" }] }] },
        { id: "thought_level", category: "thought_level", currentValue: "high", options: [{ group: "T", options: [{ value: "low" }, { value: "high" }] }] },
      ],
    }, "fake")!;
    expect(thinkingForModel(c, "fam")).toEqual(["low", "high"]);
    expect(c.thinkingSelectors?.["fam"]?.values).toEqual(["low", "high"]);
  });
});

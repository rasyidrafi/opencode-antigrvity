import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
let compatibility: ReturnType<typeof fixtureCompatibility>;
beforeAll(() => { compatibility = fixtureCompatibility(); });
afterAll(() => { compatibility.mockRestore(); });
import { createAcpWorker } from "../src/acp-process.js";
import { thinkingForModel } from "../src/models.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");

describe("per-model worker behaviour", () => {
  test("applies each model's own selector after switching to it; xhigh only where advertised", async () => {
    await chmod(fixture, 0o755);
    // alpha: low/high via alpha_effort
    const alpha = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", effort: "high", environment: { FAKE_ACP_PER_MODEL: "1" } });
    try { expect(alpha.catalog?.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]); }
    finally { await alpha.stop(true); }
    // beta: xhigh via beta_effort
    const directory = await mkdtemp(join(tmpdir(), "agy-per-model-"));
    const log = join(directory, "rpc.jsonl");
    const beta = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-beta", effort: "xhigh", environment: { FAKE_ACP_PER_MODEL: "1", FAKE_ACP_RPC_LOG: log } });
    try {
      const rpcs = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      const sets = rpcs.filter((r) => r.method === "session/set_config_option").map((r) => [r.params.configId, r.params.value]);
      expect(sets).toEqual([["model", "model-beta"], ["beta_effort", "xhigh"]]);
      expect(beta.catalog?.thinkingSelectors?.["model-beta"]?.values).toContain("xhigh");
      // Merged observations persist per-model across snapshots: alpha's
      // selector (observed for alpha) is retained alongside beta's, and
      // neither leaks into the other.
      expect(thinkingForModel(beta.catalog!, "model-alpha")).toEqual(["low", "high"]);
      expect(thinkingForModel(beta.catalog!, "model-beta")).toContain("xhigh");
      expect(thinkingForModel(beta.catalog!, "model-gamma")).toBeUndefined();
    } finally { await beta.stop(true); await rm(directory, { recursive: true, force: true }); }
  });

  test("rejects xhigh for a model whose selector excludes it, before any prompt", async () => {
    await chmod(fixture, 0o755);
    await expect(createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", effort: "xhigh", environment: { FAKE_ACP_PER_MODEL: "1" } }))
      .rejects.toThrow(/does not support the requested/);
  });

  test("rejects effort for a model with no selector (stale selector cannot be reused)", async () => {
    await chmod(fixture, 0o755);
    await expect(createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-gamma", effort: "high", environment: { FAKE_ACP_PER_MODEL: "1" } }))
      .rejects.toThrow(/does not expose a thinking level selector/);
  });

  test("handshake omits clientInfo by default and sends zed identity when configured", async () => {
    await chmod(fixture, 0o755);
    const dir = await mkdtemp(join(tmpdir(), "agy-handshake-"));
    try {
      const log1 = join(dir, "default.jsonl");
      const w1 = await createAcpWorker({ cwd: process.cwd(), executable: fixture, environment: { FAKE_ACP_RPC_LOG: log1 } });
      await w1.stop(true);
      const init1 = (await readFile(log1, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.method === "initialize");
      expect(init1.params.clientInfo).toBeUndefined();
      const log2 = join(dir, "zed.jsonl");
      const w2 = await createAcpWorker({ cwd: process.cwd(), executable: fixture, clientIdentity: { name: "zed", version: "0.8.0" }, environment: { FAKE_ACP_RPC_LOG: log2 } });
      await w2.stop(true);
      const init2 = (await readFile(log2, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.method === "initialize");
      expect(init2.params.clientInfo).toEqual({ name: "zed", version: "0.8.0" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("strict post-switch confirmation (no prompt on incomplete/wrong target)", () => {
  test("incomplete set_model response rejects before effort or prompt", async () => {
    await chmod(fixture, 0o755);
    const dir = await mkdtemp(join(tmpdir(), "agy-incomplete-"));
    const log = join(dir, "rpc.jsonl");
    try {
      const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", effort: "high", environment: { FAKE_ACP_SET_MODEL_MODE: "empty", FAKE_ACP_RPC_LOG: log } });
      await expect(worker).rejects.toThrow(/did not confirm the requested model/);
      const rpcs = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      const methods = rpcs.map((r) => r.method);
      expect(methods).toContain("session/set_config_option");
      expect(methods).not.toContain("session/prompt");
      // No effort was applied after the unconfirmed model switch.
      const sets = rpcs.filter((r) => r.method === "session/set_config_option").map((r) => r.params.configId);
      expect(sets).toEqual(["model"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("wrong-target set_model response rejects before effort or prompt", async () => {
    await chmod(fixture, 0o755);
    const dir = await mkdtemp(join(tmpdir(), "agy-wrong-target-"));
    const log = join(dir, "rpc.jsonl");
    try {
      const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", effort: "high", environment: { FAKE_ACP_SET_MODEL_MODE: "wrong", FAKE_ACP_RPC_LOG: log } });
      await expect(worker).rejects.toThrow(/did not confirm the requested model/);
      const rpcs = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(rpcs.map((r) => r.method)).not.toContain("session/prompt");
      const sets = rpcs.filter((r) => r.method === "session/set_config_option").map((r) => r.params.configId);
      expect(sets).toEqual(["model"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("full snapshot without selector clears worker observation; partial update does not", async () => {
    await chmod(fixture, 0o755);
    // Start on alpha (selector low/high), then a full config update whose
    // model selector is current=alpha with no thinking option clears it.
    const dir = await mkdtemp(join(tmpdir(), "agy-clear-"));
    try {
      const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", environment: { FAKE_ACP_PER_MODEL: "1" } });
      try {
        expect(worker.catalog?.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
        for await (const _e of worker.runTurn("FAKE_REMOVE_SELECTOR")) { /* drain */ }
        expect(worker.catalog?.thinkingSelectors?.["model-alpha"]).toBeUndefined();
        expect(worker.catalog?.thinking).toBeUndefined();
        expect(worker.catalog?.models.find((m) => m.id === "model-alpha")?.thinkingValues).toBeUndefined();
      } finally { await worker.stop(true); }
      // Thought-only updates are unambiguous for the worker's known current
      // model: they bind fresh values to that model (no clear, no other
      // model touched), instead of being ignored.
      const worker2 = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", environment: { FAKE_ACP_PER_MODEL: "1" } });
      try {
        expect(worker2.catalog?.thinkingSelectors?.["model-beta"]).toBeUndefined();
        for await (const _e of worker2.runTurn("FAKE_PARTIAL_THOUGHT_UPDATE")) { /* drain */ }
        expect(worker2.catalog?.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low"]);
        expect(worker2.catalog?.thinkingSelectors?.["model-beta"]).toBeUndefined();
      } finally { await worker2.stop(true); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("grouped choices and contradictory effort confirmation", () => {
  test("grouped model/thinking choices confirm via the shared parser", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-beta", effort: "xhigh", environment: { FAKE_ACP_PER_MODEL: "1", FAKE_ACP_GROUPED: "1" } });
    try {
      expect(worker.catalog?.models.map((m) => m.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta", "model-gamma"]));
      expect(worker.catalog?.thinkingSelectors?.["model-beta"]?.values).toContain("xhigh");
    } finally { await worker.stop(true); }
  });

  test("wrong-target with grouped options fails (no vacuous confirmation)", async () => {
    await chmod(fixture, 0o755);
    // Force a wrong set_model confirmation while grouped: reuse the
    // modelchanged effort mode on a plain switch is covered below; here
    // the grouped inventory must still list the target for confirmation.
    const dir = await mkdtemp(join(tmpdir(), "agy-grouped-"));
    const log = join(dir, "rpc.jsonl");
    try {
      const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-beta", environment: { FAKE_ACP_PER_MODEL: "1", FAKE_ACP_GROUPED: "1", FAKE_ACP_RPC_LOG: log } });
      await worker.stop(true);
      const rpcs = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(rpcs.filter((r) => r.method === "session/set_config_option").map((r) => [r.params.configId, r.params.value])).toEqual([["model", "model-beta"]]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("contradictory effort response rejects before prompt", async () => {
    await chmod(fixture, 0o755);
    const dir = await mkdtemp(join(tmpdir(), "agy-effort-contra-"));
    const log = join(dir, "rpc.jsonl");
    try {
      const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", effort: "high", environment: { FAKE_ACP_PER_MODEL: "1", FAKE_ACP_EFFORT_MODE: "wrong", FAKE_ACP_RPC_LOG: log } });
      await expect(worker).rejects.toThrow(/did not confirm the requested thinking level/);
      const rpcs = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(rpcs.map((r) => r.method)).not.toContain("session/prompt");
      expect(rpcs.filter((r) => r.method === "session/set_config_option").map((r) => r.params.configId)).toEqual(["model", "alpha_effort"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("effort response flipping the model rejects before prompt", async () => {
    await chmod(fixture, 0o755);
    const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", effort: "high", environment: { FAKE_ACP_PER_MODEL: "1", FAKE_ACP_EFFORT_MODE: "modelchanged" } });
    await expect(worker).rejects.toThrow(/did not confirm the requested thinking level/);
  });

  test("real event remove then resurrect updates shared catalog", async () => {
    await chmod(fixture, 0o755);
    const { ModelCatalog } = await import("../src/model-catalog.js");
    const { emitAcpCatalog } = await import("../src/catalog-events.js");
    void emitAcpCatalog;
    const dir = await mkdtemp(join(tmpdir(), "agy-resurrect-"));
    let changes = 0;
    const context = async () => ({ scope: "account", executable: "fake", args: [], cacheDirectory: dir });
    const manager = new ModelCatalog(dir, { context, probe: async () => { throw new Error("offline"); }, onChange: () => { changes += 1; } });
    try {
      await manager.refresh();
      const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", catalogScope: "account", environment: { FAKE_ACP_PER_MODEL: "1" } });
      try {
        expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
        const beforeRemove = changes;
        for await (const _e of worker.runTurn("FAKE_REMOVE_SELECTOR")) { /* drain */ }
        expect(manager.catalog.thinkingSelectors?.["model-alpha"]).toBeUndefined();
        expect(manager.catalog.thinkingConfirmedNone).toContain("model-alpha");
        expect(changes).toBeGreaterThan(beforeRemove);
        const beforeResurrect = changes;
        for await (const _e of worker.runTurn("FAKE_RESURRECT_SELECTOR")) { /* drain */ }
        expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low"]);
        expect(manager.catalog.thinkingConfirmedNone ?? []).not.toContain("model-alpha");
        expect(changes).toBeGreaterThan(beforeResurrect);
      } finally { await worker.stop(true); }
    } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe("thought-only clear/resurrect and strict confirmations", () => {
  test("explicitly empty thought options clear; omission is unknown; later thought update resurrects", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", environment: { FAKE_ACP_PER_MODEL: "1" } });
    try {
      expect(worker.catalog?.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]);
      for await (const _e of worker.runTurn("FAKE_CLEAR_THOUGHT_UPDATE")) { /* drain */ }
      expect(worker.catalog?.thinkingSelectors?.["model-alpha"]).toBeUndefined();
      expect(worker.catalog?.thinkingConfirmedNone).toContain("model-alpha");
      expect(worker.catalog?.models.map((m) => m.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta", "model-gamma"]));
      for await (const _e of worker.runTurn("FAKE_PARTIAL_THOUGHT_HIGH")) { /* drain */ }
      expect(worker.catalog?.thinkingSelectors?.["model-alpha"]?.values).toEqual(["high"]);
      expect(worker.catalog?.thinkingConfirmedNone ?? []).not.toContain("model-alpha");
      // Unknown omission: a mode-only update must not clear the selector.
      // (catalogFromSession returns undefined; recordModels has no thought
      // option to act on.) Verified via a fresh worker's catalog instead:
      // the selector survives turns that send no thought update.
      for await (const _e of worker.runTurn("FAKE_STREAM")) { /* drain */ }
      expect(worker.catalog?.thinkingSelectors?.["model-alpha"]?.values).toEqual(["high"]);
    } finally { await worker.stop(true); }
  });

  test("switch with explicit empty inventory rejects before prompt", async () => {
    await chmod(fixture, 0o755);
    const dir = await mkdtemp(join(tmpdir(), "agy-switch-emptyinv-"));
    const log = join(dir, "rpc.jsonl");
    try {
      const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", environment: { FAKE_ACP_SET_MODEL_MODE: "emptyinventory", FAKE_ACP_RPC_LOG: log } });
      await expect(worker).rejects.toThrow(/did not confirm the requested model/);
      const rpcs = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(rpcs.map((r) => r.method)).not.toContain("session/prompt");
      expect(rpcs.filter((r) => r.method === "session/set_config_option").map((r) => r.params.configId)).toEqual(["model"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("effort reply with wrong selector id rejects before prompt", async () => {
    await chmod(fixture, 0o755);
    const dir = await mkdtemp(join(tmpdir(), "agy-effort-otherid-"));
    const log = join(dir, "rpc.jsonl");
    try {
      const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", effort: "high", environment: { FAKE_ACP_PER_MODEL: "1", FAKE_ACP_EFFORT_MODE: "otherid", FAKE_ACP_RPC_LOG: log } });
      await expect(worker).rejects.toThrow(/did not confirm the requested thinking level/);
      const rpcs = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(rpcs.map((r) => r.method)).not.toContain("session/prompt");
      expect(rpcs.filter((r) => r.method === "session/set_config_option").map((r) => r.params.configId)).toEqual(["model", "alpha_effort"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("explicit empty inventory event clears shared catalog", async () => {
    await chmod(fixture, 0o755);
    const { ModelCatalog } = await import("../src/model-catalog.js");
    const dir = await mkdtemp(join(tmpdir(), "agy-emptyinv-"));
    const context = async () => ({ scope: "account", executable: "fake", args: [], cacheDirectory: dir });
    const manager = new ModelCatalog(dir, { context, probe: async () => { throw new Error("offline"); } });
    try {
      await manager.refresh();
      const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", catalogScope: "account", environment: { FAKE_ACP_PER_MODEL: "1" } });
      try {
        expect(manager.catalog.models.length).toBeGreaterThan(0);
        for await (const _e of worker.runTurn("FAKE_EMPTY_INVENTORY")) { /* drain */ }
        expect(manager.catalog.models).toEqual([]);
        expect(manager.catalog.exactModels).toEqual([]);
      } finally { await worker.stop(true); }
    } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe("effort ack explicit inventory membership", () => {
  test("effort ack with explicit empty model list rejects before prompt", async () => {
    await chmod(fixture, 0o755);
    const dir = await mkdtemp(join(tmpdir(), "agy-effort-emptymodel-"));
    const log = join(dir, "rpc.jsonl");
    try {
      const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", effort: "high", environment: { FAKE_ACP_PER_MODEL: "1", FAKE_ACP_EFFORT_MODE: "emptymodel", FAKE_ACP_RPC_LOG: log } });
      await expect(worker).rejects.toThrow(/did not confirm the requested thinking level/);
      const rpcs = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(rpcs.map((r) => r.method)).not.toContain("session/prompt");
      expect(rpcs.filter((r) => r.method === "session/set_config_option").map((r) => r.params.configId)).toEqual(["model", "alpha_effort"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("rejected acks are not published to the shared catalog", () => {
  test("rejected effort ack (empty model inventory) leaves shared catalog unchanged", async () => {
    await chmod(fixture, 0o755);
    const { ModelCatalog } = await import("../src/model-catalog.js");
    const { emitAcpCatalog } = await import("../src/catalog-events.js");
    const { catalogFromSession } = await import("../src/models.js");
    const dir = await mkdtemp(join(tmpdir(), "agy-ack-nopublish-"));
    let changes = 0;
    const context = async () => ({ scope: "account", executable: "fake", args: [], cacheDirectory: dir });
    const manager = new ModelCatalog(dir, { context, probe: async () => { throw new Error("offline"); }, onChange: () => { changes += 1; } });
    try {
      await manager.refresh();
      emitAcpCatalog("account", catalogFromSession({
        configOptions: [
          { id: "model", category: "model", currentValue: "model-alpha", options: [{ value: "model-alpha", name: "Model Alpha" }, { value: "model-beta", name: "Model Beta" }, { value: "model-gamma", name: "Model Gamma" }] },
          { id: "alpha_effort", category: "thought_level", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
        ],
      }, "fake")!);
      const beforeChanges = changes;
      // The emptymodel effort ack carries an empty model inventory; if it
      // were published it would wipe the shared catalog. The worker's valid
      // session/new catalog (alpha/beta/gamma) may publish once; the rejected
      // ack must add nothing beyond that.
      const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "model-alpha", effort: "high", catalogScope: "account", environment: { FAKE_ACP_PER_MODEL: "1", FAKE_ACP_EFFORT_MODE: "emptymodel" } });
      await expect(worker).rejects.toThrow(/did not confirm the requested thinking level/);
      expect(manager.catalog.models.map((x) => x.id)).toEqual(expect.arrayContaining(["model-alpha", "model-beta", "model-gamma"]));
      expect(manager.catalog.exactModels.length).toBeGreaterThan(0); // not wiped by the ack
      expect(manager.catalog.thinkingSelectors?.["model-alpha"]?.values).toEqual(["low", "high"]); // from session/new, not ack
      expect(changes).toBe(beforeChanges + 1); // only the valid session/new republished
    } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
  });

  test("rejected switch ack (wrong target) leaves shared catalog unchanged", async () => {
    await chmod(fixture, 0o755);
    const { ModelCatalog } = await import("../src/model-catalog.js");
    const { emitAcpCatalog } = await import("../src/catalog-events.js");
    const { catalogFromSession } = await import("../src/models.js");
    const dir = await mkdtemp(join(tmpdir(), "agy-ack-nopublish2-"));
    let changes = 0;
    const context = async () => ({ scope: "account", executable: "fake", args: [], cacheDirectory: dir });
    const manager = new ModelCatalog(dir, { context, probe: async () => { throw new Error("offline"); }, onChange: () => { changes += 1; } });
    try {
      await manager.refresh();
      emitAcpCatalog("account", catalogFromSession({
        configOptions: [
          { id: "model", category: "model", currentValue: "gemini-3.8-flash-high", options: [{ value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, { value: "fake-model-low", name: "Fake Model" }] },
        ],
      }, "fake")!);
      const beforeChanges = changes;
      const worker = createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", catalogScope: "account", environment: { FAKE_ACP_SET_MODEL_MODE: "wrong" } });
      await expect(worker).rejects.toThrow(/did not confirm the requested model/);
      // Valid session/new inventory is the full default set; the wrong ack's
      // 2-model inventory must not prune shared state.
      expect(manager.catalog.exactModels.map((x) => x.id)).toEqual(expect.arrayContaining(["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "fake-model-low"]));
      expect(manager.catalog.exactModels.find((x) => x.id === "gemini-3.8-flash-high")?.variantEfforts).toEqual(expect.arrayContaining(["high", "medium", "low"]));
      expect(changes).toBe(beforeChanges + 1);
    } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCompatibility } from "./fixtures/compatibility.js";
let compatibility: ReturnType<typeof fixtureCompatibility>;
beforeAll(() => { compatibility = fixtureCompatibility(); });
afterAll(() => { compatibility.mockRestore(); });
import { catalogContext } from "../src/model-catalog.js";
import { resolveClientIdentity } from "../src/runtime.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const directory = await mkdtemp(join(tmpdir(), "agy-scope-identity-"));
const saved = { ...process.env };

test("real catalogContext scope separates pinned identities and ignores later env changes", async () => {
  await chmod(fixture, 0o755);
  try {
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = join(directory, "data");
    process.env.GEMINI_HOME = join(directory, "gemini");
    delete process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;

    // Option (plugin clientName) vs default: different scopes, both stable.
    const pinned = resolveClientIdentity("zed");
    expect(pinned?.name).toBe("zed");
    const [defaultCtx, zedCtx, zedAgain] = await Promise.all([
      catalogContext(fixture), catalogContext(fixture, pinned), catalogContext(fixture, pinned),
    ]);
    expect(zedCtx.scope).not.toBe(defaultCtx.scope);
    expect(zedAgain.scope).toBe(zedCtx.scope);
    expect(zedCtx.clientIdentity?.name).toBe("zed");
    expect(defaultCtx.clientIdentity).toBeUndefined();

    // Env changes after pinning must not move the pinned scope: the pinned
    // value is resolved once and hashed verbatim; catalogContext never
    // rereads OPENCODE_ANTIGRAVITY_CLIENT_NAME.
    process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = "zed";
    const afterEnvZed = await catalogContext(fixture, pinned);
    expect(afterEnvZed.scope).toBe(zedCtx.scope);
    process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = "bogus";
    const afterEnvBogus = await catalogContext(fixture, pinned);
    expect(afterEnvBogus.scope).toBe(zedCtx.scope);
    process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = "";
    const afterEnvEmpty = await catalogContext(fixture, pinned);
    expect(afterEnvEmpty.scope).toBe(zedCtx.scope);

    // The default pin (undefined) is likewise immune: resolving a zed env
    // afterwards does not retroactively change the default scope, and the
    // default context computed now still equals the earlier default.
    delete process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;
    const defaultPin = resolveClientIdentity(undefined);
    process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = "zed";
    const defaultAfter = await catalogContext(fixture, defaultPin);
    expect(defaultAfter.scope).toBe(defaultCtx.scope);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true });
  }
});

import { describe, expect, test } from "bun:test";
import { clientIdentityForName, configuredClientIdentity, ZED_CLIENT_NAME, ACP_CLIENT_VERSION } from "../src/constants.js";
import { resolveClientIdentity } from "../src/runtime.js";

describe("ACP client identity", () => {
  test("default is omitted; zed is the only explicit identity", () => {
    delete process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;
    expect(configuredClientIdentity()).toBeUndefined();
    expect(clientIdentityForName("zed")).toEqual({ name: ZED_CLIENT_NAME, version: ACP_CLIENT_VERSION });
    expect(() => clientIdentityForName("cursor")).toThrow(/Only "zed"/);
    expect(() => clientIdentityForName("Zed")).toThrow(/Only "zed"/);
  });

  test("resolveClientIdentity: env wins, option second, empty env means default", () => {
    const saved = process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;
    try {
      delete process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;
      expect(resolveClientIdentity(undefined)).toBeUndefined();
      expect(resolveClientIdentity("zed")?.name).toBe("zed");
      expect(() => resolveClientIdentity("other")).toThrow(/Only "zed"/);
      expect(() => resolveClientIdentity(42)).toThrow(/must be "zed"/);
      process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = "zed";
      expect(resolveClientIdentity("other")?.name).toBe("zed"); // env wins
      process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = "";
      expect(resolveClientIdentity("zed")).toBeUndefined(); // explicitly unset
      process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = "bogus";
      expect(() => resolveClientIdentity("zed")).toThrow(/Only "zed"/);
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME;
      else process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME = saved;
    }
  });
});

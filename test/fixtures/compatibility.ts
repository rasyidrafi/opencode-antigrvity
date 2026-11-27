import { afterAll, beforeAll, spyOn } from "bun:test";
import { resolve } from "node:path";
import * as compatibility from "../../src/agy-cli.js";

/** Fake ACP does not talk to Google; keep process/pool tests credential-free. */
export function useFixtureAuthentication() {
  let fixture: ReturnType<typeof fixtureCompatibility>;
  beforeAll(() => { fixture = fixtureCompatibility(); });
  afterAll(() => { fixture.mockRestore(); });
}

/** Test-only dependency replacement, never an environment bypass shipped to
 * users. The production validator still rejects this executable. */
export function fixtureCompatibility() {
  const original = compatibility.assertAgyCliCompatibility;
  const validation = spyOn(compatibility, "assertAgyCliCompatibility").mockImplementation(async path => {
    if (resolve(path) !== resolve(import.meta.dir, "fake-acp.mjs")) return original(path);
  });
  return { mockRestore() { validation.mockRestore(); } };
}

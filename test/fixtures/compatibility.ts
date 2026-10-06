import { spyOn } from "bun:test";
import { resolve } from "node:path";
import * as compatibility from "../../src/acp-compatibility.js";

/** Test-only dependency replacement, never an environment bypass shipped to
 * users. The production validator still rejects this executable. */
export function fixtureCompatibility() {
  const original = compatibility.assertHostToolCompatibility;
  return spyOn(compatibility, "assertHostToolCompatibility").mockImplementation(async path => {
    if (resolve(path) !== resolve(import.meta.dir, "fake-acp.mjs")) return original(path);
  });
}

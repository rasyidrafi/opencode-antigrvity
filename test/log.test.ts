import { describe, expect, test } from "bun:test";
import { info } from "../src/log.js";

describe("redacted logging", () => {
  test("does not print sensitive metadata values", () => {
    const original = console.info;
    let output = "";
    console.info = (...args: unknown[]) => { output += args.join(" "); };
    try {
      info("safe diagnostic", {
        prompt: "PROMPT_SECRET",
        authorization: "AUTH_SECRET",
        environment: "ENV_SECRET",
        toolArguments: "ARGS_SECRET",
        safeCount: 3,
      });
    } finally {
      console.info = original;
    }
    expect(output).not.toContain("SECRET");
    expect(output).toContain("safeCount=3");
  });
});

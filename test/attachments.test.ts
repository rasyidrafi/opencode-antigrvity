import { describe, expect, test } from "bun:test";
import { AGY_ATTACHMENT_POLICY, attachmentPolicyExplanation } from "../src/attachments.js";

describe("official ACP attachment policy", () => {
  test("advertises ACP media support without forwarding remote URLs", () => {
    expect(AGY_ATTACHMENT_POLICY.materialization).toBe("base64-or-local-file");
    expect(AGY_ATTACHMENT_POLICY.remoteUrls).toBe("not-forwarded");
    expect(AGY_ATTACHMENT_POLICY.acceptedInputParts).toContain("image_url");
    expect(attachmentPolicyExplanation()).toContain("ACP");
  });
});

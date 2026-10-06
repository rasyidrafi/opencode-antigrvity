import { describe, expect, test } from "bun:test";
import { createAcpWorker } from "../src/acp-process.js";
import { detectAcpServer } from "../src/acp-detect.js";
import { mapAcpEvent } from "../src/translate.js";
import { mkdtemp, rm } from "node:fs/promises";
import { runSummary } from "../src/utility.js";

const live = process.env.OPENCODE_ANTIGRAVITY_ACP_LIVE === "1";

describe("opt-in official Antigravity ACP live checks", () => {
  test.skipIf(!live)("reviewed host-tool isolation profile initializes and runs a tool-free utility summary", async () => {
    const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    const data = await mkdtemp("/tmp/opencode/agy-live-isolated-");
    process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = data;
    try {
      const detection = await detectAcpServer();
      const summary = await runSummary([
        { role: "system", content: "Preserve the exact checkpoint identifier in a concise summary." },
        { role: "user", content: "The checkpoint identifier is SAFE_CHECKPOINT_67. No tools or workspace actions are required." },
        { role: "assistant", content: "Acknowledged SAFE_CHECKPOINT_67." },
        { role: "user", content: "Summarize this selected conversation; retain SAFE_CHECKPOINT_67 exactly." },
      ], { cwd: process.cwd(), model: "gemini-3.8-flash-high", executable: detection.executable, signal: AbortSignal.timeout(120_000) });
      expect(summary.result.stopReason).toBe("end_turn");
      expect(summary.response).toContain("SAFE_CHECKPOINT_67");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR; else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
      await rm(data, { recursive: true, force: true });
    }
  }, 180_000);
  test.skipIf(!live)("initializes, streams, resumes, and accepts an image prompt", async () => {
    const detection = await detectAcpServer();
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: detection.executable, executableArgs: detection.args, model: "gemini-3.8-flash-high", permissionPolicy: "allow-always", stallTimeoutMs: 120_000 });
    const responses: string[] = [];
    try {
      for (const prompt of [
        "Reply with exactly ANTIGRAVITY_ACP_LIVE_OK.",
      ]) {
        for await (const event of worker.runTurn(prompt)) {
          const mapped = mapAcpEvent(event);
          if (mapped.kind === "text") responses.push(mapped.text);
        }
      }
      const sessionId = worker.sessionId;
      expect(sessionId).toBeTruthy();
      await worker.stop(true);
      const resumed = await createAcpWorker({ cwd: process.cwd(), executable: detection.executable, executableArgs: detection.args, model: "gemini-3.8-flash-high", sessionId, permissionPolicy: "allow-always", stallTimeoutMs: 120_000 });
      try {
        for await (const event of resumed.runTurn([{ type: "text", text: "Reply with exactly ANTIGRAVITY_ACP_RESUMED_OK." }, { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", mimeType: "image/png" }])) {
          const mapped = mapAcpEvent(event);
          if (mapped.kind === "text") responses.push(mapped.text);
        }
      } finally {
        await resumed.stop(true);
      }
    } finally {
      await worker.stop(true);
    }
    const response = responses.join("");
    expect(response).toContain("ANTIGRAVITY_ACP_LIVE_OK");
    expect(response).toContain("ANTIGRAVITY_ACP_RESUMED_OK");
  }, 300_000);

  test.skipIf(!live)("cancels an official persistent worker request", async () => {
    const detection = await detectAcpServer();
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: detection.executable, executableArgs: detection.args, model: "gemini-3.8-flash-high", permissionPolicy: "allow-always", stallTimeoutMs: 120_000 });
    const controller = new AbortController();
    const turn = (async () => {
      for await (const _event of worker.runTurn("Explain why a long-running task should be cancellable.", controller.signal)) {
        // Cancellation is asserted below.
      }
    })();
    setTimeout(() => controller.abort(), 50).unref?.();
    await expect(turn).rejects.toThrow(/cancel/i);
    expect(worker.state).toBe("closed");
  }, 300_000);
});

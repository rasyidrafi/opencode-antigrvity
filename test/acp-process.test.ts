import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createAcpWorker } from "../src/acp-process.js";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.mjs");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("ACP process manager", () => {
  test("runs two serialized turns through one persistent worker", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 10_000 });
    const responses: string[] = [];
    try {
      for await (const event of worker.runTurn("remember FAKE_MEMORY")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk") {
          const content = (event.update as { content?: { text?: string } }).content;
          if (content?.text) responses.push(content.text);
        }
      }
      for await (const event of worker.runTurn("what did you remember")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk") {
          const content = (event.update as { content?: { text?: string } }).content;
          if (content?.text) responses.push(content.text);
        }
      }
    } finally {
      await worker.stop(true);
    }
    expect(responses.join("")).toContain("FAKE_MEMORY");
    expect(worker.state).toBe("closed");
  });

  test("cancels a stalled turn and closes the process", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 30_000 });
    const controller = new AbortController();
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_HANG", controller.signal)) {
        // The fixture intentionally emits no result.
      }
    })();
    setTimeout(() => controller.abort(), 25).unref?.();
    await expect(turn).rejects.toThrow(/cancel/i);
    expect(worker.state).toBe("closed");
  });

  test("keeps a turn alive while ACP updates continue past the setup timeout", async () => {
    await chmod(fixture, 0o755);
    let activityCount = 0;
    const worker = await createAcpWorker({
      cwd: process.cwd(),
      executable: fixture,
      model: "fake-model-low",
      printTimeoutMs: 5_000,
      stallTimeoutMs: 500,
      onActivity: () => { activityCount += 1; },
    });
    let response = "";
    try {
      // Setup RPCs use printTimeoutMs. A streamed turn must use the idle
      // watchdog instead, so make the distinction visible without waiting
      // five minutes for this test.
      worker.options.printTimeoutMs = 50;
      for await (const event of worker.runTurn("FAKE_SLOW_STREAM")) {
        if (event.event === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") {
          response += event.update.content.text;
        }
      }
    } finally {
      await worker.stop(true);
    }
    expect(response).toContain("FAKE_SLOW_STREAM_OK");
    expect(activityCount).toBeGreaterThan(0);
    expect(worker.state).toBe("closed");
  });

  test("times out a turn only after the ACP stream goes quiet", async () => {
    await chmod(fixture, 0o755);
    let activityCount = 0;
    const worker = await createAcpWorker({
      cwd: process.cwd(),
      executable: fixture,
      model: "fake-model-low",
      printTimeoutMs: 5_000,
      stallTimeoutMs: 60,
      onActivity: () => { activityCount += 1; },
    });
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_HANG")) {
        // The fixture intentionally emits no update or result.
      }
    })();
    await expect(turn).rejects.toThrow(/without receiving an ACP stream update/i);
    expect(activityCount).toBe(0);
    expect(worker.state).toBe("closed");
  });

  test("stops an idle worker even when the consumer is paused after an update", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({
      cwd: process.cwd(),
      executable: fixture,
      model: "fake-model-low",
      printTimeoutMs: 5_000,
      stallTimeoutMs: 60,
    });
    const iterator = worker.runTurn("FAKE_PAUSE_STREAM")[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      await sleep(700);
      expect(worker.state).toBe("closed");
    } finally {
      await iterator.return?.();
      await worker.stop(true);
    }
  });

  test("does not time out after the ACP result has already arrived", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({
      cwd: process.cwd(),
      executable: fixture,
      model: "fake-model-low",
      printTimeoutMs: 5_000,
      stallTimeoutMs: 60,
    });
    const iterator = worker.runTurn("FAKE_STREAM")[Symbol.asyncIterator]();
    try {
      await iterator.next();
      await sleep(150);
      expect(worker.state).not.toBe("closed");
      while (!(await iterator.next()).done) {
        // Drain the queued ACP events and terminal result.
      }
    } finally {
      await iterator.return?.();
      await worker.stop(true);
    }
  });

  test("answers ACP permission requests with the configured autonomous policy", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", permissionPolicy: "allow-always" });
    let sawTool = false;
    try {
      for await (const event of worker.runTurn("FAKE_PERMISSION")) {
        if (event.event === "update" && (event.update as { sessionUpdate?: string }).sessionUpdate === "tool_call") sawTool = true;
      }
    } finally {
      await worker.stop(true);
    }
    expect(sawTool).toBe(true);
  });

  test("can authenticate an ACP server without creating a workspace session", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, authMethod: "oauth-personal", skipSession: true });
    expect(worker.init?.authMethods?.[0]?.id).toBe("oauth-personal");
    await worker.stop(true);
  });

  test("reports an ACP server exit before a result as a process failure", async () => {
    await chmod(fixture, 0o755);
    const worker = await createAcpWorker({ cwd: process.cwd(), executable: fixture, model: "fake-model-low", stallTimeoutMs: 10_000 });
    const turn = (async () => {
      for await (const _event of worker.runTurn("FAKE_EXIT")) {
        // The fixture exits before emitting a result.
      }
    })();
    await expect(turn).rejects.toThrow(/ACP|ended/i);
    expect(worker.state).toBe("closed");
  });
});

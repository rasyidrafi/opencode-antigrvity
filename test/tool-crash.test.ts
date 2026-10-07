import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const points = ["before-call-persistence", "after-call-persistence", "before-exposure", "after-exposure", "before-result-persistence", "after-result-persistence", "before-waiter-release", "after-delivery-intent", "after-mcp-handoff"];
test("SIGKILL matrix exercises integrated tool persistence, exposure and delivery", async () => {
  const evidence: any[] = [];
  for (const point of points) {
    const root = await mkdtemp(join(process.env.TMPDIR || "/tmp/opencode", "tool-crash-"));
    await mkdir(join(root, "home"), { mode: 0o700 });
    const launch = (recovery: boolean) => {
      const child = spawn(process.execPath, ["test", join(import.meta.dir, "fixtures/crash-runtime.ts")], {
        env: { ...process.env, AGY_CRASH_CHILD: "1", AGY_CRASH_POINT: point, AGY_CRASH_RECOVERY: recovery ? "1" : "0", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), GEMINI_HOME: join(root, "gemini"), OPENCODE_ANTIGRAVITY_DATA_DIR: root, OPENCODE_ANTIGRAVITY_ACP_PATH: join(import.meta.dir, "fixtures/fake-acp.mjs"), FAKE_ACP_PID_LOG: join(root, "acp-pids"), FAKE_ACP_PROMPT_LOG: join(root, "prompts.jsonl") },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let output = "";
      child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { output += chunk; });
      const message = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${point}: IPC timeout\n${output}`)); }, 25_000);
        child.once("message", value => { clearTimeout(timer); resolve(value); });
        child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`${point}: premature exit ${code}/${signal}\n${output}`)); });
      });
      const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
      return { child, message, exit, output: () => output };
    };
    const first = launch(false);
    const stopped = await first.message;
    expect(stopped.barrier).toBe(point);
    if (point === "after-mcp-handoff") expect(stopped.received).toContain("DURABLE_RESULT_ONCE");
    first.child.kill("SIGKILL");
    expect((await first.exit).signal).toBe("SIGKILL");
    // Reap only fixture ACP processes explicitly recorded in this private run.
    for (const pid of (await readFile(join(root, "acp-pids"), "utf8")).trim().split("\n")) {
      try {
        const environment = await readFile(`/proc/${pid}/environ`, "utf8");
        const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
        if (environment.split("\0").includes(`OPENCODE_ANTIGRAVITY_DATA_DIR=${root}`) && command.includes(join(import.meta.dir, "fixtures/fake-acp.mjs"))) process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    const second = launch(true);
    const recovered = await second.message;
    expect((await second.exit).code).toBe(0);
    const counter = await readFile(join(root, "external-counter"), "utf8").catch(() => "");
    expect(counter.split("effect").length - 1).toBe(["before-result-persistence", "after-result-persistence", "before-waiter-release", "after-delivery-intent", "after-mcp-handoff"].includes(point) ? 1 : 0);
    if (["after-result-persistence", "before-waiter-release", "after-delivery-intent", "after-mcp-handoff"].includes(point)) {
      expect(recovered.status).toBe(200);
      expect(await readFile(join(root, "prompts.jsonl"), "utf8")).toContain("DURABLE_RESULT_ONCE");
    } else {
      expect(recovered.status).toBe(400);
      if (["after-exposure", "before-result-persistence"].includes(point)) {
        expect(recovered.body.error.message).toContain("uncertain");
        expect(recovered.body.error.code).toBe("agy_tool_execution_uncertain");
      }
    }
    const tools = join(root, "tools");
    const records = [];
    for (const directory of await readdir(tools).catch(() => [])) for (const file of await readdir(join(tools, directory))) if (file.endsWith(".json")) records.push(JSON.parse(await readFile(join(tools, directory, file), "utf8")));
    const expectedDelivery = point === "after-delivery-intent" ? "delivery-attempted" : point === "after-mcp-handoff" ? "locally-handed-off" : ["after-result-persistence", "before-waiter-release"].includes(point) ? "result-persisted" : undefined;
    if (records.length) expect(records[0].delivery).toBe(expectedDelivery);
    if (point === "before-result-persistence") {
      const directory = (await readdir(tools))[0];
      const file = (await readdir(join(tools, directory))).find(file => file.endsWith(".json"))!;
      const path = join(tools, directory, file);
      const raw = JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), version: 999 });
      await writeFile(path, raw);
      for (let restart = 0; restart < 2; restart++) {
        const corruptRestart = launch(true);
        const result = await corruptRestart.message;
        expect((await corruptRestart.exit).code).toBe(0);
        expect(result.status).toBe(400);
        expect(result.body.error.code).toBe("agy_tool_record_corrupt");
        expect(JSON.parse(await readFile(path, "utf8")).corrupt).toBe(true);
      }
      const quarantined = await Promise.all((await readdir(join(root, "quarantine"))).map(file => readFile(join(root, "quarantine", file), "utf8").then(JSON.parse)));
      expect(quarantined.some(value => value.raw === raw)).toBe(true);
      expect(await readFile(join(root, "external-counter"), "utf8")).toBe("effect\n");
    }
    evidence.push({ point, root, signal: "SIGKILL", barrier: stopped, counter, recovered, records });
    await writeFile(join(process.env.TMPDIR || "/tmp/opencode", "tool-crash-evidence.json"), JSON.stringify(evidence, null, 2));
  }
}, 180_000);

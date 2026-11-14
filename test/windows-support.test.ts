import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { assertHostToolCompatibility } from "../src/acp-compatibility.js";
import { ACP_VERSION, acpDistribution } from "../src/acp-install.js";
import { BLOCKED_BROWSER_MARKER, browserBlocker, prepareBrowserBlocker } from "../src/browser-blocker.js";
import { SessionStore } from "../src/session-store.js";
import { AcpWorker } from "../src/acp-process.js";

test("Windows distribution requires the matching .exe companion and rejects unknown builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-windows-profile-"));
  try {
    const distribution = acpDistribution("win32", "x64");
    expect(distribution.companion).toBe("localharness_external.exe");
    expect(distribution.url).toBe(`https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-${ACP_VERSION}-windows-x86_64.zip`);
    const executable = join(root, distribution.executable);
    await writeFile(executable, "unreviewed ACP");
    await writeFile(join(root, distribution.companion), "unreviewed companion");
    await expect(assertHostToolCompatibility(executable, "win32", "x64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
    await expect(assertHostToolCompatibility(executable, "win32", "arm64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Optional official-artifact check, also run on Linux after reviewing the
// Windows archive. Nothing here executes the downloaded Windows binaries.
test.skipIf(!process.env.AGY_TEST_WINDOWS_ACP_DIR)("reviewed Windows pair passes; missing, wrongly named, or changed companion fails", async () => {
  const source = process.env.AGY_TEST_WINDOWS_ACP_DIR!;
  const executable = join(source, "agy_acp_server.exe");
  await expect(assertHostToolCompatibility(executable, "win32", "x64")).resolves.toBeUndefined();
  const root = await mkdtemp(join(source, "profile-check-"));
  try {
    const candidate = join(root, "agy_acp_server.exe");
    await link(executable, candidate);
    await link(join(source, "localharness_external.exe"), join(root, "localharness_external"));
    await expect(assertHostToolCompatibility(candidate, "win32", "x64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
    await writeFile(join(root, "localharness_external.exe"), "tampered");
    await expect(assertHostToolCompatibility(candidate, "win32", "x64")).rejects.toMatchObject({ code: "agy_acp_compatibility" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("Windows browser blocker ignores URL arguments and acknowledges without opening a browser", async () => {
  const blocker = browserBlocker("win32", { SystemRoot: "C:\\Windows directory" });
  expect(blocker.file).toBe("C:\\Windows directory\\System32\\cscript.exe");
  expect(blocker.args.slice(0, 2)).toEqual(["//nologo", "//E:JScript"]);
  expect(blocker.command).not.toContain("/bin/sh");
  expect(() => browserBlocker("win32", { SystemRoot: "C:\\invalid;path" })).toThrow("semicolon");
  const output: string[] = [];
  let exit: number | undefined;
  const script = await readFile(blocker.args[2], "utf8");
  runInNewContext(script, {
    WScript: {
      StdErr: { WriteLine: (line: string) => { output.push(line); } },
      Quit: (code: number) => { exit = code; },
      get Arguments() { throw new Error("The URL must not be interpreted"); },
    },
  });
  expect(output).toEqual([BLOCKED_BROWSER_MARKER]);
  expect(exit).toBe(0);
});

test("native browser blocker preflight succeeds without ACP or credentials", async () => {
  const command = await prepareBrowserBlocker(process.env);
  expect(command).toBe(browserBlocker().command);
});

test.skipIf(process.platform !== "win32")("Windows cscript and Python webbrowser handle URLs without browser fallback", async () => {
  const command = await prepareBrowserBlocker(process.env);
  const python = process.env.PYTHON || "python";
  const { stderr } = await promisify(execFile)(python, ["-c", [
    "import webbrowser",
    "def forbidden(*args, **kwargs): raise AssertionError('Windows browser fallback was attempted')",
    "webbrowser.WindowsDefault.open = forbidden",
    "assert webbrowser.open('https://example.invalid/login?x=1&y=2')",
  ].join("\n")], { env: { ...process.env, BROWSER: command }, windowsHide: true, timeout: 5_000 });
  expect(stderr.trim()).toBe(BLOCKED_BROWSER_MARKER);
});

test("session records can be persisted and atomically replaced on the native filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-platform-store-"));
  const previous = process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
  process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = root;
  try {
    await mkdir(join(root, "workspace with spaces"));
    const store = new SessionStore();
    const record = { sessionId: "first", model: "model", cwd: join(root, "workspace with spaces"), cliVersion: "1.3.0", createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
    await store.set("windows-session", record);
    await store.set("windows-session", { ...record, sessionId: "replacement" });
    expect((await new SessionStore().get("windows-session"))?.sessionId).toBe("replacement");
    await store.saveReceipt("windows-session", "request", { state: "prepared" });
    expect((await new SessionStore().receipt("windows-session", "request"))?.state).toBe("prepared");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ANTIGRAVITY_DATA_DIR;
    else process.env.OPENCODE_ANTIGRAVITY_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32" || !process.env.AGY_TEST_WINDOWS_ACP_DIR)("official Windows ACP initializes and fails authentication without browser login", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-official-windows-"));
  const executable = join(process.env.AGY_TEST_WINDOWS_ACP_DIR!, "agy_acp_server.exe");
  await assertHostToolCompatibility(executable);
  // Exercise the actual executable/stdio/termination independently of the
  // CLI-credential preflight, which normally prevents this unauthenticated start.
  const worker = new AcpWorker({ cwd: root, executableArgs: [], environment: { GEMINI_HOME: root }, printTimeoutMs: 45_000 }, executable);
  try {
    await expect(worker.start(AbortSignal.timeout(45_000))).rejects.toMatchObject({ kind: "auth" });
    expect(worker.init?.protocolVersion).toBe(1);
    expect(worker.init?.authMethods?.some(method => method.id === "oauth-personal")).toBe(true);
  } finally {
    await worker.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

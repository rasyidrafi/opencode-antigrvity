import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { BLOCKED_BROWSER_MARKER, browserBlocker, prepareBrowserBlocker } from "../src/browser-blocker.js";
import { SessionStore } from "../src/session-store.js";

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

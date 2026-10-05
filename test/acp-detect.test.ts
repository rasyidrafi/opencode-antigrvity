import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resolveAcpExecutable } from "../src/acp-detect.js";

test("discovers the installed ACP server under the XDG Antigravity data directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "opencode-antigravity-home-"));
  const dataHome = await mkdtemp(join(tmpdir(), "opencode-antigravity-xdg-"));
  const executable = join(dataHome, "opencode-antigravity", "acp-server-1.3.0", "agy_acp_server.par");
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const previousAcpPath = process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;

  try {
    await mkdir(join(dataHome, "opencode-antigravity", "acp-server-1.3.0"), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    const companion = join(dataHome, "opencode-antigravity", "acp-server-1.3.0", process.platform === "win32" ? "localharness_external.exe" : "localharness_external");
    await writeFile(companion, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.XDG_DATA_HOME = dataHome;
    delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;

    await expect(resolveAcpExecutable(undefined, { home, path: "" })).resolves.toBe(executable);
  } finally {
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    if (previousAcpPath === undefined) delete process.env.OPENCODE_ANTIGRAVITY_ACP_PATH;
    else process.env.OPENCODE_ANTIGRAVITY_ACP_PATH = previousAcpPath;
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(dataHome, { recursive: true, force: true }),
    ]);
  }
});

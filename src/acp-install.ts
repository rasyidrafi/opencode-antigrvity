import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { unzipSync } from "fflate";
import { acquireFileLock } from "./file-lock.js";

export const ACP_VERSION = "1.3.0";

export function acpDistribution(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : undefined;
  if (!os || !cpu) throw new Error(`No official Antigravity distribution for ${platform}-${arch}`);
  return {
    url: `https://dl.google.com/agy-extensions/releases/${os}/agy-acp-server-${ACP_VERSION}-${platform === "win32" ? "windows" : platform}-${cpu}.zip`,
    executable: platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
    companion: platform === "win32" ? "localharness_external.exe" : "localharness_external",
  };
}

export function acpInstallDirectory(): string {
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "opencode-antigravity", `acp-server-${ACP_VERSION}`);
}

/** Extract only the two official executables, never archive-supplied paths. */
export function unpackAcpArchive(bytes: Uint8Array, names: string[]): Record<string, Uint8Array> {
  const files = unzipSync(bytes, { filter: (file) => names.includes(basename(file.name)) });
  const result: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    const name = basename(path);
    if (result[name]) throw new Error(`Duplicate executable in ACP archive: ${name}`);
    if (!content.length) throw new Error(`Empty executable in ACP archive: ${name}`);
    result[name] = content;
  }
  if (names.some((name) => !result[name])) throw new Error("Official ACP archive is missing a required executable");
  return result;
}

/** Lazy first-request installation; shared across sessions and server processes. */
export async function installAcpServer(directory = acpInstallDirectory(), download: typeof fetch = fetch): Promise<string> {
  const distribution = acpDistribution();
  const executable = join(directory, distribution.executable);
  const ready = async () => {
    try {
      await Promise.all([distribution.executable, distribution.companion].map((name) =>
        access(join(directory, name), process.platform === "win32" ? constants.F_OK : constants.X_OK),
      ));
      return true;
    } catch { return false; }
  };
  if (await ready()) return executable;
  await mkdir(directory, { recursive: true });
  const release = await acquireFileLock(join(directory, ".install.lock"), 180_000);
  let staging: string | undefined;
  try {
    if (await ready()) return executable;
    const response = await download(distribution.url, { signal: AbortSignal.timeout(120_000), redirect: "error" });
    if (!response.ok) throw new Error(`Official ACP download failed: HTTP ${response.status}`);
    const files = unpackAcpArchive(new Uint8Array(await response.arrayBuffer()), [distribution.executable, distribution.companion]);
    staging = await mkdtemp(join(directory, ".install-"));
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(staging, name), bytes, { mode: 0o755 });
      await chmod(join(staging, name), 0o755);
    }
    // Publish the companion first, and the discoverable ACP executable last.
    for (const name of [distribution.companion, distribution.executable]) {
      await rename(join(staging, name), join(directory, name));
    }
    return executable;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await release();
  }
}

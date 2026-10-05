import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { AgyProcessError } from "./errors.js";
import { installAcpServer } from "./acp-install.js";

export type AcpServerDetection = {
  executable: string;
  args: string[];
  platform: string;
};

type AcpServerSearchOptions = {
  home?: string;
  path?: string;
};

function executableNames(): string[] {
  if (process.platform === "win32") return ["agy_acp_server.exe", "agy_acp_server.par"];
  return ["agy_acp_server.par", "agy_acp_server"];
}

function defaultArgs(): string[] {
  // The registry manifest requires an empty uid argument on Linux. Other
  // platform distributions accept no extra argument.
  return process.platform === "linux" ? ["--uid="] : [];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function acpServerArgs(): string[] {
  const raw = process.env.OPENCODE_ANTIGRAVITY_ACP_ARGS?.trim();
  if (!raw) return defaultArgs();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("must be a JSON array of strings");
    }
    return parsed.slice(0, 32) as string[];
  } catch (error) {
    throw new AgyProcessError(
      `OPENCODE_ANTIGRAVITY_ACP_ARGS must be a JSON string array: ${error instanceof Error ? error.message : "invalid value"}`,
    );
  }
}

export async function resolveAcpExecutable(preferred?: string, options: AcpServerSearchOptions = {}): Promise<string> {
  const configured = preferred?.trim() || process.env.OPENCODE_ANTIGRAVITY_ACP_PATH?.trim();
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(configured);
    if (await isExecutable(path)) return path;
    throw new AgyProcessError(`Configured Antigravity ACP server was not found: ${path}`);
  }

  const names = executableNames();
  const home = options.home ?? homedir();
  const pathEntries = (options.path ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const candidates = [
    ...pathEntries.flatMap((entry) => names.map((name) => join(entry, name))),
    ...names.flatMap((name) => [
      join(dataHome, "opencode-antigravity", "acp-server-1.3.0", name),
      join(dataHome, "opencode-antigravity", name),
      join(home, ".local", "bin", name),
      join(home, ".local", "share", "antigravity", name),
    ]),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutable(candidate)) {
      if (dirname(candidate) === join(dataHome, "opencode-antigravity", "acp-server-1.3.0") &&
          !await isExecutable(join(dirname(candidate), process.platform === "win32" ? "localharness_external.exe" : "localharness_external"))) continue;
      return candidate;
    }
  }

  throw new AgyProcessError(
    "The official Antigravity ACP server was not found. Install agy_acp_server.par from the ACP registry or set OPENCODE_ANTIGRAVITY_ACP_PATH.",
  );
}

export async function detectAcpServer(preferred?: string): Promise<AcpServerDetection> {
  const executable = await resolveAcpExecutable(preferred);
  return { executable, args: acpServerArgs(), platform: `${process.platform}-${process.arch}` };
}

export async function ensureAcpServer(preferred?: string): Promise<AcpServerDetection> {
  try {
    return await detectAcpServer(preferred);
  } catch (error) {
    // Never silently ignore a user's explicit override.
    if (preferred?.trim() || process.env.OPENCODE_ANTIGRAVITY_ACP_PATH?.trim()) throw error;
    const executable = await installAcpServer();
    return { executable, args: acpServerArgs(), platform: `${process.platform}-${process.arch}` };
  }
}

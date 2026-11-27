import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { AgyError } from "./errors.js";

// Admission requires reviewing the exact artifact and its tool/profile
// boundaries. An initialize handshake is not sufficient evidence.
const registry = { launcher: "f472860b79c4816a32817e589afdb01cec0ca731e5fa428eae873b14be12387f", companion: "072fc497e7814b0e25a7d80109bceddacd815eb351d2e48ce579a05510e0cfdf" };
export function isRegistryRuntime(executable: string) { return basename(executable) === "agy_acp_server.par"; }
async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertAgyCliCompatibility(executable: string): Promise<void> {
  if (process.platform === "linux" && process.arch === "x64" && isRegistryRuntime(executable)) {
    try {
      if (await sha256(executable) === registry.launcher && await sha256(join(dirname(executable), "localharness_external")) === registry.companion) return;
    } catch { /* Missing or unreadable pair is not admitted. */ }
  }
  throw new AgyError("unsupported", "This executable is not the reviewed official Antigravity ACP Registry 1.5.2 Linux x64 pair. Set OPENCODE_ANTIGRAVITY_ACP_PATH to its agy_acp_server.par; CLI-embedded ACP and 1.3.0 are not admitted.", { code: "agy_cli_isolation_unverified" });
}

export async function detectAgyAcp(validate = assertAgyCliCompatibility) {
  const executable = await resolveAgyCli(validate);
  return { executable, args: isRegistryRuntime(executable) ? ["--uid="] : ["acp"], platform: `${process.platform}-${process.arch}` };
}

/** Resolve the native CLI, not a version-manager shim. The admission check
 * must read the same executable the worker will launch. */
export async function resolveAgyCli(
  validate: (executable: string) => Promise<void>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const override = environment.OPENCODE_ANTIGRAVITY_ACP_PATH?.trim();
  const names = process.platform === "win32" ? ["agy.exe", "antigravity.exe"] : ["agy_acp_server.par", "agy", "antigravity"];
  const candidates = override ? [resolve(override)] : (environment.PATH ?? "").split(delimiter).filter(Boolean)
    .flatMap(directory => names.map(name => resolve(directory, name)));
  const seen = new Set<string>();
  let rejection: unknown;
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      if (seen.has(executable)) continue;
      seen.add(executable);
      await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      await validate(executable);
      return executable;
    } catch (error) {
      if (error instanceof AgyError) rejection ??= error;
      if (override) break;
    }
  }
  if (rejection) throw rejection;
  throw new AgyError("unsupported", override
    ? "Configured Antigravity ACP Registry executable could not be opened. Check OPENCODE_ANTIGRAVITY_ACP_PATH."
    : "Antigravity ACP Registry 1.5.2 not found. Set OPENCODE_ANTIGRAVITY_ACP_PATH to the extracted agy_acp_server.par.", { code: "agy_cli_not_found" });
}

/** Fixed argv: no flags inherited from the standalone ACP integration. */
export function agyAcpArgs(profile: string): string[] {
  return ["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp", "--include-default-customizations=false"];
}

function profileHome(environment: NodeJS.ProcessEnv): string {
  const data = environment.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
    join(environment.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode-antigravity");
  return resolve(data, "agy-cli-profile");
}

export async function agyProfileScope(environment: NodeJS.ProcessEnv = process.env, registryMode = false) {
  const home = profileHome(environment);
  const token = await cliToken(environment);
  if (registryMode && !token) throw cliAuthRequired();
  return { home, revision: token ? createHash("sha256").update(token.refresh).digest("hex") : null };
}

function cliAuthRequired() {
  return new AgyError("auth", "Antigravity requires an authenticated agy CLI. Sign in through agy, then retry; the plugin does not start interactive login.", { code: "agy_cli_auth_required" });
}

async function cliToken(environment: NodeJS.ProcessEnv) {
  const home = environment.GEMINI_HOME?.trim() || join(environment.HOME || homedir(), ".gemini");
  try {
    const bytes = await readFile(join(home, "antigravity-cli", "antigravity-oauth-token"));
    const value = JSON.parse(bytes.toString("utf8"));
    const refresh = value?.token?.refresh_token;
    if (typeof refresh === "string" && refresh.trim() && (!value.auth_method || ["consumer", "oauth-personal"].includes(value.auth_method))) return { bytes, refresh };
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function cliHostEnvironment(environment: NodeJS.ProcessEnv, utilityDirectory?: string, expectedRevision?: string | null, registryMode = false) {
  const token = await cliToken(environment);
  if (registryMode && !token) throw cliAuthRequired();
  const revision = token ? createHash("sha256").update(token.refresh).digest("hex") : null;
  if (expectedRevision !== undefined && revision !== expectedRevision) {
    throw new AgyError("auth", "Antigravity CLI account changed during setup; refresh the model catalog and retry.", { code: "agy_cli_account_changed" });
  }
  const home = join(profileHome(environment), ...(registryMode ? ["registry-1.5.2"] : []), revision ?? "signed-out");
  const cwd = join(utilityDirectory ?? home, "workspace");
  if (token) {
    const store = join(home, "antigravity-acp");
    await mkdir(store, { recursive: true, mode: 0o700 });
    const target = join(store, registryMode ? "acp_token.json" : "antigravity-oauth-token");
    await publishPrivateFile(target, registryMode ? registryCredential(token.refresh) : token.bytes);
    if (registryMode) await publishPrivateFile(join(store, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }));
  }
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  return { cwd, environment: {
    ...(registryMode ? { PATH: "/usr/bin:/bin", TMPDIR: environment.TMPDIR, SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt", XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share") } : environment),
    HOME: home,
    USERPROFILE: home,
    GEMINI_HOME: home,
    GEMINI_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    SSH_CONNECTION: environment.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
  } };
}

/** Same installed-app OAuth client as the original CLI-to-ACP bridge. */
function registryCredential(refresh: string): string {
  const decode = (bytes: number[]) => bytes.map((byte, i) => String.fromCharCode(byte ^ "gemini".charCodeAt(i % 6))).join("");
  return JSON.stringify({
    client_id: decode([86,85,90,88,94,89,81,85,91,89,91,80,86,72,25,4,6,26,20,12,3,91,6,91,86,9,14,27,11,91,84,80,27,29,1,5,8,15,5,93,9,93,87,86,8,25,64,8,23,21,30,71,9,6,8,2,1,12,27,26,2,23,14,6,0,29,2,11,25,71,13,6,10]),
    client_secret: decode([32,42,46,58,62,49,74,46,88,81,40,62,53,81,85,95,34,13,43,47,92,4,34,43,95,22,53,42,90,19,81,20,41,40,8]),
    refresh_token: refresh,
    token_uri: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
  });
}

async function publishPrivateFile(target: string, value: string | Uint8Array) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await renamePrivateFile(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

/** Concurrent replacements can transiently fail with sharing violations on Windows. */
export async function renamePrivateFile(source: string, target: string, move = rename, platform = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await move(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt === 7) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

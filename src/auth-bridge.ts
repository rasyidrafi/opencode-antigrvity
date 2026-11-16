import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgyError } from "./errors.js";
import { geminiHome, resolveCliRefreshToken } from "./cli-credentials.js";

export function cliAuthenticationError(): AgyError {
  return new AgyError("auth", "Antigravity requires an authenticated agy CLI. Sign in through agy, then retry. The plugin does not start interactive login.", { code: "agy_cli_auth_required" });
}

/**
 * Bridge CLI credentials when they exist, but never require them. The ACP
 * server can hold its own credentials (macOS keychain, acp_token.json), and
 * reports authentication failures itself. Blocking workers on the CLI token
 * file breaks setups where agy is authenticated through a different store.
 */
export async function requireCliAuthentication(environment: NodeJS.ProcessEnv): Promise<void> {
  await bridgeCliAuthentication(environment);
}

function decodeSecret(bytes: number[], key = "gemini"): string {
  return bytes.map((byte, i) => String.fromCharCode(byte ^ key.charCodeAt(i % key.length))).join("");
}

const OAUTH_CLIENT_ID = decodeSecret([
  86, 85, 90, 88, 94, 89, 81, 85, 91, 89, 91, 80, 86, 72, 25, 4, 6, 26, 20, 12, 3, 91, 6, 91, 86, 9, 14, 27, 11,
  91, 84, 80, 27, 29, 1, 5, 8, 15, 5, 93, 9, 93, 87, 86, 8, 25, 64, 8, 23, 21, 30, 71, 9, 6, 8, 2, 1, 12, 27, 26,
  2, 23, 14, 6, 0, 29, 2, 11, 25, 71, 13, 6, 10,
]);
const OAUTH_CLIENT_SECRET = decodeSecret([
  32, 42, 46, 58, 62, 49, 74, 46, 88, 81, 40, 62, 53, 81, 85, 95, 34, 13, 43, 47, 92, 4, 34, 43, 95, 22, 53, 42,
  90, 19, 81, 20, 41, 40, 8,
]);
const OAUTH_TOKEN_URI = "https://oauth2.googleapis.com/token";
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/aicode",
];

async function readObject(path: string): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error: any) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/**
 * The standalone ACP server keeps a separate credential file from the CLI.
 * Seed or repair personal ACP credentials from the authenticated CLI. Account
 * switches in the CLI are reflected on the next worker. The CLI's source file
 * is left alone; ACP always uses the CLI's personal OAuth credentials.
 * The token itself never enters logs or the OpenCode request path.
 */
export async function bridgeCliAuthentication(environment: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const home = geminiHome(environment);
  const acpDir = join(home, "antigravity-acp");
  const acpPath = join(acpDir, "acp_token.json");
  const settingsPath = join(acpDir, "settings.json");
  const refreshToken = await resolveCliRefreshToken(environment);
  if (!refreshToken) return false;
  const settings = await readObject(settingsPath);
  const auth = settings.auth && typeof settings.auth === "object" ? settings.auth : {};
  const existing = await readObject(acpPath);
  if (existing.refresh_token !== refreshToken || existing.client_id !== OAUTH_CLIENT_ID ||
      existing.client_secret !== OAUTH_CLIENT_SECRET || existing.token_uri !== OAUTH_TOKEN_URI ||
      "token" in existing || "expiry" in existing) {
    const credentials = {
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      token_uri: OAUTH_TOKEN_URI,
      scopes: OAUTH_SCOPES,
      // Let Google's credential loader refresh. CLI expiry timestamps and
      // access-token formats need not match google-auth's serialization.
    };
    await mkdir(acpDir, { recursive: true, mode: 0o700 });
    await writePrivateJson(acpPath, credentials);
  }
  if (auth.type !== "oauth-personal") {
    await mkdir(acpDir, { recursive: true, mode: 0o700 });
    await writePrivateJson(settingsPath, { ...settings, auth: { ...auth, type: "oauth-personal" } });
  }
  return true;
}

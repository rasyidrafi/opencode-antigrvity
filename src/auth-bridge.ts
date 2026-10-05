import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

type CliTokenFile = {
  token?: {
    access_token?: unknown;
    refresh_token?: unknown;
    expiry?: unknown;
  };
};

function geminiHome(): string {
  return process.env.GEMINI_HOME?.trim() || join(homedir(), ".gemini");
}

/**
 * The standalone ACP server keeps a separate credential file from the CLI.
 * Seed that file from the CLI's already-authenticated refresh token once.
 * The token itself never enters logs or the OpenCode request path.
 */
export async function bridgeCliAuthentication(): Promise<boolean> {
  const home = geminiHome();
  const cliPath = join(home, "antigravity-cli", "antigravity-oauth-token");
  const acpDir = join(home, "antigravity-acp");
  const acpPath = join(acpDir, "acp_token.json");
  const settingsPath = join(acpDir, "settings.json");
  let cli: CliTokenFile;
  try {
    cli = JSON.parse(await readFile(cliPath, "utf8")) as CliTokenFile;
  } catch {
    return false;
  }
  const token = cli.token;
  if (typeof token?.refresh_token !== "string" || !token.refresh_token.trim()) return false;
  try {
    await readFile(acpPath, "utf8");
  } catch {
    const credentials = {
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: token.refresh_token,
      token_uri: OAUTH_TOKEN_URI,
      scopes: OAUTH_SCOPES,
      ...(typeof token.access_token === "string" ? { token: token.access_token } : {}),
      ...(typeof token.expiry === "string" ? { expiry: token.expiry } : {}),
    };
    await mkdir(acpDir, { recursive: true, mode: 0o700 });
    await writeFile(acpPath, JSON.stringify(credentials), { mode: 0o600 });
    await chmod(acpPath, 0o600).catch(() => undefined);
  }
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const auth = settings.auth && typeof settings.auth === "object" ? settings.auth as Record<string, unknown> : {};
    if (auth.type !== "oauth-personal") {
      settings.auth = { ...auth, type: "oauth-personal" };
      await writeFile(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch {
    await writeFile(settingsPath, JSON.stringify({ auth: { type: "oauth-personal" } }, null, 2), { mode: 0o600 });
    await chmod(settingsPath, 0o600).catch(() => undefined);
  }
  return true;
}

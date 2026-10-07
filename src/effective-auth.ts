import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function object(path: string): Promise<Record<string, any>> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error: any) { if (error.code === "ENOENT") return {}; throw error; }
}

/** Only the digest leaves this function. Account/credential revisions must
 * invalidate workers without putting credentials in keys or diagnostics. */
export async function effectiveAuth(environment: NodeJS.ProcessEnv = process.env) {
  const home = environment.GEMINI_HOME?.trim() || join(environment.HOME || homedir(), ".gemini");
  const settings = await object(join(home, "antigravity-acp", "settings.json"));
  const method = environment.OPENCODE_ANTIGRAVITY_ACP_AUTH_METHOD?.trim() || settings.auth?.type || "oauth-personal";
  const auth = { ...settings.auth, type: method };
  // Official CLI credential directory, independent of our provider ID.
  const cli = await object(join(home, "antigravity-cli", "antigravity-oauth-token"));
  const credentials = await object(join(home, "antigravity-acp", method === "oauth-business" ? "acp_business_token.json" : "acp_token.json"));
  const adcPath = environment.GOOGLE_APPLICATION_CREDENTIALS || join(environment.CLOUDSDK_CONFIG || join(environment.XDG_CONFIG_HOME || join(environment.HOME || homedir(), ".config"), "gcloud"), "application_default_credentials.json");
  const scope = createHash("sha256").update(JSON.stringify({ home, auth, gcp: settings.gcp,
    revision: method === "oauth-personal" ? cli.token?.refresh_token || credentials.refresh_token : credentials,
    key: environment.GEMINI_API_KEY || environment.GOOGLE_API_KEY,
    project: environment.GOOGLE_CLOUD_PROJECT || environment.GCLOUD_PROJECT,
    location: environment.GOOGLE_CLOUD_LOCATION,
    endpoint: environment.GOOGLE_GEMINI_BASE_URL || environment.GEMINI_API_ENDPOINT,
    adcPath,
    adc: await object(adcPath),
  })).digest("hex");
  return { home, method, settings: { auth, gcp: settings.gcp }, scope };
}

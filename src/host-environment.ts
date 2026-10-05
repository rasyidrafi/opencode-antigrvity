import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeCliAuthentication } from "./auth-bridge.js";

/** ACP supplies inference, OpenCode supplies tools. Do not import global MCP,
 * hooks, skills, or workspace hooks into this second harness. */
export async function hostEnvironment(environment: NodeJS.ProcessEnv, scope = "local") {
  await bridgeCliAuthentication(environment);
  const source = environment.GEMINI_HOME?.trim() || join(environment.HOME || homedir(), ".gemini");
  const data = environment.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
    join(environment.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode-antigravity");
  const key = createHash("sha256").update(`${source}:${scope}`).digest("hex");
  const home = join(data, "host-acp", key);
  const directory = join(home, "antigravity-acp");
  const cwd = join(home, "workspace");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  for (const name of ["acp_token.json", "acp_business_token.json", "settings.json"]) {
    let text: string;
    try { text = await readFile(join(source, "antigravity-acp", name), "utf8"); }
    catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      await rm(join(directory, name), { force: true });
      continue;
    }
    if (name === "settings.json") {
      const settings = JSON.parse(text);
      text = JSON.stringify({ auth: settings.auth, gcp: settings.gcp });
    }
    const target = join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  return { cwd, environment: { ...environment, GEMINI_HOME: home } };
}

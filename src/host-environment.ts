import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bridgeCliAuthentication } from "./auth-bridge.js";
import { effectiveAuth } from "./effective-auth.js";

/** ACP supplies inference, OpenCode supplies tools. Do not import global MCP,
 * hooks, skills, or workspace hooks into this second harness. */
export async function hostEnvironment(environment: NodeJS.ProcessEnv, scope = "local") {
  await bridgeCliAuthentication(environment);
  const effective = await effectiveAuth(environment);
  const source = effective.home;
  const data = environment.OPENCODE_ANTIGRAVITY_DATA_DIR?.trim() ||
    join(environment.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode-antigravity");
  const key = createHash("sha256").update(`${effective.scope}:${scope}`).digest("hex");
  const home = join(data, "host-acp", key);
  const directory = join(home, "antigravity-acp");
  const cwd = join(home, "workspace");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "conversations"), { recursive: true, mode: 0o700 });
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
      text = JSON.stringify(effective.settings);
    }
    const target = join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  // Explicit overrides also work when the source has no settings file.
  const settingsTarget = join(directory, "settings.json");
  const settingsTemporary = `${settingsTarget}.${randomUUID()}.tmp`;
  try {
    await writeFile(settingsTemporary, JSON.stringify(effective.settings), { mode: 0o600, flag: "wx" });
    await rename(settingsTemporary, settingsTarget);
  } finally { await rm(settingsTemporary, { force: true }); }
  return { cwd, environment: { ...environment, GEMINI_HOME: home } };
}

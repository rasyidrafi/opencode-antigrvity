import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hostEnvironment } from "../src/host-environment.js";

test("host ACP isolates global MCP, hooks and workspaces while retaining authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-host-env-"));
  const source = join(root, "gemini");
  await mkdir(join(source, "antigravity-acp"), { recursive: true });
  await mkdir(join(source, "config"));
  await writeFile(join(source, "config/mcp_config.json"), JSON.stringify({ mcpServers: { unwanted: { command: "bad" } } }));
  await writeFile(join(source, "config/hooks.json"), "{}");
  await writeFile(join(source, "antigravity-acp/acp_token.json"), '{"refresh_token":"fixture-only"}');
  await writeFile(join(source, "antigravity-acp/settings.json"), JSON.stringify({ auth: { type: "oauth-personal" }, gcp: { project: "fixture" }, tools: { unsafe: true } }));
  try {
    const options = { GEMINI_HOME: source, OPENCODE_ANTIGRAVITY_DATA_DIR: join(root, "data") };
    const a = await hostEnvironment(options, "account-a");
    const b = await hostEnvironment(options, "account-b");
    expect(a.environment.GEMINI_HOME).not.toBe(b.environment.GEMINI_HOME);
    expect(await readdir(a.cwd)).toEqual([]);
    expect(await readdir(a.environment.GEMINI_HOME)).toEqual(expect.arrayContaining(["workspace", "antigravity-acp"]));
    expect(await readdir(a.environment.GEMINI_HOME)).not.toContain("config");
    const auth = join(a.environment.GEMINI_HOME, "antigravity-acp");
    expect(JSON.parse(await readFile(join(auth, "settings.json"), "utf8"))).toEqual({ auth: { type: "oauth-personal" }, gcp: { project: "fixture" } });
    expect((await stat(join(auth, "acp_token.json"))).mode & 0o777).toBe(0o600);
    await rm(join(source, "antigravity-acp/acp_token.json"));
    await hostEnvironment(options, "account-a");
    expect(await readdir(auth)).not.toContain("acp_token.json");
  } finally { await rm(root, { recursive: true, force: true }); }
});

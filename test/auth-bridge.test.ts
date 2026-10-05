import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeCliAuthentication } from "../src/auth-bridge.js";

test("CLI login seeds and repairs ACP credentials, follows account changes, and preserves other auth modes", async () => {
  const home = await mkdtemp(join(tmpdir(), "antigravity-auth-"));
  const env = { GEMINI_HOME: home };
  const cliPath = join(home, "antigravity-cli", "antigravity-oauth-token");
  const acpPath = join(home, "antigravity-acp", "acp_token.json");
  const settingsPath = join(home, "antigravity-acp", "settings.json");
  const cli = JSON.stringify({ auth_method: "consumer", token: { refresh_token: "fixture-refresh", expiry: "not-google-auth-format" } });
  try {
    expect(await bridgeCliAuthentication(env)).toBe(false);
    await mkdir(join(home, "antigravity-cli"));
    await writeFile(cliPath, cli);
    expect(await bridgeCliAuthentication(env)).toBe(true);
    const generated = JSON.parse(await readFile(acpPath, "utf8"));
    expect(generated.refresh_token).toBe("fixture-refresh");
    expect(generated.client_id).toBeString();
    expect(generated).not.toHaveProperty("expiry");
    expect((await stat(acpPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(cliPath, "utf8")).toBe(cli);
    const modified = (await stat(acpPath)).mtimeMs;
    await bridgeCliAuthentication(env);
    expect((await stat(acpPath)).mtimeMs).toBe(modified);

    await writeFile(acpPath, "{corrupt");
    expect(await bridgeCliAuthentication(env)).toBe(true);
    expect(JSON.parse(await readFile(acpPath, "utf8")).refresh_token).toBe("fixture-refresh");
    await writeFile(cliPath, cli.replace("fixture-refresh", "second-account"));
    await bridgeCliAuthentication(env);
    expect(JSON.parse(await readFile(acpPath, "utf8")).refresh_token).toBe("second-account");

    await writeFile(settingsPath, JSON.stringify({ auth: { type: "oauth-business" }, other: true }));
    const saved = await readFile(acpPath, "utf8");
    expect(await bridgeCliAuthentication(env)).toBe(false);
    expect(await readFile(acpPath, "utf8")).toBe(saved);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).auth.type).toBe("oauth-business");
  } finally { await rm(home, { recursive: true, force: true }); }
});

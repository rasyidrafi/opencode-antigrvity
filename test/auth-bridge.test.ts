import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeCliAuthentication } from "../src/auth-bridge.js";
import { createAcpWorker } from "../src/acp-process.js";

test("workers start without CLI credentials; the CLI bridge is best-effort", async () => {
  const home = await mkdtemp(join(tmpdir(), "agy-cli-optional-"));
  const environment = { GEMINI_HOME: home };
  const options = { cwd: process.cwd(), executable: join(import.meta.dir, "fixtures/fake-acp.mjs"), environment, nonInteractive: true };
  try {
    // No agy CLI token at all: the worker still starts.
    const worker = await createAcpWorker(options);
    await worker.stop(true);

    // When a CLI token exists it is still bridged into the ACP credential file.
    await mkdir(join(home, "antigravity-cli"));
    await writeFile(join(home, "antigravity-cli/antigravity-oauth-token"), JSON.stringify({ auth_method: "consumer", token: { refresh_token: "cli-fixture" } }));
    const withCli = await createAcpWorker(options);
    await withCli.stop(true);
    expect(JSON.parse(await readFile(join(home, "antigravity-acp/acp_token.json"), "utf8")).refresh_token).toBe("cli-fixture");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("CLI login seeds and repairs ACP credentials and follows CLI account changes", async () => {
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

    // V0.2.0 copied Go's timezone/fractional expiry directly. google-auth can
    // misread that as a future UTC time and reuse an expired bearer token.
    await writeFile(acpPath, JSON.stringify({ ...generated, token: "expired-bearer", expiry: "2099-01-01T14:10:46.330765581+07:00" }));
    await bridgeCliAuthentication(env);
    const repaired = JSON.parse(await readFile(acpPath, "utf8"));
    expect(repaired).not.toHaveProperty("token");
    expect(repaired).not.toHaveProperty("expiry");
    expect(repaired.refresh_token).toBe("fixture-refresh");

    await writeFile(acpPath, "{corrupt");
    expect(await bridgeCliAuthentication(env)).toBe(true);
    expect(JSON.parse(await readFile(acpPath, "utf8")).refresh_token).toBe("fixture-refresh");
    await writeFile(cliPath, cli.replace("fixture-refresh", "second-account"));
    await bridgeCliAuthentication(env);
    expect(JSON.parse(await readFile(acpPath, "utf8")).refresh_token).toBe("second-account");

    await writeFile(settingsPath, JSON.stringify({ auth: { type: "oauth-business" }, other: true }));
    const saved = await readFile(acpPath, "utf8");
    expect(await bridgeCliAuthentication(env)).toBe(true);
    expect(await readFile(acpPath, "utf8")).toBe(saved);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ auth: { type: "oauth-personal" }, other: true });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("does not require an agy CLI token file when the ACP server has its own auth", async () => {
  const { requireCliAuthentication } = await import("../src/auth-bridge.js");
  const home = await mkdtemp(join(tmpdir(), "opencode-antigravity-no-cli-"));
  try {
    // No antigravity-cli token exists under this home. The server may still be
    // authenticated through its own store (keychain on macOS, acp_token.json).
    await expect(requireCliAuthentication({ ...process.env, HOME: home, GEMINI_HOME: home })).resolves.toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

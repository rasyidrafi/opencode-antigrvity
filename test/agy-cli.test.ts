import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { agyAcpArgs, agyProfileScope, assertAgyCliCompatibility, cliHostEnvironment, resolveAgyCli } from "../src/agy-cli.js";
import { AgyError } from "../src/errors.js";

test("CLI discovery skips unreviewed implicit candidates but does not fall back from an override", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-discovery-"));
  try {
    const name = process.platform === "win32" ? "agy.exe" : "agy";
    const directories = [join(root, "shim"), join(root, "native")];
    const [first, second] = directories.map(directory => join(directory, name));
    for (const directory of directories) {
      await mkdir(directory);
      await writeFile(join(directory, name), "offline fixture", { mode: 0o755 });
    }
    const env = { PATH: directories.join(delimiter) };
    const validate = async (path: string) => {
      if (path.endsWith(join("shim", name))) throw new AgyError("unsupported", "Unreviewed shim");
    };
    expect(await resolveAgyCli(validate, env)).toEndWith(join("native", name));
    await expect(resolveAgyCli(validate, { ...env, OPENCODE_ANTIGRAVITY_ACP_PATH: first })).rejects.toThrow("Unreviewed shim");
    await expect(resolveAgyCli(assertAgyCliCompatibility, { ...env, OPENCODE_ANTIGRAVITY_ACP_PATH: second })).rejects.toMatchObject({ code: "agy_cli_isolation_unverified" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the CLI uses a private profile and fixed ACP arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-profile-"));
  try {
    const isolated = await cliHostEnvironment({ OPENCODE_ANTIGRAVITY_DATA_DIR: root, GEMINI_HOME: join(root, "terminal"), GEMINI_API_KEY: "unused", OPENCODE_ANTIGRAVITY_ACP_ARGS: '["--login"]' });
    const profile = join(root, "agy-cli-profile", "signed-out");
    expect(isolated.environment.GEMINI_HOME).toBe(profile);
    expect(isolated.environment.GEMINI_API_KEY).toBeUndefined();
    expect(agyAcpArgs(profile)).toEqual(["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp", "--include-default-customizations=false"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("credential staging rejects a different account than the catalog observed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-account-change-"));
  try {
    const env = { GEMINI_HOME: root, OPENCODE_ANTIGRAVITY_DATA_DIR: root };
    const cli = join(root, "antigravity-cli");
    await mkdir(cli);
    const token = join(cli, "antigravity-oauth-token");
    await writeFile(token, JSON.stringify({ token: { refresh_token: "synthetic-a" } }));
    const scope = await agyProfileScope(env);
    await writeFile(token, JSON.stringify({ token: { refresh_token: "synthetic-b" } }));
    await expect(cliHostEnvironment(env, undefined, scope.revision)).rejects.toMatchObject({ code: "agy_cli_account_changed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registry stages the correct credential and strips inherited customization and harness overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-registry-profile-"));
  try {
    const env = { GEMINI_HOME: root, OPENCODE_ANTIGRAVITY_DATA_DIR: root, ANTIGRAVITY_HARNESS_PATH: "/wrong-harness", PYTHONPATH: "/wrong-python", XDG_CONFIG_HOME: "/wrong-config" };
    await expect(cliHostEnvironment(env, undefined, undefined, true)).rejects.toMatchObject({ code: "agy_cli_auth_required" });
    await mkdir(join(root, "antigravity-acp"));
    await writeFile(join(root, "antigravity-acp", "acp_token.json"), JSON.stringify({ refresh_token: "stale-registry" }));
    await expect(cliHostEnvironment(env, undefined, undefined, true)).rejects.toMatchObject({ code: "agy_cli_auth_required" });
    await mkdir(join(root, "antigravity-cli"));
    const credential = JSON.stringify({ token: { refresh_token: "synthetic-cli", access_token: "not-staged" } });
    const source = join(root, "antigravity-cli", "antigravity-oauth-token");
    await writeFile(source, credential);
    const { revision } = await agyProfileScope(env, true);
    const profiles = await Promise.all(Array.from({ length: 6 }, () => cliHostEnvironment(env, undefined, revision, true)));
    const profile = profiles[0].environment;
    expect(profile.ANTIGRAVITY_HARNESS_PATH).toBeUndefined();
    expect(profile.PYTHONPATH).toBeUndefined();
    expect(profile.XDG_CONFIG_HOME).toBe(join(profile.GEMINI_HOME!, ".config"));
    const staged = JSON.parse(await readFile(join(profile.GEMINI_HOME!, "antigravity-acp", "acp_token.json"), "utf8"));
    expect(staged.refresh_token).toBe("synthetic-cli");
    expect(staged.access_token).toBeUndefined();
    expect(await readFile(source, "utf8")).toBe(credential);
    expect(JSON.parse(await readFile(join(profile.GEMINI_HOME!, "antigravity-acp", "settings.json"), "utf8"))).toEqual({ auth: { type: "oauth-personal" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

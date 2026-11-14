import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readWindowsCliCredential, resolveCliRefreshToken } from "../src/cli-credentials.js";
import { requireCliAuthentication } from "../src/auth-bridge.js";
import { effectiveAuth } from "../src/effective-auth.js";
import { discoveryTimeoutMs } from "../src/model-catalog.js";

const fixture = (revision: string) => JSON.stringify({ auth_method: "consumer", token: { refresh_token: revision } });

test("native discovery deadlines allow slow Windows cold start but stay bounded", () => {
  expect(discoveryTimeoutMs("win32")).toBe(120_000);
  expect(discoveryTimeoutMs("linux")).toBe(45_000);
  expect(discoveryTimeoutMs("darwin")).toBe(45_000);
});

test("file-backed auth scopes and bridging follow account changes and signout", async () => {
  const home = await mkdtemp(join(tmpdir(), "agy-file-revision-"));
  const environment = { GEMINI_HOME: home };
  const path = join(home, "antigravity-cli", "antigravity-oauth-token");
  try {
    await mkdir(join(home, "antigravity-cli"));
    await writeFile(path, fixture("synthetic-first"));
    await requireCliAuthentication(environment);
    const first = await effectiveAuth(environment);
    await writeFile(path, fixture("synthetic-second"));
    const second = await effectiveAuth(environment);
    expect(second.scope).not.toBe(first.scope);
    await requireCliAuthentication(environment);
    await rm(path);
    expect((await effectiveAuth(environment)).scope).not.toBe(second.scope);
    // Signout removes the bridge source but does not block workers: the ACP
    // server may still hold its own credentials and reports auth itself.
    await expect(requireCliAuthentication(environment)).resolves.toBeUndefined();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Windows keyring resolver tracks account changes/signout and isolates custom homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-credential-"));
  const environment = { HOME: root, GEMINI_HOME: join(root, ".gemini") };
  let raw: string | undefined = fixture("synthetic-first");
  let reads = 0;
  const options = { platform: "win32" as const, nativeHome: root, readKeyring: async () => { reads++; return raw; } };
  try {
    expect(await resolveCliRefreshToken(environment, options)).toBe("synthetic-first");
    raw = fixture("synthetic-second");
    expect(await resolveCliRefreshToken(environment, options)).toBe("synthetic-second");
    raw = undefined;
    expect(await resolveCliRefreshToken(environment, options)).toBeUndefined();
    const directory = join(root, ".gemini", "antigravity-cli");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "antigravity-oauth-token"), fixture("synthetic-file"));
    expect(await resolveCliRefreshToken(environment, options)).toBe("synthetic-file");
    for (raw of ["not json", JSON.stringify({ auth_method: "gcp", token: { refresh_token: "wrong" } }), fixture("")]) {
      expect(await resolveCliRefreshToken(environment, options)).toBeUndefined();
    }
    const before = reads;
    expect(await resolveCliRefreshToken({ ...environment, GEMINI_HOME: join(root, "custom") }, options)).toBeUndefined();
    expect(await resolveCliRefreshToken({ HOME: join(root, "other"), GEMINI_HOME: environment.GEMINI_HOME }, options)).toBe("synthetic-file");
    expect(reads).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// This writer is test-only, gated to disposable native Actions runners. It
// never runs against a developer's credential store or accepts real secrets.
async function setNativeFixture(revision?: string) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FixtureCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Delete(string target, uint type, uint flags);
}
'@
if ($env:AGY_SYNTHETIC_FIXTURE) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($env:AGY_SYNTHETIC_FIXTURE)
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
    $credential = New-Object FixtureCredential+Credential
    $credential.Type = 1
    $credential.TargetName = 'gemini:antigravity'
    $credential.UserName = 'synthetic-actions-fixture'
    $credential.CredentialBlobSize = $bytes.Length
    $credential.CredentialBlob = $pointer
    $credential.Persist = 2
    if (-not [FixtureCredential]::Write([ref]$credential, 0)) { throw 'Fixture write failed' }
  } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
} else {
  if (-not [FixtureCredential]::Delete('gemini:antigravity', 1, 0)) { throw 'Fixture delete failed' }
}
`;
  await promisify(execFile)(join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, AGY_SYNTHETIC_FIXTURE: revision === undefined ? "" : fixture(revision) }, timeout: 10_000, windowsHide: true });
}

test.skipIf(process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.AGY_TEST_NATIVE_KEYRING !== "1")(
  "native CredWrite/Read/Delete recognizes login, rotates scope/ACP token and rejects signout", async () => {
    const home = join(homedir(), ".gemini");
    const environment = { ...process.env, HOME: homedir(), GEMINI_HOME: home };
    expect(await readWindowsCliCredential(environment)).toBeUndefined();
    const cliPath = join(home, "antigravity-cli", "antigravity-oauth-token");
    await expect(access(cliPath)).rejects.toThrow();
    await expect(access(join(home, "antigravity-acp"))).rejects.toThrow();
    let written = false;
    try {
      await setNativeFixture("synthetic-first"); written = true;
      expect(await resolveCliRefreshToken(environment)).toBe("synthetic-first");
      await requireCliAuthentication(environment);
      const first = await effectiveAuth(environment);
      await setNativeFixture("synthetic-second");
      const second = await effectiveAuth(environment);
      expect(second.scope).not.toBe(first.scope);
      expect(second.scope).not.toContain("synthetic");
      await requireCliAuthentication(environment);
      expect(JSON.parse(await readFile(join(home, "antigravity-acp/acp_token.json"), "utf8")).refresh_token).toBe("synthetic-second");
      await setNativeFixture(); written = false;
      expect(await readWindowsCliCredential(environment)).toBeUndefined();
      expect((await effectiveAuth(environment)).scope).not.toBe(second.scope);
      await expect(requireCliAuthentication(environment)).rejects.toMatchObject({ code: "agy_cli_auth_required" });
      await expect(access(cliPath)).rejects.toThrow();
    } finally {
      if (written) await setNativeFixture();
      await rm(join(home, "antigravity-acp"), { recursive: true, force: true });
    }
  }, 120_000);

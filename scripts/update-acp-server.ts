#!/usr/bin/env bun
/**
 * Syncs the pinned Antigravity ACP server version and the host-tool
 * compatibility hashes with the official ACP registry.
 *
 *   bun scripts/update-acp-server.ts           # report and write changes
 *   bun scripts/update-acp-server.ts --check   # report only, exit 1 if stale
 *
 * The registry entry (agentclientprotocol/registry, antigravity-acp) is Google's
 * own listing. Hashes certify byte identity against those archives; they do not
 * prove the tool-filter behavior was reviewed, which the compatibility gate
 * expects for each platform it trusts.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";

const REGISTRY_URL = "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";
const INSTALL_FILE = join(import.meta.dir, "..", "src", "acp-install.ts");
const COMPAT_FILE = join(import.meta.dir, "..", "src", "acp-compatibility.ts");

type Target = {
  profile: string;
  registry: string;
  executable: string;
  companion: string;
};

const TARGETS: Target[] = [
  { profile: "linux-x64", registry: "linux-x86_64", executable: "agy_acp_server.par", companion: "localharness_external" },
  { profile: "win32-x64", registry: "windows-x86_64", executable: "agy_acp_server.exe", companion: "localharness_external.exe" },
  { profile: "darwin-arm64", registry: "darwin-aarch64", executable: "agy_acp_server.par", companion: "localharness_external" },
];

const check = process.argv.includes("--check");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function extract(bytes: Uint8Array, names: readonly string[]): Record<string, Uint8Array> {
  const files = unzipSync(bytes, {
    filter: (file) => names.includes(file.name.split("/").at(-1) ?? ""),
  });
  const found: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    const name = path.split("/").at(-1)!;
    if (found[name]) throw new Error(`duplicate ${name} in archive`);
    if (!content.length) throw new Error(`empty ${name} in archive`);
    found[name] = content;
  }
  for (const name of names) if (!found[name]) throw new Error(`archive is missing ${name}`);
  return found;
}

async function main() {
  const registry = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(30_000) });
  if (!registry.ok) throw new Error(`registry fetch failed: HTTP ${registry.status}`);
  const entry = (await registry.json()) as {
    version: string;
    distribution: { binary: Record<string, { archive: string }> };
  };
  const latest = entry.version;
  const installSource = await readFile(INSTALL_FILE, "utf8");
  const compatSource = await readFile(COMPAT_FILE, "utf8");
  const pinned = /export const ACP_VERSION = "([^"]+)"/.exec(installSource)?.[1];
  if (!pinned) throw new Error("could not read ACP_VERSION from src/acp-install.ts");

  console.log(`registry: ${latest}   pinned: ${pinned}`);
  if (pinned === latest) {
    console.log("ACP server is up to date.");
    return 0;
  }

  const updates: Array<{ target: Target; hashes: [string, string] }> = [];
  for (const target of TARGETS) {
    const binary = entry.distribution.binary[target.registry];
    if (!binary?.archive) throw new Error(`registry has no archive for ${target.registry}`);
    const archive = await fetch(binary.archive, { signal: AbortSignal.timeout(120_000) });
    if (!archive.ok) throw new Error(`${target.registry} download failed: HTTP ${archive.status}`);
    const files = extract(new Uint8Array(await archive.arrayBuffer()), [target.executable, target.companion]);
    updates.push({ target, hashes: [sha256(files[target.executable]), sha256(files[target.companion])] });
    console.log(`${target.profile}: ${updates.at(-1)!.hashes.join(" ")}`);
  }

  if (check) {
    console.log(`stale: ${pinned} -> ${latest} (rerun without --check to write)`);
    return 1;
  }

  const nextInstall = installSource.replace(/(export const ACP_VERSION = ")[^"]+(")/, `$1${latest}$2`);
  let nextCompat = compatSource;
  for (const { target, hashes } of updates) {
    const pattern = new RegExp(`("${target.profile}": )\\["[^"]*", "[^"]*"\\]`);
    if (!pattern.test(nextCompat)) throw new Error(`no profile entry for ${target.profile}`);
    nextCompat = nextCompat.replace(pattern, `$1["${hashes[0]}", "${hashes[1]}"]`);
  }
  await writeFile(INSTALL_FILE, nextInstall);
  await writeFile(COMPAT_FILE, nextCompat);
  console.log(`\nupdated ACP_VERSION ${pinned} -> ${latest} and ${updates.length} profile(s).`);
  console.log("Note: hashes certify the official archives only. The compatibility gate still expects a manual tool-filter review per platform.");
  return 0;
}

process.exit(await main());

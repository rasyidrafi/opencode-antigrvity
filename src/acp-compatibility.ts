import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { AgyError } from "./errors.js";
import { acpDistribution } from "./acp-install.js";

// Official Google distribution inspected for tool-filter implementation and
// verified against the official 1.3.0 archives. The Windows PyInstaller
// bytecode was reviewed for ToolFilterConfig -> _create_agent_config wiring:
// an empty enabledTools list disables built-ins and subagents, including the
// safe_view_file substitute. Windows runtime inference is not yet verified.
// Version strings alone are not a compatibility profile.
// Hashes are re-pinned by scripts/update-acp-server.ts from the official
// registry. The review notes in this file describe the 1.3.0 binaries; they
// have not been re-verified against the version the hashes currently name.
const profiles: Record<string, [string, string]> = {
  "linux-x64": ["7e7019c8989ca066cbac4d6580552b7a4ad39485dd6b6fd81de9daa9a7b39042", "6c6d28b61a704e9bae4351ea8c4ad4b8b0aba7e1f1027bdf1017401b9c6e18c0"],
  "win32-x64": ["ccca30a4aef1b915b0d8baa17b149de6cda305841fa27717e52c529bb462c51d", "98f808f7796c0a06d104715dbef65025e57243106fff5935d9bedd5843f03cda"],
  // macOS ARM64 PAR's embedded tool_filter.py/server.py reviewed: [] becomes
  // an empty allowlist, disables all built-ins including safe_view_file and
  // subagents/browser; create, restore and rebuild preserve the filter.
  // Static isolation review, not authenticated runtime inference verification.
  "darwin-arm64": ["fb2581fb49738263db15ffccf3f48d979794ffb748350e85c335953f6b6522a2", "9d87cb505e6efa316f55bb98459de614de867dce43cdeb5677b2153d77c283e8"],
};
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertHostToolCompatibility(executable: string, platform = process.platform, arch = process.arch): Promise<void> {
  const profile = profiles[`${platform}-${arch}`];
  try {
    if (profile && await sha256(executable) === profile[0] && await sha256(join(dirname(executable), acpDistribution(platform, arch).companion)) === profile[1]) return;
  } catch { /* Missing companion or unknown executable fails closed. */ }
  throw new AgyError("unsupported", `This ACP executable pair does not match a reviewed host-tool isolation profile for ${platform}-${arch}. Use the official Antigravity 1.3.0 Linux x64, Windows x64 or macOS ARM64 distribution, including its platform-specific companion. Other platforms/builds require a reviewed profile; version text and executable overrides are not sufficient.`, { code: "agy_acp_compatibility" });
}

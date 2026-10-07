import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { AgyError } from "./errors.js";

// Official Google distribution inspected for tool-filter implementation and
// verified locally against the 1.3.0 archive. Version strings alone are not a
// compatibility profile. Additional platforms/builds need equivalent review.
const profiles: Record<string, [string, string]> = {
  "linux-x64": ["cf6feaebdacfc2255dcfc8883db99b15de8554698554e2a1e78e5ccec1c68a20", "63042ca43fc7a69600683920f7706689b82cf8aecefe21dc18cf35e99c9dde4d"],
};
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertHostToolCompatibility(executable: string): Promise<void> {
  const profile = profiles[`${process.platform}-${process.arch}`];
  try {
    if (profile && await sha256(executable) === profile[0] && await sha256(join(dirname(executable), "localharness_external")) === profile[1]) return;
  } catch { /* Missing companion or unknown executable fails closed. */ }
  throw new AgyError("unsupported", "This ACP executable has no tested host-tool isolation profile. Use the official Antigravity 1.3.0 Linux x64 ACP distribution (including its companion), or request a reviewed compatibility profile for your platform/build. Version text and executable overrides cannot establish tool-filter safety.", { code: "agy_acp_compatibility" });
}

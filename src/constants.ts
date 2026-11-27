import { AgyError } from "./errors.js";

export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";
export const HOST_MCP_SERVER_NAME = "external_tool";
/** A deliberately non-secret value used by the loopback adapter. */
export const LOCAL_API_KEY = "opencode-antigravity-local";

export const DEFAULT_PRINT_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TURN_STALL_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_IDLE_WORKER_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_QUEUE_PER_SESSION = 1;
export const DEFAULT_MAX_SESSIONS = 128;
export const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
// 32 MiB decoded images expand to ~43 MiB base64; leave bounded JSON/text room.
export const DEFAULT_MAX_REQUEST_BYTES = 48 * 1024 * 1024;
export const DEFAULT_REQUEST_READ_TIMEOUT_MS = 30_000;
export const DEFAULT_HISTORY_MAX_CHARS = 100_000;
export const DEFAULT_UTILITY_MAX_CHARS = 24_000;
export const DEFAULT_SSE_HEARTBEAT_MS = 5_000;

export const MODEL_HEADER = "x-opencode-antigravity-model";
export const EFFORT_HEADER = "x-opencode-antigravity-effort";
export const SESSION_HEADER = "x-opencode-antigravity-session";
export const FORK_HEADER = "x-opencode-antigravity-fork";
export const DIRECTORY_HEADER = "x-opencode-antigravity-directory";
export const MESSAGE_HEADER = "x-opencode-antigravity-message";
export const REQUEST_KIND_HEADER = "x-opencode-antigravity-request-kind";
export const REQUEST_TOKEN_HEADER = "x-opencode-antigravity-token";

export const SUPPORTED_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type AcpEffort = (typeof SUPPORTED_EFFORTS)[number];

export const ACP_CLIENT_NAME = "opencode-antigravity";
export const ZED_CLIENT_NAME = "zed";
export const ACP_CLIENT_VERSION = "0.8.0";

export type AcpClientIdentity = { name: string; version: string };

/** Optional explicit ACP `clientInfo`. By default `clientInfo` is omitted
 * entirely (the long-standing behaviour). Setting
 * `OPENCODE_ANTIGRAVITY_CLIENT_NAME=zed` (or the plugin option
 * `clientName: "zed"`) sends an explicit
 * `clientInfo: { name: "zed", version: "0.8.0" }` on every handshake
 * (discovery, pooled and utility workers). Only `zed` is accepted;
 * the value is pinned to the shared runtime and a conflicting
 * selection for an already-running runtime is rejected. */
export function configuredClientIdentity(): AcpClientIdentity | undefined {
  const raw = process.env.OPENCODE_ANTIGRAVITY_CLIENT_NAME?.trim();
  if (raw === undefined || raw === "") return undefined;
  return clientIdentityForName(raw);
}

export function clientIdentityForName(raw: string): AcpClientIdentity | undefined {
  if (raw.trim() === ZED_CLIENT_NAME) return { name: ZED_CLIENT_NAME, version: ACP_CLIENT_VERSION };
  throw new AgyError("invalid_request", `Unsupported OPENCODE_ANTIGRAVITY_CLIENT_NAME "${raw}". Only "zed" is supported.`, { code: "agy_client_name_invalid" });
}

/** Antigravity's own tool approvals. OpenCode's tools are gated by OpenCode. */
export type AcpPermissionPolicy = "allow" | "deny";

export function configuredPermissionPolicy(): AcpPermissionPolicy {
  const value = process.env.OPENCODE_ANTIGRAVITY_ACP_PERMISSION?.trim().toLowerCase();
  return value === "allow" || value === "allow-always" ? "allow" : "deny";
}

export function envNumber(name: string, fallback: number, minimum = 0): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export function envBoolean(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function configuredPrintTimeoutMs(): number {
  return envNumber(
    "OPENCODE_ANTIGRAVITY_PRINT_TIMEOUT_MS",
    DEFAULT_PRINT_TIMEOUT_MS,
    1_000,
  );
}

export function configuredTurnStallTimeoutMs(): number {
  return envNumber(
    "OPENCODE_ANTIGRAVITY_TURN_STALL_MS",
    DEFAULT_TURN_STALL_TIMEOUT_MS,
    1_000,
  );
}

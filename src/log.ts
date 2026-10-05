import { envBoolean } from "./constants.js";

const DEBUG = envBoolean("OPENCODE_ANTIGRAVITY_DEBUG", false);

function safeScalar(value: unknown): string {
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (value && typeof value === "object") return "[object]";
  return typeof value;
}

/**
 * Logs are intentionally metadata-only. In particular, callers should never
 * pass prompts, environment objects, authorization headers, tool arguments,
 * stderr, or model output here.
 */
export function log(level: "debug" | "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>): void {
  if (level === "debug" && !DEBUG) return;
  const suffix = metadata
    ? ` ${Object.entries(metadata)
        .filter(([key]) => !/(token|secret|password|auth|credential|prompt|content|argument|header|env|stderr)/i.test(key))
        .map(([key, value]) => `${key}=${safeScalar(value)}`)
        .join(" ")}`
    : "";
  const line = `[opencode-antigravity] ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "info") console.info(line);
  else console.debug(line);
}

export const debug = (message: string, metadata?: Record<string, unknown>) => log("debug", message, metadata);
export const info = (message: string, metadata?: Record<string, unknown>) => log("info", message, metadata);
export const warn = (message: string, metadata?: Record<string, unknown>) => log("warn", message, metadata);
export const error = (message: string, metadata?: Record<string, unknown>) => log("error", message, metadata);

export type AgyFailureKind =
  | "auth"
  | "context_overflow"
  | "quota"
  | "rate_limit"
  | "overload"
  | "refusal"
  | "timeout"
  | "protocol"
  | "unknown_model"
  | "unsupported"
  | "busy"
  | "process"
  | "invalid_request"
  | "internal";

const STATUS_BY_KIND: Record<AgyFailureKind, number> = {
  auth: 401,
  context_overflow: 400,
  quota: 429,
  rate_limit: 429,
  overload: 503,
  refusal: 400,
  timeout: 504,
  protocol: 502,
  unknown_model: 400,
  unsupported: 400,
  busy: 409,
  process: 502,
  invalid_request: 400,
  internal: 500,
};

export class AgyError extends Error {
  readonly kind: AgyFailureKind;
  readonly status: number;
  readonly retryable: boolean;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: AgyFailureKind,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      code?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgyError";
    this.kind = kind;
    this.status = options.status ?? STATUS_BY_KIND[kind];
    this.retryable = options.retryable ?? (kind === "quota" || kind === "rate_limit" || kind === "overload" || kind === "timeout");
    this.code = options.code ?? `agy_${kind}`;
    this.details = options.details;
  }
}

export class AgyProtocolError extends AgyError {
  constructor(message: string, cause?: unknown) {
    super("protocol", message, { cause, code: "agy_protocol_error" });
    this.name = "AgyProtocolError";
  }
}

export class AgyProcessError extends AgyError {
  constructor(message: string, cause?: unknown) {
    super("process", message, { cause, code: "agy_process_error" });
    this.name = "AgyProcessError";
  }
}

export class AgyTimeoutError extends AgyError {
  constructor(message: string, cause?: unknown) {
    super("timeout", message, { cause, code: "agy_timeout" });
    this.name = "AgyTimeoutError";
  }
}

export class UnsupportedMediaError extends AgyError {
  constructor(kind: string) {
    super(
      "unsupported",
       `Unsupported OpenCode content part type "${kind}" for the official Antigravity server.`,
      { code: "agy_unsupported_content" },
    );
    this.name = "UnsupportedMediaError";
  }
}

export class AgyBusyError extends AgyError {
  constructor(message = "Another Antigravity turn is already active for this session.") {
    super("busy", message, { code: "agy_session_busy", retryable: true });
    this.name = "AgyBusyError";
  }
}

export class AgyAbortError extends AgyError {
  constructor(message = "The Antigravity request was cancelled.") {
    super("timeout", message, {
      code: "agy_cancelled",
      retryable: false,
      status: 499,
    });
    this.name = "AgyAbortError";
  }
}

export function asAgyError(error: unknown, fallback = "Antigravity request failed"): AgyError {
  if (error instanceof AgyError) return error;
  if (error instanceof Error) return new AgyError("internal", error.message || fallback, { cause: error });
  return new AgyError("internal", fallback, { details: { error: String(error) } });
}

export function retryAfterSeconds(error: AgyError): number | undefined {
  if (error.kind !== "quota" && error.kind !== "rate_limit" && error.kind !== "overload") return undefined;
  const milliseconds = error.details?.retryAfterMs;
  if (typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds >= 0) return Math.max(1, Math.ceil(milliseconds / 1000));
  const retryAt = error.details?.retryAt;
  if (typeof retryAt === "number" && Number.isFinite(retryAt)) return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
  const hint = error.details?.retryAfter ?? error.details?.retry_after ?? retryAt;
  const text = typeof hint === "string" || typeof hint === "number" ? String(hint) : error.message;
  const match = text.match(/(?:^|retry[^0-9]*|reset[^0-9]*)(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)\b/i);
  if (match) return Math.max(1, Math.ceil(Number(match[1]) * (/^(ms|millisecond)/i.test(match[2]) ? 0.001 : /^(m|min)/i.test(match[2]) ? 60 : 1)));
  if (hint !== undefined && /^\d+(?:\.\d+)?$/.test(text)) return Math.max(1, Math.ceil(Number(text)));
  const timestampText = hint !== undefined ? text : error.message.match(/(?:retry|reset)\s+(?:at|on)\s+(.+)$/i)?.[1];
  const timestamp = timestampText ? Date.parse(timestampText) : NaN;
  return Number.isFinite(timestamp) ? Math.max(1, Math.ceil((timestamp - Date.now()) / 1000)) : 60;
}

export type AgyFailureKind =
  | "auth"
  | "quota"
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
  quota: 429,
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
    this.retryable = options.retryable ?? (kind === "quota" || kind === "timeout");
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
       `Unsupported OpenCode content part type "${kind}" for the official Antigravity ACP server.`,
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

export function asAgyError(error: unknown, fallback = "Antigravity ACP request failed"): AgyError {
  if (error instanceof AgyError) return error;
  if (error instanceof Error) return new AgyError("internal", error.message || fallback, { cause: error });
  return new AgyError("internal", fallback, { details: { error: String(error) } });
}

export function retryAfterSeconds(error: AgyError): number | undefined {
  if (error.kind !== "quota") return undefined;
  const match = error.message.match(/(?:retry|reset)[^0-9]*(\d+)\s*(?:s|sec|second)/i);
  return match ? Math.max(1, Number(match[1])) : 60;
}

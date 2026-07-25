export type YandexErrorCode =
  | "AUTH"
  | "PERMISSION"
  | "NOT_FOUND"
  | "VALIDATION"
  | "RATE_LIMIT"
  | "YANDEX_API"
  | "NETWORK"
  | "TIMEOUT"
  | "NOT_CONFIGURED";

export class YandexApiError extends Error {
  public readonly code: YandexErrorCode;
  public readonly status?: number;
  public readonly requestId?: string;
  public readonly retryAfterMs?: number;
  public readonly details?: unknown;

  public constructor(
    code: YandexErrorCode,
    message: string,
    options: {
      status?: number;
      requestId?: string;
      retryAfterMs?: number;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "YandexApiError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function classifyHttpStatus(status: number): YandexErrorCode {
  if (status === 401) return "AUTH";
  if (status === 403) return "PERMISSION";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 400 && status < 500) return "VALIDATION";
  return "YANDEX_API";
}

export function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof YandexApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }

  return {
    code: "YANDEX_API",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}

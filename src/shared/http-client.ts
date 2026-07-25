import { classifyHttpStatus, YandexApiError } from "./errors.js";

export type QueryValue =
  string | number | boolean | readonly (string | number | boolean)[] | null | undefined;

export interface HttpClientOptions {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
  maxRetries: number;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  responseType?: "json" | "text";
  retryable?: boolean;
}

function appendQuery(url: URL, query: Record<string, QueryValue>): void {
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === null || rawValue === undefined) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      url.searchParams.append(key, String(value));
    }
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getApiMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const direct = record.message ?? record.error;
    if (typeof direct === "string") return direct;
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      const first = record.errors[0];
      if (first && typeof first === "object") {
        const message = (first as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
    }
  }
  return `Yandex API returned HTTP ${status}`;
}

export class YandexHttpClient {
  private readonly baseUrl: URL;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImplementation: typeof globalThis.fetch;

  public constructor(options: HttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  public async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (!this.token) {
      throw new YandexApiError(
        "NOT_CONFIGURED",
        "OAuth token for this Yandex service is not configured",
      );
    }

    const method = options.method ?? "GET";
    const retryable = options.retryable ?? method === "GET";

    for (let attempt = 0; ; attempt += 1) {
      const url = new URL(path.replace(/^\//, ""), this.baseUrl);
      if (options.query) appendQuery(url, options.query);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImplementation(url, {
          method,
          headers: {
            Authorization: `OAuth ${this.token}`,
            Accept: "application/json",
            ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });

        const requestId =
          response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

        if (!response.ok) {
          const payload = await response.json().catch(() => undefined);
          const canRetry =
            retryable &&
            attempt < this.maxRetries &&
            (response.status === 429 || response.status >= 500);

          if (canRetry) {
            await sleep(retryAfterMs ?? Math.min(10_000, 250 * 2 ** attempt + Math.random() * 200));
            continue;
          }

          throw new YandexApiError(
            classifyHttpStatus(response.status),
            getApiMessage(payload, response.status),
            {
              status: response.status,
              ...(requestId ? { requestId } : {}),
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            },
          );
        }

        if (response.status === 204) return undefined as T;
        if (options.responseType === "text") return (await response.text()) as T;
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof YandexApiError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new YandexApiError("TIMEOUT", "Yandex API request timed out", {
            cause: error,
          });
        }
        if (retryable && attempt < this.maxRetries) {
          await sleep(Math.min(10_000, 250 * 2 ** attempt + Math.random() * 200));
          continue;
        }
        throw new YandexApiError("NETWORK", "Could not reach Yandex API", {
          cause: error,
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

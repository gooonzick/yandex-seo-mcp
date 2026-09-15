import { classifyHttpStatus, YandexApiError } from "../shared/errors.js";
import { telemetry } from "../shared/telemetry.js";
import { parseDirectJson, stringifyDirectJson } from "./json.js";

export interface DirectClientOptions {
  token?: string;
  clientLogin?: string;
  sandbox?: boolean;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export interface DirectResponse {
  result: Record<string, unknown>;
  requestId: string | null;
  units: string | null;
  partialFailure: boolean;
}

export class DirectClient {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(private readonly options: DirectClientOptions) {}

  public async rpc(
    service: string,
    method: string,
    params: Record<string, unknown>,
    version: "v5" | "v501" = "v501",
  ): Promise<DirectResponse> {
    if (!/^[a-z]+$/.test(service) || !/^[a-zA-Z]+$/.test(method)) {
      throw new YandexApiError("VALIDATION", "Invalid Direct service or method");
    }
    const response = await this.request(
      `${version}/${service}`,
      { method, params },
      method === "get",
    );
    const payload = this.readPayload(response.text, response.status, response.requestId);
    const result = payload.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new YandexApiError("YANDEX_API", "Direct response is missing result");
    }
    const partialFailure = Object.values(result).some(
      (items) =>
        Array.isArray(items) &&
        items.some(
          (item: unknown) =>
            item &&
            typeof item === "object" &&
            "Errors" in item &&
            Array.isArray(item.Errors) &&
            item.Errors.length > 0,
        ),
    );
    return {
      result: result as Record<string, unknown>,
      requestId: response.requestId,
      units: response.units,
      partialFailure,
    };
  }

  // An offline report is resumed by submitting the identical specification again.
  // Returning pending avoids occupying an MCP request for several minutes.
  public async report(
    spec: Record<string, unknown>,
    maxRows: number,
  ): Promise<Record<string, unknown>> {
    const response = await this.request("v5/reports", { params: spec }, true, {
      processingMode: "auto",
      returnMoneyInMicros: "false",
      skipReportHeader: "true",
      skipColumnHeader: "false",
      skipReportSummary: "true",
    });
    const metadata = { requestId: response.requestId, units: response.units };
    if (response.status === 201 || response.status === 202) {
      return {
        status: "pending",
        retryAfterSeconds: response.retryIn,
        reportSpec: spec,
        ...metadata,
      };
    }
    if (response.status !== 200 || response.text.trimStart().startsWith("{")) {
      this.readPayload(response.text, response.status, response.requestId);
      throw new YandexApiError("YANDEX_API", "Unexpected Direct report response");
    }
    const lines = response.text
      .replace(/^\uFEFF/, "")
      .trimEnd()
      .split(/\r?\n/);
    const columns = (lines.shift() ?? "").split("\t");
    const records = lines.filter((line) => line.length > 0);
    const rows = records.slice(0, maxRows).map((line) => {
      const cells = line.split("\t");
      return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ""]));
    });
    return {
      status: "ready",
      columns,
      rows,
      totalRows: records.length,
      truncated: records.length > maxRows,
      moneyInMicros: false,
      ...metadata,
    };
  }

  private readPayload(
    text: string,
    status: number,
    requestId: string | null,
  ): Record<string, unknown> {
    let payload: Record<string, unknown>;
    try {
      const parsed = parseDirectJson(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new YandexApiError(
        "YANDEX_API",
        `Invalid Direct JSON response (HTTP ${status})`,
        requestId ? { requestId } : {},
      );
    }
    if (payload.error || status >= 400) {
      const error =
        payload.error && typeof payload.error === "object"
          ? (payload.error as Record<string, unknown>)
          : {};
      const code = Number(error.error_code);
      const classification =
        code === 53
          ? "AUTH"
          : code === 54
            ? "PERMISSION"
            : code === 152
              ? "RATE_LIMIT"
              : status >= 400
                ? classifyHttpStatus(status)
                : "YANDEX_API";
      // Do not echo upstream strings: they can include submitted values or credentials.
      throw new YandexApiError(
        classification,
        `Direct API error ${Number.isFinite(code) ? code : status}`,
        {
          status,
          ...(requestId ? { requestId } : {}),
        },
      );
    }
    return payload;
  }

  private async request(
    path: string,
    body: unknown,
    retryable: boolean,
    extraHeaders: Record<string, string> = {},
  ) {
    if (!this.options.token)
      throw new YandexApiError(
        "NOT_CONFIGURED",
        "YANDEX_DIRECT_TOKEN or YANDEX_OAUTH_TOKEN is not configured",
      );
    const serialized = stringifyDirectJson(body);
    if (this.active >= (this.options.maxConcurrency ?? 2)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    const finish = telemetry.begin();
    try {
      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
        try {
          const host = this.options.sandbox
            ? "api-sandbox.direct.yandex.com"
            : "api.direct.yandex.com";
          const response = await (this.options.fetch ?? globalThis.fetch)(
            `https://${host}/json/${path}`,
            {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: {
                Authorization: `Bearer ${this.options.token}`,
                "Content-Type": "application/json; charset=utf-8",
                "Accept-Language": "ru",
                ...(this.options.clientLogin ? { "Client-Login": this.options.clientLogin } : {}),
                ...extraHeaders,
              },
              body: serialized,
            },
          );
          const requestId = response.headers.get("RequestId");
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          if (reader) {
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > (this.options.maxResponseBytes ?? 10_000_000)) {
                  await reader.cancel();
                  throw new YandexApiError(
                    "YANDEX_API",
                    "Direct response exceeds size limit; narrow the selection or date range",
                  );
                }
                chunks.push(chunk.value);
              }
            } finally {
              reader.releaseLock();
            }
          }
          const text = Buffer.concat(chunks).toString("utf8");
          if (!response.ok) {
            const retryAfter = Number(response.headers.get("Retry-After"));
            if (
              retryable &&
              attempt < this.options.maxRetries &&
              (response.status === 429 || response.status >= 500) &&
              retryAfter <= 30
            ) {
              clearTimeout(timer);
              telemetry.retry();
              await new Promise((resolve) =>
                setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** attempt),
              );
              continue;
            }
            telemetry.failure(response.status);
            this.readPayload(text, response.status, requestId);
          }
          telemetry.success(response.status);
          const retryIn = Number(response.headers.get("retryIn") ?? 5);
          return {
            text,
            status: response.status,
            requestId,
            units: response.headers.get("Units"),
            retryIn: Number.isFinite(retryIn) && retryIn >= 0 ? retryIn : 5,
          };
        } catch (error) {
          if (error instanceof YandexApiError) throw error;
          if (controller.signal.aborted)
            throw new YandexApiError("TIMEOUT", "Direct API request timed out");
          // Writes are never retried, including ambiguous network failures.
          if (retryable && attempt < this.options.maxRetries) {
            clearTimeout(timer);
            telemetry.retry();
            await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
            continue;
          }
          throw new YandexApiError("NETWORK", "Could not reach Direct API");
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      finish();
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

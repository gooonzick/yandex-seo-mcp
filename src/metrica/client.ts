import type { QueryValue } from "../shared/http-client.js";
import { YandexHttpClient } from "../shared/http-client.js";

export interface MetricaClientOptions {
  token?: string;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency?: number;
  cacheTtlMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class MetricaClient {
  private readonly http: YandexHttpClient;

  public constructor(options: MetricaClientOptions) {
    this.http = new YandexHttpClient({
      baseUrl: "https://api-metrika.yandex.net/",
      ...options,
    });
  }

  public listCounters(query: Record<string, QueryValue>): Promise<unknown> {
    return this.http.request("management/v1/counters", { query });
  }

  public getCounter(counterId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}`);
  }

  public listGoals(counterId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/goals`);
  }

  public getReport(query: Record<string, QueryValue>): Promise<unknown> {
    return this.http.request("stat/v1/data", { query });
  }

  public getTimeseries(query: Record<string, QueryValue>): Promise<unknown> {
    return this.http.request("stat/v1/data/bytime", { query });
  }

  public getComparison(query: Record<string, QueryValue>): Promise<unknown> {
    return this.http.request("stat/v1/data/comparison", { query });
  }

  public evaluateLogRequest(
    counterId: number,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/logrequests/evaluate`, { query });
  }

  public createLogRequest(counterId: number, query: Record<string, QueryValue>): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/logrequests`, {
      method: "POST",
      query,
      retryable: false,
    });
  }

  public getLogRequest(counterId: number, requestId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/logrequest/${requestId}`);
  }

  public downloadLogPart(
    counterId: number,
    requestId: number,
    partNumber: number,
  ): Promise<string> {
    return this.http.request(
      `management/v1/counter/${counterId}/logrequest/${requestId}/part/${partNumber}/download`,
      { responseType: "text" },
    );
  }

  public cleanLogRequest(counterId: number, requestId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/logrequest/${requestId}/clean`, {
      method: "POST",
      retryable: false,
    });
  }
}

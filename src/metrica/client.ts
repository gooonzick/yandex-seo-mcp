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

  public createCounter(counter: unknown): Promise<unknown> {
    return this.http.request("management/v1/counters", {
      method: "POST",
      body: { counter },
      retryable: false,
    });
  }

  public updateCounter(counterId: number, counter: unknown): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}`, {
      method: "PUT",
      body: { counter },
      retryable: false,
    });
  }

  public deleteCounter(counterId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}`, {
      method: "DELETE",
      retryable: false,
    });
  }

  public listGoals(counterId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/goals`);
  }

  public getGoal(counterId: number, goalId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/goal/${goalId}`);
  }

  public listGrants(counterId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/grants`);
  }

  public getGrant(counterId: number, userLogin: string): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/grant`, {
      query: { user_login: userLogin },
    });
  }

  public createGrant(counterId: number, grant: unknown): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/grants`, {
      method: "POST",
      body: { grant },
      retryable: false,
    });
  }

  public updateGrant(counterId: number, userLogin: string, grant: unknown): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/grant`, {
      method: "PUT",
      query: { user_login: userLogin },
      body: { grant },
      retryable: false,
    });
  }

  public deleteGrant(counterId: number, userLogin: string): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/grant`, {
      method: "DELETE",
      query: { user_login: userLogin },
      retryable: false,
    });
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

  public listLogRequests(counterId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/logrequests`);
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

  public cancelLogRequest(counterId: number, requestId: number): Promise<unknown> {
    return this.http.request(`management/v1/counter/${counterId}/logrequest/${requestId}/cancel`, {
      method: "POST",
      retryable: false,
    });
  }
}

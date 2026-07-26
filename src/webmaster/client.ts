import type { QueryValue } from "../shared/http-client.js";
import { YandexHttpClient } from "../shared/http-client.js";

export interface WebmasterClientOptions {
  token?: string;
  timeoutMs: number;
  maxRetries: number;
  maxConcurrency?: number;
  cacheTtlMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface UserResponse {
  user_id?: number;
  userId?: number;
  [key: string]: unknown;
}

export class WebmasterClient {
  private readonly http: YandexHttpClient;
  private userIdPromise?: Promise<number>;

  public constructor(options: WebmasterClientOptions) {
    this.http = new YandexHttpClient({
      baseUrl: "https://api.webmaster.yandex.net/v4/",
      ...options,
    });
  }

  public getUser(): Promise<UserResponse> {
    return this.http.request<UserResponse>("user");
  }

  public async getUserId(): Promise<number> {
    this.userIdPromise ??= this.getUser().then((response) => {
      const value = response.user_id ?? response.userId;
      if (typeof value !== "number") {
        throw new Error("Yandex Webmaster user response has no user_id");
      }
      return value;
    });
    return this.userIdPromise;
  }

  private async hostPath(hostId?: string): Promise<string> {
    const userId = await this.getUserId();
    const base = `user/${userId}/hosts`;
    return hostId ? `${base}/${encodeURIComponent(hostId)}` : base;
  }

  public async listHosts(): Promise<unknown> {
    return this.http.request(await this.hostPath());
  }

  public async getHost(hostId: string): Promise<unknown> {
    return this.http.request(await this.hostPath(hostId));
  }

  public async getSummary(hostId: string): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/summary`);
  }

  public async getIndexingStats(
    hostId: string,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/indexing/history`, {
      query,
    });
  }

  public async getSearchQueries(
    hostId: string,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/search-queries/popular`, { query });
  }

  public async getQueryAnalytics(hostId: string, body: unknown): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/query-analytics/list`, {
      method: "POST",
      body,
      retryable: true,
    });
  }

  public async getQueryHistory(
    hostId: string,
    queryId: string | undefined,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    const suffix = queryId
      ? `search-queries/${encodeURIComponent(queryId)}/history`
      : "search-queries/all/history";
    return this.http.request(`${await this.hostPath(hostId)}/${suffix}`, { query });
  }

  public async getDiagnostics(hostId: string): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/diagnostics`);
  }

  public async listSitemaps(hostId: string, query: Record<string, QueryValue>): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/sitemaps`, {
      query,
    });
  }

  public async getSitemap(hostId: string, sitemapId: string): Promise<unknown> {
    return this.http.request(
      `${await this.hostPath(hostId)}/sitemaps/${encodeURIComponent(sitemapId)}`,
    );
  }

  public async listUserSitemaps(
    hostId: string,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/user-added-sitemaps`, { query });
  }

  public async getIndexingSamples(
    hostId: string,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/indexing/samples`, {
      query,
    });
  }

  public async getSearchPagesHistory(
    hostId: string,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/search-urls/in-search/history`, {
      query,
    });
  }

  public async getSearchEventsHistory(
    hostId: string,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/search-urls/events/history`, {
      query,
    });
  }

  public async getRecrawlQuota(hostId: string): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/recrawl/quota`);
  }

  public async listRecrawlTasks(
    hostId: string,
    query: Record<string, QueryValue>,
  ): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/recrawl/queue`, {
      query,
    });
  }

  public async getRecrawlTask(hostId: string, taskId: string): Promise<unknown> {
    return this.http.request(
      `${await this.hostPath(hostId)}/recrawl/queue/${encodeURIComponent(taskId)}`,
    );
  }

  public async requestRecrawl(hostId: string, url: string): Promise<unknown> {
    return this.http.request(`${await this.hostPath(hostId)}/recrawl/queue`, {
      method: "POST",
      body: { url },
      retryable: false,
    });
  }
}

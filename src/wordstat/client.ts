import type { AppConfig } from "../config.js";
import { YandexApiError } from "../shared/errors.js";
import { YandexHttpClient, type HttpClientOptions } from "../shared/http-client.js";

export class WordstatClient {
  private readonly http: YandexHttpClient;
  private readonly folderId: string | undefined;

  public constructor(
    options: Omit<HttpClientOptions, "baseUrl" | "token" | "authScheme">,
    credentials: AppConfig["wordstat"],
  ) {
    this.folderId = credentials?.folderId;
    this.http = new YandexHttpClient({
      ...options,
      baseUrl: "https://searchapi.api.cloud.yandex.net/v2/wordstat/",
      authScheme: "Api-Key",
      ...(credentials ? { token: credentials.apiKey } : {}),
    });
  }

  public request(
    method: "dynamics" | "topRequests" | "getRegionsTree",
    parameters: Record<string, unknown>,
  ) {
    if (!this.folderId) {
      throw new YandexApiError(
        "NOT_CONFIGURED",
        "Wordstat requires YANDEX_WORDSTAT_API_KEY and YANDEX_WORDSTAT_FOLDER_ID for the server operator.",
      );
    }
    return this.http.request(method, {
      method: "POST",
      body: { ...parameters, folderId: this.folderId },
      retryable: true,
    });
  }
}

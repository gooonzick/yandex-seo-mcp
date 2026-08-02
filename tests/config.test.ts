import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses the common token as a fallback", () => {
    const config = loadConfig({ YANDEX_OAUTH_TOKEN: "common-token" });

    expect(config.metricaToken).toBe("common-token");
    expect(config.webmasterToken).toBe("common-token");
    expect(config.httpTimeoutMs).toBe(30_000);
    expect(config.transport).toBe("stdio");
    expect(config.httpMaxConcurrency).toBe(8);
    expect(config.httpCacheTtlMs).toBe(30_000);
    expect(config.monitorRetentionDays).toBe(90);
    expect(config.crawlerMaxPages).toBe(200);
    expect(config.crawlerMaxDepth).toBe(5);
    expect(config.queryClusterThreshold).toBe(0.42);
    expect(config.queryMaxQueries).toBe(500);
  });

  it("prefers service-specific tokens and parses limits", () => {
    const config = loadConfig({
      YANDEX_OAUTH_TOKEN: "common",
      YANDEX_METRICA_TOKEN: "metrica",
      YANDEX_WEBMASTER_TOKEN: "webmaster",
      YANDEX_HTTP_TIMEOUT_MS: "5000",
      YANDEX_HTTP_MAX_RETRIES: "1",
      YANDEX_MAX_RESULT_ROWS: "25",
      YANDEX_MAX_RESULT_BYTES: "2048",
    });

    expect(config).toMatchObject({
      metricaToken: "metrica",
      webmasterToken: "webmaster",
      httpTimeoutMs: 5000,
      httpMaxRetries: 1,
      maxResultRows: 25,
      maxResultBytes: 2048,
      transport: "stdio",
    });
  });

  it("parses scheduled monitoring and OAuth deployment settings", () => {
    const config = loadConfig({
      MONITOR_TARGETS_JSON: '[{"name":"prod","hostId":"https:example.com:443","counterId":123}]',
      MONITOR_INTERVAL_MS: "60000",
      YANDEX_OAUTH_CLIENT_ID: "client",
      YANDEX_OAUTH_REDIRECT_URI: "https://mcp.example.com/oauth/callback",
      YANDEX_OAUTH_STORAGE_KEY: "a-secure-key-with-at-least-32-characters",
    });

    expect(config.monitorTargets).toEqual([
      { name: "prod", hostId: "https:example.com:443", counterId: 123 },
    ]);
    expect(config.monitorIntervalMs).toBe(60_000);
    expect(config.oauthClientId).toBe("client");
  });
});

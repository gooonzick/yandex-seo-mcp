import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses the common token as a fallback", () => {
    const config = loadConfig({ YANDEX_OAUTH_TOKEN: "common-token" });

    expect(config.metricaToken).toBe("common-token");
    expect(config.webmasterToken).toBe("common-token");
    expect(config.enableWriteTools).toBe(false);
    expect(config.httpTimeoutMs).toBe(30_000);
    expect(config.transport).toBe("stdio");
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
      ENABLE_WRITE_TOOLS: "true",
    });

    expect(config).toMatchObject({
      metricaToken: "metrica",
      webmasterToken: "webmaster",
      httpTimeoutMs: 5000,
      httpMaxRetries: 1,
      maxResultRows: 25,
      maxResultBytes: 2048,
      enableWriteTools: true,
      transport: "stdio",
    });
  });
});

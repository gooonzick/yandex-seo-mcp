import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MetricaClient } from "../src/metrica/client.js";
import { WebmasterClient } from "../src/webmaster/client.js";

const config = loadConfig();
const runLive = process.env.RUN_LIVE_TESTS === "true";

describe.skipIf(!runLive)("live Yandex API smoke tests", () => {
  it.skipIf(!config.metricaToken)("can list Metrica counters", async () => {
    const client = new MetricaClient({
      token: config.metricaToken,
      timeoutMs: config.httpTimeoutMs,
      maxRetries: config.httpMaxRetries,
    });

    const response = await client.listCounters({ offset: 1, per_page: 1 });
    expect(response).toBeTruthy();
  });

  it.skipIf(!config.webmasterToken)("can get the Webmaster user", async () => {
    const client = new WebmasterClient({
      token: config.webmasterToken,
      timeoutMs: config.httpTimeoutMs,
      maxRetries: config.httpMaxRetries,
    });

    const response = await client.getUser();
    expect(response.user_id ?? response.userId).toBeTypeOf("number");
  });
});

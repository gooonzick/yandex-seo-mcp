import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { startHttpTransport } from "../src/transports/http.js";

const baseConfig: AppConfig = {
  httpTimeoutMs: 1000,
  httpMaxRetries: 0,
  maxResultRows: 100,
  maxResultBytes: 100_000,
  transport: "http",
  httpHost: "127.0.0.1",
  httpPort: 0,
};

describe("HTTP transport", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("serves a local health endpoint", async () => {
    const yandexServer = createServer({ config: baseConfig });
    const httpServer = await startHttpTransport(yandexServer, baseConfig);
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        }),
      () => yandexServer.server.close(),
    );
    const address = httpServer.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      transport: "streamable-http",
    });
  });

  it("requires a bearer token for a non-loopback bind", async () => {
    const insecure = { ...baseConfig, httpHost: "0.0.0.0" };
    const yandexServer = createServer({ config: insecure });
    cleanups.push(() => yandexServer.server.close());

    await expect(startHttpTransport(yandexServer, insecure)).rejects.toThrow(
      "MCP_HTTP_BEARER_TOKEN or Yandex OAuth PKCE is required",
    );
  });
});

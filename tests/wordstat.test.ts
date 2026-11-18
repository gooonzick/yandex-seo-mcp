import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { createOAuthProfileConfig } from "../src/transports/http.js";
import fixture from "./fixtures/wordstat.json";

const env = {
  YANDEX_WORDSTAT_API_KEY: "test-key",
  YANDEX_WORDSTAT_FOLDER_ID: "test-folder",
  YANDEX_HTTP_MAX_RETRIES: "0",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function connect(response: unknown, config = loadConfig(env), status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response, { status }));
  const { server } = createServer({ config, fetch });
  const client = new Client({ name: "wordstat-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  cleanups.push(
    () => client.close(),
    () => server.close(),
  );
  return { client, fetch };
}

describe("Wordstat MCP tools", () => {
  it("sends a Cloud API key and returns matching and associated queries without losing count precision", async () => {
    const { client, fetch } = await connect(fixture.topRequests);
    const args = {
      phrase: "велосипед",
      regions: ["213"],
      devices: ["DEVICE_PHONE"],
      numPhrases: 20,
    };
    const result = await client.callTool({ name: "wordstat_expand_queries", arguments: args });
    expect(result.structuredContent).toMatchObject(fixture.topRequests);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Api-Key test-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      ...args,
      numPhrases: "20",
      folderId: "test-folder",
    });
  });

  it("converts calendar dates to UTC and rejects incomplete periods before sending a request", async () => {
    const { client, fetch } = await connect(fixture.dynamics);
    const args = {
      phrase: "велосипед",
      period: "PERIOD_MONTHLY",
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    };
    const call = (toDate: string) =>
      client.callTool({ name: "wordstat_get_demand", arguments: { ...args, toDate } });
    expect((await call("2026-09-29")).isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect((await call(args.toDate)).structuredContent).toMatchObject(fixture.dynamics);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://searchapi.api.cloud.yandex.net/v2/wordstat/dynamics");
    expect(JSON.parse(String(init?.body))).toEqual({
      ...args,
      fromDate: "2026-09-01T00:00:00Z",
      toDate: "2026-09-30T00:00:00Z",
      folderId: "test-folder",
    });
  });

  it("keeps operator credentials isolated from OAuth profiles and requires both Cloud settings", async () => {
    expect(createOAuthProfileConfig(loadConfig(env), "user-token").wordstat).toBeUndefined();
    const { client, fetch } = await connect(
      {},
      loadConfig({ YANDEX_OAUTH_TOKEN: "user-token", YANDEX_WORDSTAT_FOLDER_ID: "folder" }),
    );
    const result = await client.callTool({
      name: "wordstat_expand_queries",
      arguments: { phrase: "велосипед" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the Wordstat connection with the region tree and reports permission failures", async () => {
    const { client, fetch } = await connect({ message: "Permission denied" }, loadConfig(env), 403);
    const result = await client.callTool({ name: "yandex_connection_check", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      wordstat: { configured: true, ok: false, error: { code: "PERMISSION" } },
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://searchapi.api.cloud.yandex.net/v2/wordstat/getRegionsTree",
    );
  });
});

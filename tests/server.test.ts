import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const config: AppConfig = {
  metricaToken: "metrica-token",
  webmasterToken: "webmaster-token",
  httpTimeoutMs: 1000,
  httpMaxRetries: 0,
  maxResultRows: 100,
  maxResultBytes: 100_000,
  enableWriteTools: false,
  transport: "stdio",
  httpHost: "127.0.0.1",
  httpPort: 3000,
};

describe("Yandex SEO MCP server", () => {
  let client: Client;
  let server: ReturnType<typeof createServer>["server"];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/v4/user")) {
        return new Response(JSON.stringify({ user_id: 42 }), { status: 200 });
      }
      if (url.pathname.endsWith("/v4/user/42/hosts")) {
        return new Response(
          JSON.stringify({
            hosts: [
              {
                host_id: "https:example.com:443",
                ascii_host_url: "https://example.com",
                verified: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/query-analytics/list")) {
        return new Response(
          JSON.stringify({
            count: 2,
            text_indicator_to_statistics: [
              {
                text_indicator: { type: "QUERY", value: "seo audit" },
                popular_complementary_indicator: {
                  type: "URL",
                  value: "https://example.com/audit",
                },
                statistics: [
                  { date: "2026-07-20", field: "IMPRESSIONS", value: 1000 },
                  { date: "2026-07-20", field: "CLICKS", value: 20 },
                  { date: "2026-07-20", field: "CTR", value: 2 },
                  { date: "2026-07-20", field: "POSITION", value: 8 },
                  { date: "2026-07-20", field: "DEMAND", value: 1500 },
                ],
              },
              {
                text_indicator: { type: "QUERY", value: "example brand" },
                popular_complementary_indicator: {
                  type: "URL",
                  value: "https://example.com",
                },
                statistics: [
                  { date: "2026-07-20", field: "IMPRESSIONS", value: 500 },
                  { date: "2026-07-20", field: "CLICKS", value: 250 },
                  { date: "2026-07-20", field: "POSITION", value: 1 },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/stat/v1/data")) {
        const date1 = url.searchParams.get("date1");
        const dimensions = url.searchParams.get("dimensions");
        if (dimensions === "ym:s:startURL") {
          const data =
            date1 === "2026-06-01"
              ? [
                  {
                    dimensions: [{ name: "https://example.com/declining" }],
                    metrics: [100, 80, 5],
                  },
                  {
                    dimensions: [{ name: "https://example.com/lost" }],
                    metrics: [40, 30, 3],
                  },
                ]
              : [
                  {
                    dimensions: [{ name: "https://example.com/declining" }],
                    metrics: [50, 42, 4],
                  },
                ];
          return new Response(JSON.stringify({ data, total_rows: data.length, sampled: false }), {
            status: 200,
          });
        }
        if (dimensions === "ym:s:lastSignSearchPhrase,ym:s:startURL") {
          return new Response(
            JSON.stringify({
              data: [
                {
                  dimensions: [{ name: "seo audit" }, { name: "https://example.com/audit" }],
                  metrics: [25, 20, 10, 60, 4],
                },
              ],
              total_rows: 1,
              sampled: false,
            }),
            { status: 200 },
          );
        }
        const metrics = date1 === "2026-06-01" ? [100] : date1 === "2026-07-01" ? [125] : [10];
        return new Response(
          JSON.stringify({
            data: [{ dimensions: [], metrics }],
            total_rows: 1,
            sampled: false,
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/management/v1/counters")) {
        return new Response(JSON.stringify({ rows: 0, counters: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ message: "not mocked" }), {
        status: 404,
      });
    });

    const created = createServer({
      config,
      fetch: fetchMock as unknown as typeof fetch,
    });
    server = created.server;
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  it("lists namespaced tools and hides write tools by default", async () => {
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);

    expect(names).toContain("yandex_capabilities");
    expect(names).toContain("metrica_get_report");
    expect(names).toContain("webmaster_list_hosts");
    expect(names).toContain("webmaster_get_query_analytics");
    expect(names).toContain("seo_find_growth_opportunities");
    expect(names).toContain("seo_compare_periods");
    expect(names).toContain("metrica_get_landing_pages");
    expect(names).toContain("metrica_get_search_phrases");
    expect(names).toContain("seo_detect_content_decay");
    expect(names).not.toContain("metrica_logs_clean");
    expect(names).not.toContain("webmaster_request_recrawl");
  });

  it("returns capabilities without making HTTP requests", async () => {
    const response = await client.callTool({
      name: "yandex_capabilities",
      arguments: {},
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      services: {
        metrica: { configured: true },
        webmaster: { configured: true },
      },
      writeToolsEnabled: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls a Metrica report with normalized query arguments", async () => {
    const response = await client.callTool({
      name: "metrica_get_report",
      arguments: {
        counterId: 123,
        date1: "2026-07-01",
        date2: "2026-07-20",
        metrics: ["ym:s:visits"],
      },
    });

    expect(response.isError).not.toBe(true);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(requestedUrl.searchParams.get("ids")).toBe("123");
    expect(requestedUrl.searchParams.get("metrics")).toBe("ym:s:visits");
    expect(requestedUrl.searchParams.get("offset")).toBe("1");
  });

  it("resolves the Webmaster user before listing hosts", async () => {
    const response = await client.callTool({
      name: "webmaster_list_hosts",
      arguments: {},
    });

    expect(response.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/v4/user/42/hosts");
  });

  it("sends a normalized Webmaster query analytics body", async () => {
    const response = await client.callTool({
      name: "webmaster_get_query_analytics",
      arguments: {
        hostId: "https:example.com:443",
        limit: 25,
        textIndicator: "URL",
        textFilters: [
          {
            textIndicator: "URL",
            operation: "TEXT_CONTAINS",
            value: "/catalog/",
          },
        ],
        sortByDate: {
          date: "2026-07-20",
          statisticField: "IMPRESSIONS",
          direction: "DESC",
        },
      },
    });

    expect(response.isError).not.toBe(true);
    const queryCall = fetchMock.mock.calls.find(([request]) =>
      String(request).endsWith("/query-analytics/list"),
    );
    expect(queryCall).toBeDefined();
    expect(queryCall?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(queryCall?.[1]?.body))).toMatchObject({
      limit: 25,
      text_indicator: "URL",
      filters: {
        text_filters: [{ operation: "TEXT_CONTAINS", value: "/catalog/" }],
      },
      sort_by_date: {
        date: "2026-07-20",
        statistic_field: "IMPRESSIONS",
        by: "DESC",
      },
    });
  });

  it("finds low-CTR and striking-distance SEO opportunities", async () => {
    const response = await client.callTool({
      name: "seo_find_growth_opportunities",
      arguments: {
        hostId: "https:example.com:443",
        date: "2026-07-20",
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      analyzedCount: 2,
      opportunityCount: 1,
      opportunities: [
        {
          query: "seo audit",
          url: "https://example.com/audit",
          ctr: 2,
          position: 8,
          estimatedAdditionalClicksAtTargetCtr: 30,
          opportunityTypes: ["LOW_CTR", "STRIKING_DISTANCE"],
        },
      ],
    });
  });

  it("compares Metrica periods with absolute and percentage deltas", async () => {
    const response = await client.callTool({
      name: "seo_compare_periods",
      arguments: {
        counterId: 123,
        previousDate1: "2026-06-01",
        previousDate2: "2026-06-30",
        currentDate1: "2026-07-01",
        currentDate2: "2026-07-31",
        metrics: ["ym:s:visits"],
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      comparison: [
        {
          metric: "ym:s:visits",
          previous: 100,
          current: 125,
          absoluteDelta: 25,
          percentDelta: 25,
        },
      ],
    });
  });

  it("uses safe organic presets for landing pages and search phrases", async () => {
    const landingResponse = await client.callTool({
      name: "metrica_get_landing_pages",
      arguments: {
        counterId: 123,
        date1: "2026-07-01",
        date2: "2026-07-31",
        goalId: 456,
      },
    });
    const phrasesResponse = await client.callTool({
      name: "metrica_get_search_phrases",
      arguments: {
        counterId: 123,
        date1: "2026-07-01",
        date2: "2026-07-31",
      },
    });

    expect(landingResponse.isError).not.toBe(true);
    expect(phrasesResponse.isError).not.toBe(true);
    const reportUrls = fetchMock.mock.calls
      .map(([request]) => new URL(String(request)))
      .filter((url) => url.pathname.endsWith("/stat/v1/data"));
    expect(reportUrls[0]?.searchParams.get("dimensions")).toBe("ym:s:startURL");
    expect(reportUrls[0]?.searchParams.get("metrics")).toContain("ym:s:goal456conversionRate");
    expect(reportUrls[0]?.searchParams.get("filters")).toBe(
      "ym:s:lastSignTrafficSource=='organic'",
    );
    expect(reportUrls[1]?.searchParams.get("dimensions")).toBe(
      "ym:s:lastSignSearchPhrase,ym:s:startURL",
    );
    expect(reportUrls[1]?.searchParams.get("metrics")).toContain("ym:s:anyGoalConversionRate");
  });

  it("detects organic landing pages with material traffic decay", async () => {
    const response = await client.callTool({
      name: "seo_detect_content_decay",
      arguments: {
        counterId: 123,
        previousDate1: "2026-06-01",
        previousDate2: "2026-06-30",
        currentDate1: "2026-07-01",
        currentDate2: "2026-07-31",
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      analyzedCount: 2,
      decayCount: 2,
      sampled: false,
      pages: [
        {
          url: "https://example.com/declining",
          previousVisits: 100,
          currentVisits: 50,
          lostVisits: 50,
          dropPercent: 50,
          severity: "HIGH",
        },
        {
          url: "https://example.com/lost",
          currentObserved: false,
          previousVisits: 40,
          currentVisits: 0,
          dropPercent: 100,
          severity: "SEVERE",
        },
      ],
    });
  });

  it("returns an MCP validation error for invalid arguments", async () => {
    const response = await client.callTool({
      name: "metrica_get_counter",
      arguments: { counterId: -1 },
    });

    expect(response.isError).toBe(true);
  });
});

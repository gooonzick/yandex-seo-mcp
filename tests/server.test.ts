import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  transport: "stdio",
  httpHost: "127.0.0.1",
  httpPort: 3000,
};

describe("Yandex SEO MCP server", () => {
  let client: Client;
  let server: ReturnType<typeof createServer>["server"];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
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
        const body = JSON.parse(String(init?.body)) as { limit?: number };
        if (body.limit === 499) {
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
                    { date: "2026-07-20", field: "IMPRESSIONS", value: 100 },
                    { date: "2026-07-20", field: "CLICKS", value: 10 },
                    { date: "2026-07-20", field: "POSITION", value: 7 },
                  ],
                },
                {
                  text_indicator: { type: "QUERY", value: "seo audit" },
                  popular_complementary_indicator: {
                    type: "URL",
                    value: "https://example.com/seo",
                  },
                  statistics: [
                    { date: "2026-07-20", field: "IMPRESSIONS", value: 50 },
                    { date: "2026-07-20", field: "CLICKS", value: 3 },
                    { date: "2026-07-20", field: "POSITION", value: 12 },
                  ],
                },
              ],
            }),
            { status: 200 },
          );
        }
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
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nSitemap: https://example.com/sitemap.xml", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url.pathname === "/sitemap.xml") {
        return new Response(
          `<?xml version="1.0"?><urlset>
            <url><loc>https://example.com/</loc></url>
            <url><loc>https://example.com/audit</loc></url>
          </urlset>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      if (url.pathname === "/audit") {
        return new Response(
          `<html><head><title>Generic service page</title>
          <meta name="description" content="A generic service description without the target cluster terminology.">
          <link rel="canonical" href="/audit"></head><body><h1>Services</h1></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.pathname === "/") {
        return new Response(
          `<html><head><title>Example brand official site</title>
          <meta name="description" content="The official Example brand homepage and navigation destination.">
          <link rel="canonical" href="/"></head><body><h1>Example brand</h1><a href="/audit">Services</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.pathname.endsWith("/summary")) {
        return new Response(JSON.stringify({ searchable_pages_count: 120 }), { status: 200 });
      }
      if (url.pathname.endsWith("/diagnostics")) {
        return new Response(JSON.stringify({ problems: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/sitemaps")) {
        return new Response(JSON.stringify({ sitemaps: [] }), { status: 200 });
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
              : date1 === "2026-07-15"
                ? [
                    {
                      dimensions: [{ name: "https://example.com/audit" }],
                      metrics: [30, 25, 40, 90, 3],
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

    const storageDirectory = await mkdtemp(join(tmpdir(), "yandex-seo-server-"));
    const created = createServer({
      config: { ...config, monitorStoragePath: join(storageDirectory, "snapshots.json") },
      fetch: fetchMock as unknown as typeof fetch,
      resolveHost: async () => ["93.184.216.34"],
    });
    server = created.server;
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  it("lists namespaced read and confirmed write tools", async () => {
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);

    expect(names).toContain("yandex_capabilities");
    expect(names).toContain("metrica_get_report");
    expect(names).toContain("metrica_get_goal");
    expect(names).toContain("metrica_list_grants");
    expect(names).toContain("metrica_get_grant");
    expect(names).toContain("metrica_logs_list");
    expect(names).toContain("webmaster_list_hosts");
    expect(names).toContain("webmaster_get_query_analytics");
    expect(names).toContain("webmaster_get_sitemap_recrawl_status");
    expect(names).toContain("webmaster_get_verification");
    expect(names).toContain("webmaster_get_user_sitemap");
    expect(names).toContain("seo_find_growth_opportunities");
    expect(names).toContain("seo_compare_periods");
    expect(names).toContain("metrica_get_landing_pages");
    expect(names).toContain("metrica_get_search_phrases");
    expect(names).toContain("seo_detect_content_decay");
    expect(names).toContain("seo_analyze_pages");
    expect(names).toContain("seo_detect_cannibalization");
    expect(names).toContain("seo_forecast_opportunities");
    expect(names).toContain("seo_run_site_audit");
    expect(names).toContain("metrica_get_segment_performance");
    expect(names).toContain("metrica_compare_segments");
    expect(names).toContain("monitor_capture_snapshot");
    expect(names).toContain("monitor_check_alerts");
    expect(names).toContain("crawler_audit_site");
    expect(names).toContain("crawler_save_snapshot");
    expect(names).toContain("crawler_reconcile_yandex_index");
    expect(names).toContain("crawler_analyze_internal_links");
    expect(names).toContain("query_intelligence_cluster_queries");
    expect(names).toContain("query_intelligence_map_pages");
    expect(names).toContain("query_intelligence_find_content_gaps");
    expect(names).toContain("query_intelligence_generate_content_brief");
    expect(names).toContain("metrica_logs_clean");
    expect(names).toContain("metrica_logs_cancel");
    expect(names).toContain("metrica_create_counter");
    expect(names).toContain("metrica_update_counter");
    expect(names).toContain("metrica_delete_counter");
    expect(names).toContain("metrica_create_grant");
    expect(names).toContain("metrica_update_grant");
    expect(names).toContain("metrica_delete_grant");
    expect(names).toContain("webmaster_request_recrawl");
    expect(names).toContain("webmaster_request_sitemap_recrawl");
    expect(names).toContain("webmaster_add_host");
    expect(names).toContain("webmaster_delete_host");
    expect(names).toContain("webmaster_request_verification");
    expect(names).toContain("webmaster_add_user_sitemap");
    expect(names).toContain("webmaster_delete_user_sitemap");
  });

  it("saves the latest crawl through the MCP tool idempotently", async () => {
    const audit = await client.callTool({
      name: "crawler_audit_site",
      arguments: { startUrl: "https://example.com/", maxPages: 10 },
    });
    const runId = (audit.structuredContent as { runId?: string } | undefined)?.runId;
    expect(audit.isError).not.toBe(true);
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);

    const saved = await client.callTool({
      name: "crawler_save_snapshot",
      arguments: { runId, dryRun: false, confirm: true },
    });
    const repeated = await client.callTool({
      name: "crawler_save_snapshot",
      arguments: { runId, dryRun: false, confirm: true },
    });

    expect(saved.isError).not.toBe(true);
    expect(saved.structuredContent).toMatchObject({ runId, created: true, dryRun: false });
    expect(repeated.structuredContent).toMatchObject({ runId, created: false, dryRun: false });
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
      writeToolsEnabled: true,
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

  it("joins Webmaster visibility with Metrica page performance", async () => {
    const response = await client.callTool({
      name: "seo_analyze_pages",
      arguments: {
        hostId: "https:example.com:443",
        counterId: 123,
        date: "2026-07-20",
        date1: "2026-07-15",
        date2: "2026-07-20",
        resultLimit: 1,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      opportunityCount: 2,
      pages: [
        {
          url: "https://example.com/audit",
          webmasterObserved: true,
          metricaObserved: true,
          search: { impressions: 1000, clicks: 20, ctr: 2 },
          engagement: { visits: 30, conversionRate: 3 },
        },
      ],
    });
  });

  it("forecasts incremental clicks from a target position", async () => {
    const response = await client.callTool({
      name: "seo_forecast_opportunities",
      arguments: {
        hostId: "https:example.com:443",
        date: "2026-07-20",
        targetPosition: 3,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      model: "POSITION_CTR_CURVE",
      forecasts: [
        {
          query: "seo audit",
          targetCtr: 10,
          estimatedAdditionalClicks: 80,
        },
      ],
    });
  });

  it("detects query cannibalization across multiple URLs", async () => {
    const response = await client.callTool({
      name: "seo_detect_cannibalization",
      arguments: {
        hostId: "https:example.com:443",
        date: "2026-07-20",
        sourceLimit: 499,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      cannibalizationCount: 1,
      issues: [
        {
          query: "seo audit",
          competingPageCount: 2,
          impressions: 150,
        },
      ],
    });
  });

  it("runs a compact cross-service site audit", async () => {
    const response = await client.callTool({
      name: "seo_run_site_audit",
      arguments: {
        hostId: "https:example.com:443",
        counterId: 123,
        date1: "2026-07-01",
        date2: "2026-07-20",
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      healthScore: 100,
      grade: "A",
      counts: { critical: 0, warnings: 0, sitemapErrors: 0 },
    });
  });

  it("clusters queries and creates a query-to-page map", async () => {
    const clusters = await client.callTool({
      name: "query_intelligence_cluster_queries",
      arguments: {
        hostId: "https:example.com:443",
        date: "2026-07-20",
      },
    });
    const pageMap = await client.callTool({
      name: "query_intelligence_map_pages",
      arguments: {
        hostId: "https:example.com:443",
        date: "2026-07-20",
      },
    });

    expect(clusters.isError).not.toBe(true);
    expect(clusters.structuredContent).toMatchObject({
      sourceCount: 2,
      clusterCount: 2,
    });
    expect(pageMap.structuredContent).toMatchObject({
      clusterCount: 2,
      mappedClusterCount: 2,
    });
  });

  it("finds weak content coverage and generates a content brief", async () => {
    const gaps = await client.callTool({
      name: "query_intelligence_find_content_gaps",
      arguments: {
        hostId: "https:example.com:443",
        date: "2026-07-20",
        startUrl: "https://example.com/",
        crawlMaxPages: 10,
      },
    });
    const brief = await client.callTool({
      name: "query_intelligence_generate_content_brief",
      arguments: {
        hostId: "https:example.com:443",
        date: "2026-07-20",
        seedQuery: "seo audit",
      },
    });

    expect(gaps.isError).not.toBe(true);
    expect(gaps.structuredContent).toMatchObject({
      gapCount: 1,
      gaps: [
        {
          primaryQuery: "seo audit",
          gapTypes: ["WEAK_PAGE_RELEVANCE"],
        },
      ],
    });
    expect(brief.structuredContent).toMatchObject({
      type: "CONTENT_BRIEF",
      matchedCluster: {
        primaryQuery: "seo audit",
      },
      targetMetrics: {
        impressions: 1000,
      },
    });
  });

  it("lists MCP resources and workflow prompts", async () => {
    const [resources, prompts] = await Promise.all([client.listResources(), client.listPrompts()]);
    expect(resources.resources.map((resource) => resource.uri)).toContain("yandex://telemetry");
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      "yandex://crawler/last-audit",
    );
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      "yandex://query-intelligence/last-analysis",
    );
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining([
        "weekly_seo_report",
        "investigate_traffic_drop",
        "prioritize_seo_backlog",
      ]),
    );
  });
});

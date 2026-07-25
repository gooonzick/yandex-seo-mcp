import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { handleTool, type ResultLimits } from "../shared/result.js";
import { WebmasterClient } from "./client.js";

const hostIdSchema = z.string().min(1).max(2_000);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const periodSchema = z.object({
  hostId: hostIdSchema,
  dateFrom: dateSchema,
  dateTo: dateSchema,
});
const deviceTypeSchema = z
  .enum(["ALL", "DESKTOP", "MOBILE_AND_TABLET", "MOBILE", "TABLET"])
  .default("ALL");
const searchLocationSchema = z
  .enum([
    "ALL_LOCATIONS",
    "ALL_LOCATIONS_ORGANIC",
    "WEB_LOCATION",
    "DYNAMIC_LOCATION_ALL",
    "DYNAMIC_LOCATION_BASIC",
    "DYNAMIC_LOCATION_ADDITIONAL",
  ])
  .default("WEB_LOCATION");
const statisticFieldSchema = z.enum(["IMPRESSIONS", "POSITION", "CLICKS", "CTR", "DEMAND"]);
const textIndicatorSchema = z.enum(["QUERY", "URL"]);
const textFilterSchema = z.object({
  textIndicator: textIndicatorSchema,
  operation: z.enum(["TEXT_CONTAINS", "TEXT_MATCH", "TEXT_DOES_NOT_CONTAIN"]),
  value: z.string().min(1).max(2_000),
});
const statisticFilterSchema = z.object({
  statisticField: statisticFieldSchema,
  operation: z.enum(["LESS_THAN", "GREATER_THAN", "LESS_EQUAL", "GREATER_EQUAL", "EQUAL"]),
  value: z.number().finite(),
  from: dateSchema,
  to: dateSchema,
});

export function registerWebmasterTools(
  server: McpServer,
  client: WebmasterClient,
  config: AppConfig,
): void {
  const limits: ResultLimits = {
    maxRows: config.maxResultRows,
    maxBytes: config.maxResultBytes,
  };

  server.registerTool(
    "webmaster_get_user",
    {
      title: "Get Yandex Webmaster API user",
      description: "Get the configured OAuth user's Webmaster identifier.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => handleTool(() => client.getUser(), limits),
  );

  server.registerTool(
    "webmaster_list_hosts",
    {
      title: "List Yandex Webmaster hosts",
      description: "List sites available to the configured OAuth user.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => handleTool(() => client.listHosts(), limits),
  );

  server.registerTool(
    "webmaster_get_host",
    {
      title: "Get Yandex Webmaster host",
      description: "Get verification and indexing metadata for a site.",
      inputSchema: z.object({ hostId: hostIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId }) => handleTool(() => client.getHost(hostId), limits),
  );

  server.registerTool(
    "webmaster_get_summary",
    {
      title: "Get Yandex Webmaster host summary",
      description: "Get a compact indexing and search summary for a site.",
      inputSchema: z.object({ hostId: hostIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId }) => handleTool(() => client.getSummary(hostId), limits),
  );

  server.registerTool(
    "webmaster_get_indexing_stats",
    {
      title: "Get Yandex Webmaster indexing history",
      description: "Get indexed and excluded page history for a period.",
      inputSchema: periodSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, dateFrom, dateTo }) =>
      handleTool(
        () =>
          client.getIndexingStats(hostId, {
            date_from: dateFrom,
            date_to: dateTo,
          }),
        limits,
      ),
  );

  server.registerTool(
    "webmaster_get_search_queries",
    {
      title: "Get popular Yandex search queries",
      description: "Get popular queries with impressions, clicks, CTR and average positions.",
      inputSchema: periodSchema.extend({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
        orderBy: z.enum(["TOTAL_SHOWS", "TOTAL_CLICKS"]).default("TOTAL_SHOWS"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, dateFrom, dateTo, offset, limit, orderBy }) =>
      handleTool(
        () =>
          client.getSearchQueries(hostId, {
            date_from: dateFrom,
            date_to: dateTo,
            offset,
            limit,
            order_by: orderBy,
            query_indicator: [
              "TOTAL_SHOWS",
              "TOTAL_CLICKS",
              "AVG_SHOW_POSITION",
              "AVG_CLICK_POSITION",
            ],
          }),
        limits,
      ),
  );

  server.registerTool(
    "webmaster_get_query_analytics",
    {
      title: "Monitor Yandex search queries and URLs",
      description:
        "Get query or URL statistics for the last two weeks with device, region, text and statistic filters.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
        deviceType: deviceTypeSchema,
        searchLocation: searchLocationSchema,
        textIndicator: textIndicatorSchema.default("QUERY"),
        regionIds: z.array(z.number().int().positive()).max(100).optional(),
        textFilters: z.array(textFilterSchema).max(20).optional(),
        statisticFilters: z.array(statisticFilterSchema).max(20).optional(),
        sortByDate: z
          .object({
            date: dateSchema,
            statisticField: statisticFieldSchema,
            direction: z.enum(["ASC", "DESC"]).default("DESC"),
          })
          .optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) => {
      const filters =
        input.textFilters?.length || input.statisticFilters?.length
          ? {
              ...(input.textFilters?.length
                ? {
                    text_filters: input.textFilters.map((filter) => ({
                      text_indicator: filter.textIndicator,
                      operation: filter.operation,
                      value: filter.value,
                    })),
                  }
                : {}),
              ...(input.statisticFilters?.length
                ? {
                    statistic_filters: input.statisticFilters.map((filter) => ({
                      statistic_field: filter.statisticField,
                      operation: filter.operation,
                      value: String(filter.value),
                      from: filter.from,
                      to: filter.to,
                    })),
                  }
                : {}),
            }
          : undefined;

      return handleTool(
        () =>
          client.getQueryAnalytics(input.hostId, {
            offset: input.offset,
            limit: input.limit,
            device_type_indicator: input.deviceType,
            search_location: input.searchLocation,
            text_indicator: input.textIndicator,
            ...(input.regionIds ? { region_ids: input.regionIds } : {}),
            ...(filters ? { filters } : {}),
            ...(input.sortByDate
              ? {
                  sort_by_date: {
                    date: input.sortByDate.date,
                    statistic_field: input.sortByDate.statisticField,
                    by: input.sortByDate.direction,
                  },
                }
              : {}),
          }),
        limits,
      );
    },
  );

  server.registerTool(
    "webmaster_list_indexing_samples",
    {
      title: "List sampled indexed URLs",
      description: "List example URLs known to Yandex with indexing status and last access date.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        offset: z.number().int().min(0).max(50_000).default(0),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, offset, limit }) =>
      handleTool(() => client.getIndexingSamples(hostId, { offset, limit }), limits),
  );

  server.registerTool(
    "webmaster_get_search_pages_history",
    {
      title: "Get pages-in-search history",
      description: "Get the number of site pages present in Yandex Search.",
      inputSchema: periodSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, dateFrom, dateTo }) =>
      handleTool(
        () =>
          client.getSearchPagesHistory(hostId, {
            date_from: dateFrom,
            date_to: dateTo,
          }),
        limits,
      ),
  );

  server.registerTool(
    "webmaster_get_search_events_history",
    {
      title: "Get search URL events history",
      description: "Get counts of URLs appearing in and disappearing from Yandex Search.",
      inputSchema: periodSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, dateFrom, dateTo }) =>
      handleTool(
        () =>
          client.getSearchEventsHistory(hostId, {
            date_from: dateFrom,
            date_to: dateTo,
          }),
        limits,
      ),
  );

  server.registerTool(
    "webmaster_get_query_history",
    {
      title: "Get Yandex search query history",
      description: "Get daily search indicators for all queries or one query ID.",
      inputSchema: periodSchema.extend({
        queryId: z.string().min(1).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, dateFrom, dateTo, queryId }) =>
      handleTool(
        () =>
          client.getQueryHistory(hostId, queryId, {
            date_from: dateFrom,
            date_to: dateTo,
            query_indicator: [
              "TOTAL_SHOWS",
              "TOTAL_CLICKS",
              "AVG_SHOW_POSITION",
              "AVG_CLICK_POSITION",
            ],
          }),
        limits,
      ),
  );

  server.registerTool(
    "webmaster_get_diagnostics",
    {
      title: "Get Yandex Webmaster diagnostics",
      description: "Get site-level diagnostic issues and their severity.",
      inputSchema: z.object({ hostId: hostIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId }) => handleTool(() => client.getDiagnostics(hostId), limits),
  );

  server.registerTool(
    "webmaster_list_sitemaps",
    {
      title: "List Yandex Webmaster sitemaps",
      description: "List known Sitemap files and their processing status.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        parentId: z.string().min(1).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(10),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, parentId, cursor, limit }) =>
      handleTool(
        () =>
          client.listSitemaps(hostId, {
            parent_id: parentId,
            from: cursor,
            limit,
          }),
        limits,
      ),
  );

  server.registerTool(
    "webmaster_get_sitemap",
    {
      title: "Get Yandex Webmaster sitemap",
      description: "Get processing details for one Sitemap.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        sitemapId: z.string().min(1).max(2_000),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, sitemapId }) => handleTool(() => client.getSitemap(hostId, sitemapId), limits),
  );

  server.registerTool(
    "webmaster_list_user_sitemaps",
    {
      title: "List user-added Sitemaps",
      description: "List Sitemaps explicitly submitted in Yandex Webmaster.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(100),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, cursor, limit }) =>
      handleTool(
        () =>
          client.listUserSitemaps(hostId, {
            offset: cursor,
            limit,
          }),
        limits,
      ),
  );

  server.registerTool(
    "webmaster_get_recrawl_quota",
    {
      title: "Get URL recrawl quota",
      description: "Get daily and remaining recrawl queue quota.",
      inputSchema: z.object({ hostId: hostIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId }) => handleTool(() => client.getRecrawlQuota(hostId), limits),
  );

  server.registerTool(
    "webmaster_list_recrawl_tasks",
    {
      title: "List URL recrawl tasks",
      description: "List URLs submitted to Yandex's recrawl queue.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(50),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, offset, limit, dateFrom, dateTo }) =>
      handleTool(
        () =>
          client.listRecrawlTasks(hostId, {
            offset,
            limit,
            date_from: dateFrom,
            date_to: dateTo,
          }),
        limits,
      ),
  );

  server.registerTool(
    "webmaster_get_recrawl_task",
    {
      title: "Get URL recrawl task",
      description: "Get the state of one URL recrawl task.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        taskId: z.string().uuid(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ hostId, taskId }) => handleTool(() => client.getRecrawlTask(hostId, taskId), limits),
  );

  if (config.enableWriteTools) {
    server.registerTool(
      "webmaster_request_recrawl",
      {
        title: "Request URL recrawl in Yandex",
        description:
          "Submit one URL to the recrawl queue. Write tools must be enabled and confirmation is required.",
        inputSchema: z.object({
          hostId: hostIdSchema,
          url: z.string().url(),
          confirm: z.literal(true),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      ({ hostId, url }) => handleTool(() => client.requestRecrawl(hostId, url), limits),
    );
  }
}

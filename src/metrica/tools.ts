import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { handleTool, type ResultLimits } from "../shared/result.js";
import { MetricaClient } from "./client.js";

const counterIdSchema = z.number().int().positive();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const csv = (values: readonly string[] | undefined): string | undefined => values?.join(",");

const reportSchema = z.object({
  counterId: counterIdSchema,
  date1: dateSchema,
  date2: dateSchema,
  metrics: z.array(z.string().min(1)).min(1).max(20),
  dimensions: z.array(z.string().min(1)).max(10).optional(),
  filters: z.string().max(10_000).optional(),
  sort: z.array(z.string().min(1)).max(20).optional(),
  limit: z.number().int().min(1).max(10_000).default(100),
  offset: z.number().int().min(1).default(1),
  accuracy: z.union([z.literal("full"), z.number().min(0).max(1)]).optional(),
});

const logsSchema = z.object({
  counterId: counterIdSchema,
  date1: dateSchema,
  date2: dateSchema,
  source: z.enum(["hits", "visits"]),
  fields: z.array(z.string().min(1)).min(1).max(100),
});
const organicPresetSchema = z.object({
  counterId: counterIdSchema,
  date1: dateSchema,
  date2: dateSchema,
  goalId: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(10_000).default(100),
  offset: z.number().int().min(1).default(1),
  accuracy: z.union([z.literal("full"), z.number().min(0).max(1)]).optional(),
});

const segmentPresetSchema = z.object({
  counterId: counterIdSchema,
  date1: dateSchema,
  date2: dateSchema,
  preset: z.enum([
    "devices",
    "regions",
    "new_vs_returning",
    "traffic_sources",
    "search_engines",
    "ecommerce",
  ]),
  attribution: z
    .enum(["LastSign", "Last", "First", "LastNonDirect", "CrossDeviceLastSign"])
    .default("LastSign"),
  goalId: z.number().int().positive().optional(),
  organicOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(1_000).default(100),
  accuracy: z.union([z.literal("full"), z.number().min(0).max(1)]).optional(),
});

const segmentPresets = {
  devices: {
    dimensions: "ym:s:deviceCategory",
    metrics: "ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:anyGoalConversionRate",
  },
  regions: {
    dimensions: "ym:s:regionArea",
    metrics: "ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:anyGoalConversionRate",
  },
  new_vs_returning: {
    dimensions: "ym:s:isNewUser",
    metrics: "ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:anyGoalConversionRate",
  },
  traffic_sources: {
    dimensions: "ym:s:lastSignTrafficSource",
    metrics: "ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:anyGoalConversionRate",
  },
  search_engines: {
    dimensions: "ym:s:lastSignSearchEngine",
    metrics: "ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:anyGoalConversionRate",
  },
  ecommerce: {
    dimensions: "ym:s:lastSignTrafficSource",
    metrics: "ym:s:visits,ym:s:ecommercePurchases,ym:s:ecommerceRevenue",
  },
} as const;

function organicMetrics(goalId: number | undefined): string {
  const conversionMetric = goalId
    ? `ym:s:goal${goalId}conversionRate`
    : "ym:s:anyGoalConversionRate";
  return [
    "ym:s:visits",
    "ym:s:users",
    "ym:s:bounceRate",
    "ym:s:avgVisitDurationSeconds",
    conversionMetric,
  ].join(",");
}

export function registerMetricaTools(
  server: McpServer,
  client: MetricaClient,
  config: AppConfig,
): void {
  const limits: ResultLimits = {
    maxRows: config.maxResultRows,
    maxBytes: config.maxResultBytes,
  };

  server.registerTool(
    "metrica_list_counters",
    {
      title: "List Yandex Metrica counters",
      description: "List counters available to the configured OAuth user.",
      inputSchema: z.object({
        offset: z.number().int().min(1).default(1),
        perPage: z.number().int().min(1).max(1000).default(100),
        search: z.string().max(255).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ offset, perPage, search }) =>
      handleTool(
        () =>
          client.listCounters({
            offset,
            per_page: perPage,
            search_string: search,
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_get_counter",
    {
      title: "Get a Yandex Metrica counter",
      description: "Get configuration and metadata for one counter.",
      inputSchema: z.object({ counterId: counterIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ counterId }) => handleTool(() => client.getCounter(counterId), limits),
  );

  server.registerTool(
    "metrica_list_goals",
    {
      title: "List Yandex Metrica goals",
      description: "List configured goals for a counter.",
      inputSchema: z.object({ counterId: counterIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ counterId }) => handleTool(() => client.listGoals(counterId), limits),
  );

  server.registerTool(
    "metrica_get_report",
    {
      title: "Query Yandex Metrica report",
      description: "Run an aggregated report with explicit metrics, dimensions and filters.",
      inputSchema: reportSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(
        () =>
          client.getReport({
            ids: input.counterId,
            date1: input.date1,
            date2: input.date2,
            metrics: csv(input.metrics),
            dimensions: csv(input.dimensions),
            filters: input.filters,
            sort: csv(input.sort),
            limit: input.limit,
            offset: input.offset,
            accuracy: input.accuracy,
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_get_timeseries",
    {
      title: "Query Yandex Metrica time series",
      description: "Return report metrics grouped into time intervals.",
      inputSchema: reportSchema.extend({
        group: z
          .enum([
            "all",
            "auto",
            "minute",
            "dekaminute",
            "hour",
            "day",
            "week",
            "month",
            "quarter",
            "year",
          ])
          .default("day"),
        topKeys: z.number().int().min(1).max(30).default(7),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(
        () =>
          client.getTimeseries({
            ids: input.counterId,
            date1: input.date1,
            date2: input.date2,
            metrics: csv(input.metrics),
            dimensions: csv(input.dimensions),
            filters: input.filters,
            sort: csv(input.sort),
            limit: input.limit,
            offset: input.offset,
            accuracy: input.accuracy,
            group: input.group,
            top_keys: input.topKeys,
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_get_traffic_summary",
    {
      title: "Get Metrica traffic summary",
      description: "Return a compact visits/users/pageviews/bounce-rate summary for a period.",
      inputSchema: z.object({
        counterId: counterIdSchema,
        date1: dateSchema,
        date2: dateSchema,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ counterId, date1, date2 }) =>
      handleTool(
        () =>
          client.getReport({
            ids: counterId,
            date1,
            date2,
            metrics:
              "ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:avgVisitDurationSeconds",
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_get_search_traffic",
    {
      title: "Get Metrica organic search traffic",
      description: "Return visits and users grouped by the last significant search engine.",
      inputSchema: z.object({
        counterId: counterIdSchema,
        date1: dateSchema,
        date2: dateSchema,
        limit: z.number().int().min(1).max(1000).default(100),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ counterId, date1, date2, limit }) =>
      handleTool(
        () =>
          client.getReport({
            ids: counterId,
            date1,
            date2,
            dimensions: "ym:s:lastSignSearchEngine",
            metrics: "ym:s:visits,ym:s:users,ym:s:anyGoalConversionRate",
            filters: "ym:s:lastSignTrafficSource=='organic'",
            limit,
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_get_landing_pages",
    {
      title: "Get organic landing pages from Metrica",
      description:
        "Return organic landing pages with visits, users, bounce rate, duration and conversion rate.",
      inputSchema: organicPresetSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(
        () =>
          client.getReport({
            ids: input.counterId,
            date1: input.date1,
            date2: input.date2,
            dimensions: "ym:s:startURL",
            metrics: organicMetrics(input.goalId),
            filters: "ym:s:lastSignTrafficSource=='organic'",
            sort: "-ym:s:visits",
            limit: input.limit,
            offset: input.offset,
            accuracy: input.accuracy,
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_get_search_phrases",
    {
      title: "Get organic search phrases from Metrica",
      description:
        "Return organic search phrases and landing pages with engagement and conversion metrics.",
      inputSchema: organicPresetSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(
        () =>
          client.getReport({
            ids: input.counterId,
            date1: input.date1,
            date2: input.date2,
            dimensions: "ym:s:lastSignSearchPhrase,ym:s:startURL",
            metrics: organicMetrics(input.goalId),
            filters: "ym:s:lastSignTrafficSource=='organic'",
            sort: "-ym:s:visits",
            limit: input.limit,
            offset: input.offset,
            accuracy: input.accuracy,
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_get_segment_performance",
    {
      title: "Get a segmented Metrica performance report",
      description:
        "Run a safe preset for devices, regions, visitor type, attribution sources, search engines or ecommerce.",
      inputSchema: segmentPresetSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(() => {
        const preset = segmentPresets[input.preset];
        const metrics = input.goalId
          ? preset.metrics.replace(
              "ym:s:anyGoalConversionRate",
              `ym:s:goal${input.goalId}conversionRate`,
            )
          : preset.metrics;
        return client.getReport({
          ids: input.counterId,
          date1: input.date1,
          date2: input.date2,
          dimensions: preset.dimensions,
          metrics,
          filters: input.organicOnly ? "ym:s:lastSignTrafficSource=='organic'" : undefined,
          attribution: input.attribution,
          sort: `-${metrics.split(",")[0]}`,
          limit: input.limit,
          accuracy: input.accuracy,
        });
      }, limits),
  );

  server.registerTool(
    "metrica_compare_segments",
    {
      title: "Compare two Metrica segments",
      description: "Compare two explicit Metrica filter expressions in one report.",
      inputSchema: z.object({
        counterId: counterIdSchema,
        date1: dateSchema,
        date2: dateSchema,
        metrics: z.array(z.string().min(1)).min(1).max(20),
        dimensions: z.array(z.string().min(1)).max(10).optional(),
        segmentA: z.string().min(1).max(10_000),
        segmentB: z.string().min(1).max(10_000),
        accuracy: z.union([z.literal("full"), z.number().min(0).max(1)]).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(
        () =>
          client.getComparison({
            ids: input.counterId,
            date1: input.date1,
            date2: input.date2,
            metrics: csv(input.metrics),
            dimensions: csv(input.dimensions),
            filters_a: input.segmentA,
            filters_b: input.segmentB,
            accuracy: input.accuracy,
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_logs_evaluate",
    {
      title: "Evaluate a Metrica Logs API request",
      description: "Estimate whether a raw logs request can be created.",
      inputSchema: logsSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(
        () =>
          client.evaluateLogRequest(input.counterId, {
            date1: input.date1,
            date2: input.date2,
            source: input.source,
            fields: csv(input.fields),
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_logs_create",
    {
      title: "Create a Metrica Logs API request",
      description:
        "Create an asynchronous raw logs export. This creates a server-side job but does not change analytics data.",
      inputSchema: logsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) =>
      handleTool(
        () =>
          client.createLogRequest(input.counterId, {
            date1: input.date1,
            date2: input.date2,
            source: input.source,
            fields: csv(input.fields),
          }),
        limits,
      ),
  );

  server.registerTool(
    "metrica_logs_status",
    {
      title: "Get Metrica Logs API request status",
      description: "Get status and available parts of a raw logs export.",
      inputSchema: z.object({
        counterId: counterIdSchema,
        requestId: z.number().int().positive(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ counterId, requestId }) =>
      handleTool(() => client.getLogRequest(counterId, requestId), limits),
  );

  server.registerTool(
    "metrica_logs_download_part",
    {
      title: "Download a bounded Metrica Logs API part",
      description: "Download one TSV export part. The MCP result byte limit is always enforced.",
      inputSchema: z.object({
        counterId: counterIdSchema,
        requestId: z.number().int().positive(),
        partNumber: z.number().int().min(0),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ counterId, requestId, partNumber }) =>
      handleTool(
        async () => ({
          format: "tsv",
          data: await client.downloadLogPart(counterId, requestId, partNumber),
        }),
        limits,
      ),
  );

  if (config.enableWriteTools) {
    server.registerTool(
      "metrica_logs_clean",
      {
        title: "Clean a Metrica Logs API request",
        description:
          "Delete a completed raw logs request from Yandex. Requires explicit confirmation.",
        inputSchema: z.object({
          counterId: counterIdSchema,
          requestId: z.number().int().positive(),
          confirm: z.literal(true),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      ({ counterId, requestId }) =>
        handleTool(() => client.cleanLogRequest(counterId, requestId), limits),
    );
  }
}

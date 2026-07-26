import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { MetricaClient } from "../metrica/client.js";
import { handleTool, type ResultLimits } from "../shared/result.js";
import type { WebmasterClient } from "../webmaster/client.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const hostIdSchema = z.string().min(1).max(2_000);
const counterIdSchema = z.number().int().positive();

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function extractMetricValues(response: unknown): number[] {
  const record = asRecord(response);
  const data = Array.isArray(record?.data) ? record.data : [];
  const first = asRecord(data[0]);
  return Array.isArray(first?.metrics)
    ? first.metrics.map((value) => finiteNumber(value) ?? 0)
    : [];
}

interface LandingPageMetrics {
  url: string;
  visits: number;
  users: number;
  conversionRate: number;
}

function extractDimensionValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  const candidate = record?.name ?? record?.id;
  return typeof candidate === "string" ? candidate : undefined;
}

function extractLandingPageMetrics(response: unknown): {
  sampled: boolean;
  rows: LandingPageMetrics[];
} {
  const record = asRecord(response);
  const data = Array.isArray(record?.data) ? record.data : [];
  const rows: LandingPageMetrics[] = [];
  for (const rawRow of data) {
    const row = asRecord(rawRow);
    const dimensions = Array.isArray(row?.dimensions) ? row.dimensions : [];
    const metrics = Array.isArray(row?.metrics) ? row.metrics : [];
    const url = extractDimensionValue(dimensions[0]);
    if (!url) continue;
    rows.push({
      url,
      visits: finiteNumber(metrics[0]) ?? 0,
      users: finiteNumber(metrics[1]) ?? 0,
      conversionRate: finiteNumber(metrics[2]) ?? 0,
    });
  }
  return { sampled: record?.sampled === true, rows };
}

interface SearchPerformanceRow {
  query?: string;
  url?: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number | null;
  demand: number;
}

function extractSearchPerformance(response: unknown): SearchPerformanceRow[] {
  const record = asRecord(response);
  const rawRows = Array.isArray(record?.text_indicator_to_statistics)
    ? record.text_indicator_to_statistics
    : [];
  const rows: SearchPerformanceRow[] = [];
  for (const rawRow of rawRows) {
    const row = asRecord(rawRow);
    const primary = asRecord(row?.text_indicator);
    const complementary = asRecord(row?.popular_complementary_indicator);
    const query =
      primary?.type === "QUERY"
        ? primary.value
        : complementary?.type === "QUERY"
          ? complementary.value
          : undefined;
    const url =
      primary?.type === "URL"
        ? primary.value
        : complementary?.type === "URL"
          ? complementary.value
          : undefined;
    const statistics = Array.isArray(row?.statistics) ? row.statistics : [];
    let impressions = 0;
    let clicks = 0;
    let demand = 0;
    const positions: number[] = [];
    const ctrs: number[] = [];
    for (const rawStatistic of statistics) {
      const statistic = asRecord(rawStatistic);
      const value = finiteNumber(statistic?.value);
      if (value === undefined) continue;
      if (statistic?.field === "IMPRESSIONS") impressions += value;
      else if (statistic?.field === "CLICKS") clicks += value;
      else if (statistic?.field === "DEMAND") demand += value;
      else if (statistic?.field === "POSITION") positions.push(value);
      else if (statistic?.field === "CTR") ctrs.push(value);
    }
    const position =
      positions.length === 0
        ? null
        : positions.reduce((sum, value) => sum + value, 0) / positions.length;
    const ctr =
      impressions > 0
        ? (clicks / impressions) * 100
        : ctrs.length > 0
          ? ctrs.reduce((sum, value) => sum + value, 0) / ctrs.length
          : 0;
    rows.push({
      ...(typeof query === "string" ? { query } : {}),
      ...(typeof url === "string" ? { url } : {}),
      impressions,
      clicks,
      ctr,
      position,
      demand,
    });
  }
  return rows;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

interface MetricaPageRow {
  url: string;
  visits: number;
  users: number;
  bounceRate: number;
  durationSeconds: number;
  conversionRate: number;
}

function extractMetricaPages(response: unknown): MetricaPageRow[] {
  const record = asRecord(response);
  const data = Array.isArray(record?.data) ? record.data : [];
  return data.flatMap((rawRow) => {
    const row = asRecord(rawRow);
    const dimensions = Array.isArray(row?.dimensions) ? row.dimensions : [];
    const metrics = Array.isArray(row?.metrics) ? row.metrics : [];
    const url = extractDimensionValue(dimensions[0]);
    if (!url) return [];
    return [
      {
        url,
        visits: finiteNumber(metrics[0]) ?? 0,
        users: finiteNumber(metrics[1]) ?? 0,
        bounceRate: finiteNumber(metrics[2]) ?? 0,
        durationSeconds: finiteNumber(metrics[3]) ?? 0,
        conversionRate: finiteNumber(metrics[4]) ?? 0,
      },
    ];
  });
}

function countMatchingKeys(value: unknown, pattern: RegExp): number {
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + countMatchingKeys(item, pattern), 0);
  const record = asRecord(value);
  if (!record) return 0;
  return Object.entries(record).reduce(
    (sum, [key, item]) =>
      sum +
      (pattern.test(key) && (item === true || finiteNumber(item)! > 0) ? 1 : 0) +
      countMatchingKeys(item, pattern),
    0,
  );
}

interface QueryOpportunity {
  query: string;
  url?: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number | null;
  demand: number;
  estimatedAdditionalClicksAtTargetCtr: number;
  opportunityTypes: string[];
  score: number;
}

function analyzeQueryAnalytics(
  response: unknown,
  thresholds: {
    minImpressions: number;
    minPosition: number;
    maxPosition: number;
    maxCtr: number;
    resultLimit: number;
  },
): {
  sourceCount: number;
  analyzedCount: number;
  opportunityCount: number;
  opportunities: QueryOpportunity[];
} {
  const record = asRecord(response);
  const rows = Array.isArray(record?.text_indicator_to_statistics)
    ? record.text_indicator_to_statistics
    : [];
  const opportunities: QueryOpportunity[] = [];

  for (const rawRow of rows) {
    const row = asRecord(rawRow);
    const primary = asRecord(row?.text_indicator);
    const complementary = asRecord(row?.popular_complementary_indicator);
    const query = primary?.type === "QUERY" ? primary.value : complementary?.value;
    const url = primary?.type === "URL" ? primary.value : complementary?.value;
    if (typeof query !== "string") continue;

    const statistics = Array.isArray(row?.statistics) ? row.statistics : [];
    const impressionsByDate = new Map<string, number>();
    let impressions = 0;
    let clicks = 0;
    let demand = 0;
    const positions: Array<{ date: string; value: number }> = [];
    const reportedCtrs: number[] = [];

    for (const rawStatistic of statistics) {
      const statistic = asRecord(rawStatistic);
      const field = statistic?.field;
      const value = finiteNumber(statistic?.value);
      const date = typeof statistic?.date === "string" ? statistic.date : "";
      if (value === undefined) continue;
      if (field === "IMPRESSIONS") {
        impressions += value;
        impressionsByDate.set(date, value);
      } else if (field === "CLICKS") {
        clicks += value;
      } else if (field === "DEMAND") {
        demand += value;
      } else if (field === "POSITION") {
        positions.push({ date, value });
      } else if (field === "CTR") {
        reportedCtrs.push(value);
      }
    }

    const positionWeight = positions.reduce(
      (total, item) => total + (impressionsByDate.get(item.date) ?? 0),
      0,
    );
    const position =
      positions.length === 0
        ? null
        : positionWeight > 0
          ? positions.reduce(
              (total, item) => total + item.value * (impressionsByDate.get(item.date) ?? 0),
              0,
            ) / positionWeight
          : positions.reduce((total, item) => total + item.value, 0) / positions.length;
    const ctr =
      impressions > 0
        ? (clicks / impressions) * 100
        : reportedCtrs.length > 0
          ? reportedCtrs.reduce((total, value) => total + value, 0) / reportedCtrs.length
          : 0;
    const opportunityTypes: string[] = [];
    if (impressions >= thresholds.minImpressions && ctr <= thresholds.maxCtr) {
      opportunityTypes.push("LOW_CTR");
    }
    if (
      impressions >= thresholds.minImpressions &&
      position !== null &&
      position >= thresholds.minPosition &&
      position <= thresholds.maxPosition
    ) {
      opportunityTypes.push("STRIKING_DISTANCE");
    }
    if (opportunityTypes.length === 0) continue;

    const estimatedAdditionalClicks = Math.max(0, impressions * ((thresholds.maxCtr - ctr) / 100));
    const positionScore =
      position !== null && opportunityTypes.includes("STRIKING_DISTANCE")
        ? impressions / Math.max(1, position)
        : 0;
    opportunities.push({
      query,
      ...(typeof url === "string" ? { url } : {}),
      impressions: round(impressions),
      clicks: round(clicks),
      ctr: round(ctr),
      position: position === null ? null : round(position),
      demand: round(demand),
      estimatedAdditionalClicksAtTargetCtr: round(estimatedAdditionalClicks),
      opportunityTypes,
      score: round(estimatedAdditionalClicks + positionScore),
    });
  }

  opportunities.sort((left, right) => right.score - left.score);
  return {
    sourceCount: finiteNumber(record?.count) ?? rows.length,
    analyzedCount: rows.length,
    opportunityCount: opportunities.length,
    opportunities: opportunities.slice(0, thresholds.resultLimit),
  };
}

export function registerSeoTools(
  server: McpServer,
  metrica: MetricaClient,
  webmaster: WebmasterClient,
  config: AppConfig,
): void {
  const limits: ResultLimits = {
    maxRows: config.maxResultRows,
    maxBytes: config.maxResultBytes,
  };

  server.registerTool(
    "seo_find_growth_opportunities",
    {
      title: "Find Yandex SEO growth opportunities",
      description:
        "Analyze recent Webmaster query analytics and rank low-CTR and striking-distance queries.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        date: dateSchema,
        deviceType: z
          .enum(["ALL", "DESKTOP", "MOBILE_AND_TABLET", "MOBILE", "TABLET"])
          .default("ALL"),
        regionIds: z.array(z.number().int().positive()).max(100).optional(),
        sourceLimit: z.number().int().min(1).max(500).default(500),
        resultLimit: z.number().int().min(1).max(100).default(25),
        minImpressions: z.number().nonnegative().default(100),
        minPosition: z.number().positive().default(4),
        maxPosition: z.number().positive().default(20),
        maxCtr: z.number().min(0).max(100).default(5),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const response = await webmaster.getQueryAnalytics(input.hostId, {
          offset: 0,
          limit: input.sourceLimit,
          device_type_indicator: input.deviceType,
          search_location: "WEB_LOCATION",
          text_indicator: "QUERY",
          ...(input.regionIds ? { region_ids: input.regionIds } : {}),
          sort_by_date: {
            date: input.date,
            statistic_field: "IMPRESSIONS",
            by: "DESC",
          },
        });
        return {
          date: input.date,
          thresholds: {
            minImpressions: input.minImpressions,
            minPosition: input.minPosition,
            maxPosition: input.maxPosition,
            maxCtr: input.maxCtr,
          },
          ...analyzeQueryAnalytics(response, input),
        };
      }, limits),
  );

  server.registerTool(
    "seo_compare_periods",
    {
      title: "Compare two Yandex Metrica periods",
      description:
        "Compare aggregate Metrica metrics between a previous and current period with absolute and percentage deltas.",
      inputSchema: z.object({
        counterId: counterIdSchema,
        previousDate1: dateSchema,
        previousDate2: dateSchema,
        currentDate1: dateSchema,
        currentDate2: dateSchema,
        metrics: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .default([
            "ym:s:visits",
            "ym:s:users",
            "ym:s:pageviews",
            "ym:s:bounceRate",
            "ym:s:anyGoalConversionRate",
          ]),
        filters: z.string().max(10_000).optional(),
        accuracy: z.union([z.literal("full"), z.number().min(0).max(1)]).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const common = {
          ids: input.counterId,
          metrics: input.metrics.join(","),
          filters: input.filters,
          accuracy: input.accuracy,
        };
        const [previousResponse, currentResponse] = await Promise.all([
          metrica.getReport({
            ...common,
            date1: input.previousDate1,
            date2: input.previousDate2,
          }),
          metrica.getReport({
            ...common,
            date1: input.currentDate1,
            date2: input.currentDate2,
          }),
        ]);
        const previous = extractMetricValues(previousResponse);
        const current = extractMetricValues(currentResponse);
        const comparison = input.metrics.map((metric, index) => {
          const previousValue = previous[index] ?? 0;
          const currentValue = current[index] ?? 0;
          const absoluteDelta = currentValue - previousValue;
          return {
            metric,
            previous: round(previousValue),
            current: round(currentValue),
            absoluteDelta: round(absoluteDelta),
            percentDelta:
              previousValue === 0 ? null : round((absoluteDelta / Math.abs(previousValue)) * 100),
          };
        });
        return {
          previousPeriod: { date1: input.previousDate1, date2: input.previousDate2 },
          currentPeriod: { date1: input.currentDate1, date2: input.currentDate2 },
          comparison,
        };
      }, limits),
  );

  server.registerTool(
    "seo_detect_content_decay",
    {
      title: "Detect organic content decay",
      description:
        "Compare organic landing-page traffic across two periods and rank pages with material visit losses.",
      inputSchema: z.object({
        counterId: counterIdSchema,
        previousDate1: dateSchema,
        previousDate2: dateSchema,
        currentDate1: dateSchema,
        currentDate2: dateSchema,
        goalId: z.number().int().positive().optional(),
        sourceLimit: z.number().int().min(1).max(10_000).default(1_000),
        resultLimit: z.number().int().min(1).max(100).default(25),
        minPreviousVisits: z.number().nonnegative().default(20),
        minDropPercent: z.number().min(0).max(100).default(20),
        accuracy: z.union([z.literal("full"), z.number().min(0).max(1)]).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const conversionMetric = input.goalId
          ? `ym:s:goal${input.goalId}conversionRate`
          : "ym:s:anyGoalConversionRate";
        const common = {
          ids: input.counterId,
          dimensions: "ym:s:startURL",
          metrics: `ym:s:visits,ym:s:users,${conversionMetric}`,
          filters: "ym:s:lastSignTrafficSource=='organic'",
          sort: "-ym:s:visits",
          limit: input.sourceLimit,
          offset: 1,
          accuracy: input.accuracy,
        };
        const [previousResponse, currentResponse] = await Promise.all([
          metrica.getReport({
            ...common,
            date1: input.previousDate1,
            date2: input.previousDate2,
          }),
          metrica.getReport({
            ...common,
            date1: input.currentDate1,
            date2: input.currentDate2,
          }),
        ]);
        const previous = extractLandingPageMetrics(previousResponse);
        const current = extractLandingPageMetrics(currentResponse);
        const currentByUrl = new Map(current.rows.map((row) => [row.url, row]));
        const decayed = previous.rows
          .filter((row) => row.visits >= input.minPreviousVisits && row.visits > 0)
          .map((previousRow) => {
            const currentRow = currentByUrl.get(previousRow.url);
            const currentVisits = currentRow?.visits ?? 0;
            const lostVisits = previousRow.visits - currentVisits;
            const dropPercent = (lostVisits / previousRow.visits) * 100;
            return {
              url: previousRow.url,
              currentObserved: Boolean(currentRow),
              previousVisits: round(previousRow.visits),
              currentVisits: round(currentVisits),
              lostVisits: round(lostVisits),
              dropPercent: round(dropPercent),
              previousUsers: round(previousRow.users),
              currentUsers: round(currentRow?.users ?? 0),
              previousConversionRate: round(previousRow.conversionRate),
              currentConversionRate: currentRow ? round(currentRow.conversionRate) : null,
              conversionRateDelta: currentRow
                ? round(currentRow.conversionRate - previousRow.conversionRate)
                : null,
              severity:
                !currentRow || dropPercent >= 75
                  ? "SEVERE"
                  : dropPercent >= 40
                    ? "HIGH"
                    : "MODERATE",
            };
          })
          .filter((row) => row.dropPercent >= input.minDropPercent)
          .sort((left, right) => right.lostVisits - left.lostVisits);

        return {
          previousPeriod: { date1: input.previousDate1, date2: input.previousDate2 },
          currentPeriod: { date1: input.currentDate1, date2: input.currentDate2 },
          thresholds: {
            minPreviousVisits: input.minPreviousVisits,
            minDropPercent: input.minDropPercent,
          },
          observation: {
            sourceLimit: input.sourceLimit,
            missingCurrentPagesTreatedAsZero: true,
            note: "A page absent from the current top-N report may still have traffic below the source limit.",
          },
          sampled: previous.sampled || current.sampled,
          analyzedCount: previous.rows.length,
          decayCount: decayed.length,
          pages: decayed.slice(0, input.resultLimit),
        };
      }, limits),
  );

  server.registerTool(
    "seo_analyze_pages",
    {
      title: "Analyze pages across Webmaster and Metrica",
      description:
        "Join Yandex search visibility and Metrica engagement/conversion data by normalized landing-page URL.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        counterId: counterIdSchema,
        date: dateSchema,
        date1: dateSchema,
        date2: dateSchema,
        goalId: z.number().int().positive().optional(),
        sourceLimit: z.number().int().min(1).max(1_000).default(500),
        resultLimit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const conversionMetric = input.goalId
          ? `ym:s:goal${input.goalId}conversionRate`
          : "ym:s:anyGoalConversionRate";
        const [webmasterResponse, metricaResponse] = await Promise.all([
          webmaster.getQueryAnalytics(input.hostId, {
            offset: 0,
            limit: input.sourceLimit,
            device_type_indicator: "ALL",
            search_location: "WEB_LOCATION",
            text_indicator: "URL",
            sort_by_date: {
              date: input.date,
              statistic_field: "IMPRESSIONS",
              by: "DESC",
            },
          }),
          metrica.getReport({
            ids: input.counterId,
            date1: input.date1,
            date2: input.date2,
            dimensions: "ym:s:startURL",
            metrics: `ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:avgVisitDurationSeconds,${conversionMetric}`,
            filters: "ym:s:lastSignTrafficSource=='organic'",
            sort: "-ym:s:visits",
            limit: input.sourceLimit,
            offset: 1,
          }),
        ]);
        const searchRows = extractSearchPerformance(webmasterResponse);
        const searchByUrl = new Map<string, SearchPerformanceRow>();
        for (const row of searchRows) {
          if (!row.url) continue;
          const key = normalizeUrl(row.url);
          const current = searchByUrl.get(key);
          if (!current) searchByUrl.set(key, { ...row });
          else {
            current.impressions += row.impressions;
            current.clicks += row.clicks;
            current.demand += row.demand;
            current.ctr =
              current.impressions > 0 ? (current.clicks / current.impressions) * 100 : 0;
            if (row.position !== null) {
              current.position =
                current.position === null ? row.position : (current.position + row.position) / 2;
            }
          }
        }
        const metricaRows = extractMetricaPages(metricaResponse);
        const metricaByUrl = new Map(metricaRows.map((row) => [normalizeUrl(row.url), row]));
        const keys = new Set([...searchByUrl.keys(), ...metricaByUrl.keys()]);
        const pages = [...keys].map((key) => {
          const search = searchByUrl.get(key);
          const analytics = metricaByUrl.get(key);
          const signals: string[] = [];
          if ((search?.impressions ?? 0) >= 100 && (search?.ctr ?? 0) < 3)
            signals.push("HIGH_VISIBILITY_LOW_CTR");
          if ((search?.clicks ?? 0) >= 10 && (analytics?.conversionRate ?? 0) === 0)
            signals.push("SEARCH_TRAFFIC_NO_CONVERSIONS");
          if ((analytics?.visits ?? 0) >= 20 && (analytics?.bounceRate ?? 0) >= 60)
            signals.push("HIGH_BOUNCE_RATE");
          if ((search?.position ?? 100) <= 10 && (analytics?.visits ?? 0) === 0)
            signals.push("VISIBLE_WITHOUT_METRICA_TRAFFIC");
          const score =
            (search?.impressions ?? 0) * Math.max(0, 0.05 - (search?.ctr ?? 0) / 100) +
            signals.length * 25;
          return {
            url: analytics?.url ?? search?.url ?? key,
            webmasterObserved: Boolean(search),
            metricaObserved: Boolean(analytics),
            search: {
              impressions: round(search?.impressions ?? 0),
              clicks: round(search?.clicks ?? 0),
              ctr: round(search?.ctr ?? 0),
              position:
                search?.position === null || search?.position === undefined
                  ? null
                  : round(search.position),
            },
            engagement: {
              visits: round(analytics?.visits ?? 0),
              users: round(analytics?.users ?? 0),
              bounceRate: round(analytics?.bounceRate ?? 0),
              durationSeconds: round(analytics?.durationSeconds ?? 0),
              conversionRate: round(analytics?.conversionRate ?? 0),
            },
            signals,
            score: round(score),
          };
        });
        pages.sort((left, right) => right.score - left.score);
        return {
          webmasterDate: input.date,
          metricaPeriod: { date1: input.date1, date2: input.date2 },
          analyzedCount: pages.length,
          opportunityCount: pages.filter((page) => page.signals.length > 0).length,
          pages: pages.slice(0, input.resultLimit),
        };
      }, limits),
  );

  server.registerTool(
    "seo_detect_cannibalization",
    {
      title: "Detect search-query cannibalization",
      description:
        "Find queries associated with multiple landing pages and rank likely internal competition.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        date: dateSchema,
        sourceLimit: z.number().int().min(1).max(500).default(500),
        resultLimit: z.number().int().min(1).max(100).default(25),
        minImpressions: z.number().nonnegative().default(20),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const response = await webmaster.getQueryAnalytics(input.hostId, {
          offset: 0,
          limit: input.sourceLimit,
          device_type_indicator: "ALL",
          search_location: "WEB_LOCATION",
          text_indicator: "QUERY",
          sort_by_date: { date: input.date, statistic_field: "IMPRESSIONS", by: "DESC" },
        });
        const grouped = new Map<string, SearchPerformanceRow[]>();
        for (const row of extractSearchPerformance(response)) {
          if (!row.query || !row.url) continue;
          const rows = grouped.get(row.query) ?? [];
          rows.push(row);
          grouped.set(row.query, rows);
        }
        const issues = [...grouped.entries()]
          .map(([query, rows]) => {
            const byUrl = new Map<string, SearchPerformanceRow>();
            for (const row of rows) byUrl.set(normalizeUrl(row.url!), row);
            const pages = [...byUrl.values()];
            const impressions = pages.reduce((sum, row) => sum + row.impressions, 0);
            return {
              query,
              impressions: round(impressions),
              competingPageCount: pages.length,
              pages: pages
                .sort((a, b) => b.impressions - a.impressions)
                .map((row) => ({
                  url: row.url,
                  impressions: round(row.impressions),
                  clicks: round(row.clicks),
                  ctr: round(row.ctr),
                  position: row.position === null ? null : round(row.position),
                })),
              score: round(impressions * Math.max(0, pages.length - 1)),
            };
          })
          .filter(
            (issue) => issue.competingPageCount > 1 && issue.impressions >= input.minImpressions,
          )
          .sort((left, right) => right.score - left.score);
        return {
          date: input.date,
          analyzedQueries: grouped.size,
          cannibalizationCount: issues.length,
          issues: issues.slice(0, input.resultLimit),
          note: "Detection is limited to URL associations returned by query-analytics for the requested result window.",
        };
      }, limits),
  );

  server.registerTool(
    "seo_forecast_opportunities",
    {
      title: "Forecast SEO click opportunities",
      description:
        "Estimate additional clicks from target CTR or target search position using an explicit CTR curve.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        date: dateSchema,
        sourceLimit: z.number().int().min(1).max(500).default(500),
        resultLimit: z.number().int().min(1).max(100).default(25),
        minImpressions: z.number().nonnegative().default(50),
        targetPosition: z.number().int().min(1).max(10).default(3),
        targetCtr: z.number().min(0).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const response = await webmaster.getQueryAnalytics(input.hostId, {
          offset: 0,
          limit: input.sourceLimit,
          device_type_indicator: "ALL",
          search_location: "WEB_LOCATION",
          text_indicator: "QUERY",
          sort_by_date: { date: input.date, statistic_field: "IMPRESSIONS", by: "DESC" },
        });
        const defaultCtrCurve = [28, 15, 10, 7, 5, 4, 3.2, 2.6, 2.2, 1.9];
        const targetCtr = input.targetCtr ?? defaultCtrCurve[input.targetPosition - 1]!;
        const forecasts = extractSearchPerformance(response)
          .filter((row) => row.query && row.impressions >= input.minImpressions)
          .map((row) => {
            const projectedClicks = row.impressions * (targetCtr / 100);
            return {
              query: row.query,
              url: row.url,
              impressions: round(row.impressions),
              currentClicks: round(row.clicks),
              currentCtr: round(row.ctr),
              currentPosition: row.position === null ? null : round(row.position),
              targetPosition: input.targetPosition,
              targetCtr,
              projectedClicks: round(projectedClicks),
              estimatedAdditionalClicks: round(Math.max(0, projectedClicks - row.clicks)),
            };
          })
          .filter((row) => row.estimatedAdditionalClicks > 0)
          .sort((left, right) => right.estimatedAdditionalClicks - left.estimatedAdditionalClicks);
        return {
          date: input.date,
          model: input.targetCtr === undefined ? "POSITION_CTR_CURVE" : "EXPLICIT_TARGET_CTR",
          assumptions: { targetPosition: input.targetPosition, targetCtr },
          forecastCount: forecasts.length,
          totalEstimatedAdditionalClicks: round(
            forecasts.reduce((sum, row) => sum + row.estimatedAdditionalClicks, 0),
          ),
          forecasts: forecasts.slice(0, input.resultLimit),
        };
      }, limits),
  );

  server.registerTool(
    "seo_run_site_audit",
    {
      title: "Run a compact Yandex SEO site audit",
      description:
        "Combine Webmaster summary, diagnostics, Sitemap state and optional Metrica traffic into a prioritized health report.",
      inputSchema: z.object({
        hostId: hostIdSchema,
        counterId: counterIdSchema.optional(),
        date1: dateSchema.optional(),
        date2: dateSchema.optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const [summary, diagnostics, sitemaps, traffic] = await Promise.all([
          webmaster.getSummary(input.hostId),
          webmaster.getDiagnostics(input.hostId),
          webmaster.listSitemaps(input.hostId, { limit: 100, offset: 0 }),
          input.counterId && input.date1 && input.date2
            ? metrica.getReport({
                ids: input.counterId,
                date1: input.date1,
                date2: input.date2,
                metrics: "ym:s:visits,ym:s:users,ym:s:anyGoalConversionRate",
                filters: "ym:s:lastSignTrafficSource=='organic'",
              })
            : Promise.resolve(undefined),
        ]);
        const criticalCount = countMatchingKeys(diagnostics, /fatal|critical/i);
        const warningCount = countMatchingKeys(diagnostics, /warning|error/i);
        const sitemapErrors = countMatchingKeys(sitemaps, /error|problem/i);
        const trafficMetrics = traffic ? extractMetricValues(traffic) : [];
        const recommendations: Array<{
          severity: "critical" | "warning" | "opportunity";
          code: string;
          message: string;
        }> = [];
        if (criticalCount > 0)
          recommendations.push({
            severity: "critical",
            code: "WEBMASTER_CRITICAL_DIAGNOSTICS",
            message: `Resolve ${criticalCount} critical Webmaster diagnostic signal(s).`,
          });
        if (warningCount > 0)
          recommendations.push({
            severity: "warning",
            code: "WEBMASTER_WARNINGS",
            message: `Review ${warningCount} Webmaster warning/error signal(s).`,
          });
        if (sitemapErrors > 0)
          recommendations.push({
            severity: "warning",
            code: "SITEMAP_PROBLEMS",
            message: `Review ${sitemapErrors} Sitemap problem signal(s).`,
          });
        if (traffic && (trafficMetrics[0] ?? 0) === 0)
          recommendations.push({
            severity: "warning",
            code: "NO_ORGANIC_VISITS",
            message: "No organic visits were observed for the selected Metrica period.",
          });
        if (recommendations.length === 0)
          recommendations.push({
            severity: "opportunity",
            code: "NO_IMMEDIATE_PROBLEMS",
            message:
              "No immediate heuristic problems detected; run page and query opportunity tools.",
          });
        const healthScore = Math.max(
          0,
          100 - criticalCount * 20 - warningCount * 5 - sitemapErrors * 5,
        );
        return {
          healthScore,
          grade: healthScore >= 90 ? "A" : healthScore >= 75 ? "B" : healthScore >= 60 ? "C" : "D",
          counts: { critical: criticalCount, warnings: warningCount, sitemapErrors },
          organicTraffic: traffic
            ? {
                visits: round(trafficMetrics[0] ?? 0),
                users: round(trafficMetrics[1] ?? 0),
                conversionRate: round(trafficMetrics[2] ?? 0),
              }
            : null,
          recommendations,
          evidence: { summary, diagnostics, sitemaps },
        };
      }, limits),
  );
}

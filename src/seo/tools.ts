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
            "ym:s:goalConversionRateAny",
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
}

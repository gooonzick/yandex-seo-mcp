import type { MetricaClient } from "../metrica/client.js";
import { normalizeCrawlUrl, type SeoChange } from "../storage/schema.js";

type UnknownRecord = Record<string, unknown>;

export interface MeasureMetricaImpactOptions {
  counterId: number;
  periodDays: number;
  minVisits: number;
  sourceLimit: number;
  resultLimit: number;
  timezone: string;
  goalId?: number | undefined;
  accuracy?: "full" | number | undefined;
}

interface LandingMetrics {
  url: string;
  visits: number;
  users: number;
  conversions: number;
  conversionRate: number;
}

interface ParsedReport {
  aggregate: Omit<LandingMetrics, "url">;
  pages: LandingMetrics[];
  sampled: boolean;
  sampleShare: number | null;
  dataLag: number | null;
  totalRows: number;
  returnedRows: number;
  truncated: boolean;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function dimensionValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return typeof record?.name === "string" ? record.name : undefined;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeReportUrl(value: string): string {
  try {
    return normalizeCrawlUrl(value);
  } catch {
    return value.trim();
  }
}

function mergePages(rows: LandingMetrics[]): LandingMetrics[] {
  const grouped = new Map<string, LandingMetrics>();
  for (const row of rows) {
    const current = grouped.get(row.url);
    if (!current) {
      grouped.set(row.url, { ...row });
      continue;
    }
    current.visits += row.visits;
    current.users += row.users;
    current.conversions += row.conversions;
    current.conversionRate =
      current.visits === 0 ? 0 : (current.conversions / current.visits) * 100;
  }
  return [...grouped.values()];
}

function parseReport(response: unknown, scope: ReadonlySet<string> | undefined): ParsedReport {
  const record = asRecord(response);
  const rawRows = Array.isArray(record?.data) ? record.data : [];
  const rows = rawRows.flatMap((rawRow): LandingMetrics[] => {
    const row = asRecord(rawRow);
    const dimensions = Array.isArray(row?.dimensions) ? row.dimensions : [];
    const metrics = Array.isArray(row?.metrics) ? row.metrics : [];
    const rawUrl = dimensionValue(dimensions[0]);
    if (!rawUrl) return [];
    const url = normalizeReportUrl(rawUrl);
    if (scope && !scope.has(url)) return [];
    const visits = finiteNumber(metrics[0]) ?? 0;
    const users = finiteNumber(metrics[1]) ?? 0;
    const conversionRate = finiteNumber(metrics[2]) ?? 0;
    return [{ url, visits, users, conversionRate, conversions: visits * conversionRate * 0.01 }];
  });
  const pages = mergePages(rows);
  const totals = Array.isArray(record?.totals) ? record.totals : [];
  const hasCompleteTotals = [totals[0], totals[1], totals[2]].every(
    (value) => finiteNumber(value) !== undefined,
  );
  const aggregate =
    scope || !hasCompleteTotals
      ? pages.reduce(
          (result, page) => ({
            visits: result.visits + page.visits,
            users: result.users + page.users,
            conversions: result.conversions + page.conversions,
            conversionRate: 0,
          }),
          { visits: 0, users: 0, conversions: 0, conversionRate: 0 },
        )
      : (() => {
          const visits = finiteNumber(totals[0]) ?? 0;
          const users = finiteNumber(totals[1]) ?? 0;
          const conversionRate = finiteNumber(totals[2]) ?? 0;
          return { visits, users, conversionRate, conversions: visits * conversionRate * 0.01 };
        })();
  aggregate.conversionRate =
    aggregate.visits === 0 ? 0 : (aggregate.conversions / aggregate.visits) * 100;
  const totalRows = finiteNumber(record?.total_rows) ?? rawRows.length;
  const sampleShare = finiteNumber(record?.sample_share) ?? null;
  return {
    aggregate,
    pages,
    sampled: record?.sampled === true || (sampleShare !== null && sampleShare < 1),
    sampleShare,
    dataLag: finiteNumber(record?.data_lag) ?? null,
    totalRows,
    returnedRows: rawRows.length,
    truncated: totalRows > rawRows.length,
  };
}

function shiftDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function offsetMinutes(value: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value)!;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export function isTimezoneOffset(value: string): boolean {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return minutes < 60 && (hours < 14 || (hours === 14 && minutes === 0));
}

function changeDate(timestamp: string, timezone: string): string {
  const shifted = Date.parse(timestamp) + offsetMinutes(timezone) * 60_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

function metricDelta(before: number, after: number) {
  const absoluteDelta = after - before;
  return {
    before: round(before),
    after: round(after),
    absoluteDelta: round(absoluteDelta),
    percentDelta: before === 0 ? null : round((absoluteDelta / Math.abs(before)) * 100),
  };
}

export async function measureMetricaImpact(
  metrica: Pick<MetricaClient, "getReport">,
  change: SeoChange,
  options: MeasureMetricaImpactOptions,
) {
  const changedOn = changeDate(change.timestamp, options.timezone);
  const periods = {
    before: {
      date1: shiftDate(changedOn, -options.periodDays),
      date2: shiftDate(changedOn, -1),
    },
    after: {
      date1: shiftDate(changedOn, 1),
      date2: shiftDate(changedOn, options.periodDays),
    },
  };
  const conversionMetric = options.goalId
    ? `ym:s:goal${options.goalId}conversionRate`
    : "ym:s:anyGoalConversionRate";
  const common = {
    ids: options.counterId,
    dimensions: "ym:s:startURL",
    metrics: `ym:s:visits,ym:s:users,${conversionMetric}`,
    filters: "ym:s:lastSignTrafficSource=='organic'",
    sort: "-ym:s:visits",
    limit: options.sourceLimit,
    offset: 1,
    timezone: options.timezone,
    accuracy: options.accuracy,
  };
  const [beforeResponse, afterResponse] = await Promise.all([
    metrica.getReport({ ...common, ...periods.before }),
    metrica.getReport({ ...common, ...periods.after }),
  ]);
  const scope = change.urlScope.length > 0 ? new Set(change.urlScope) : undefined;
  const before = parseReport(beforeResponse, scope);
  const after = parseReport(afterResponse, scope);
  const beforePages = new Map(before.pages.map((page) => [page.url, page]));
  const afterPages = new Map(after.pages.map((page) => [page.url, page]));
  const pages = [...new Set([...beforePages.keys(), ...afterPages.keys()])]
    .map((url) => {
      const previous = beforePages.get(url);
      const current = afterPages.get(url);
      return {
        url,
        visits: metricDelta(previous?.visits ?? 0, current?.visits ?? 0),
        users: metricDelta(previous?.users ?? 0, current?.users ?? 0),
        conversions: metricDelta(previous?.conversions ?? 0, current?.conversions ?? 0),
        conversionRate: metricDelta(previous?.conversionRate ?? 0, current?.conversionRate ?? 0),
      };
    })
    .sort(
      (left, right) =>
        Math.abs(right.visits.absoluteDelta) - Math.abs(left.visits.absoluteDelta) ||
        left.url.localeCompare(right.url),
    );
  const minimumObservedVisits = Math.min(before.aggregate.visits, after.aggregate.visits);
  const lowVolume = minimumObservedVisits < options.minVisits;
  const today = changeDate(new Date().toISOString(), options.timezone);
  const incompleteAfterPeriod = periods.after.date2 >= today;
  const sampled = before.sampled || after.sampled;
  const truncated = before.truncated || after.truncated;
  const dataLag = Math.max(before.dataLag ?? 0, after.dataLag ?? 0);
  const limitations = [
    "OBSERVATIONAL_ASSOCIATION_NOT_CAUSAL",
    "CONVERSIONS_DERIVED_FROM_REPORTED_CONVERSION_RATE",
    ...(lowVolume ? ["LOW_TRAFFIC_VOLUME"] : []),
    ...(incompleteAfterPeriod ? ["POST_CHANGE_PERIOD_MAY_BE_INCOMPLETE"] : []),
    ...(sampled ? ["METRICA_SAMPLING"] : []),
    ...(dataLag > 0 ? ["METRICA_DATA_LAG"] : []),
    ...(truncated ? ["LANDING_PAGE_SOURCE_LIMIT"] : []),
    ...(scope && truncated ? ["SCOPED_TOTALS_COVER_ONLY_RETURNED_LANDING_PAGES"] : []),
    ...(change.urlScope.length > 1 ? ["SCOPED_USERS_MAY_OVERLAP_ACROSS_LANDING_PAGES"] : []),
  ];
  const insufficientData = lowVolume || incompleteAfterPeriod;
  return {
    status: insufficientData ? ("insufficient_data" as const) : ("measured" as const),
    change: {
      id: change.id,
      target: change.target,
      timestamp: change.timestamp,
      type: change.type,
      urlScope: change.urlScope,
    },
    periods: {
      ...periods,
      daysEach: options.periodDays,
      wholeWeeks: options.periodDays / 7,
      weekdayBalanced: true,
      excludedChangeDate: changedOn,
      timezone: options.timezone,
    },
    scope: scope ? "explicit_urls" : "target",
    measurement: {
      traffic: "organic",
      landingPageDimension: "ym:s:startURL",
      conversionMetric,
      conversionsMethod: "visits_times_conversion_rate",
    },
    metrics: {
      visits: metricDelta(before.aggregate.visits, after.aggregate.visits),
      users: metricDelta(before.aggregate.users, after.aggregate.users),
      conversions: metricDelta(before.aggregate.conversions, after.aggregate.conversions),
      conversionRate: metricDelta(before.aggregate.conversionRate, after.aggregate.conversionRate),
    },
    landingPages: {
      totalCompared: pages.length,
      limit: options.resultLimit,
      items: pages.slice(0, options.resultLimit),
    },
    quality: {
      confidence: insufficientData
        ? "low"
        : sampled || truncated || dataLag > 0
          ? "medium"
          : "high",
      minimumRequiredVisits: options.minVisits,
      minimumObservedVisits: round(minimumObservedVisits),
      sampled,
      sampleShare: {
        before: before.sampleShare,
        after: after.sampleShare,
      },
      dataLag,
      sourceRows: {
        before: { returned: before.returnedRows, total: before.totalRows },
        after: { returned: after.returnedRows, total: after.totalRows },
      },
      limitations,
      causalClaim: false,
    },
  };
}

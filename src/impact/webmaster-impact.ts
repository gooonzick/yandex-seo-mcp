import type { WebmasterClient } from "../webmaster/client.js";
import { normalizeCrawlUrl, type SeoChange } from "../storage/schema.js";

type UnknownRecord = Record<string, unknown>;

export interface MeasureWebmasterImpactOptions {
  hostId: string;
  periodDays: number;
  dataDelayDays: number;
  minImpressions: number;
  sourceLimit: number;
  resultLimit: number;
  deviceType: "ALL" | "DESKTOP" | "MOBILE_AND_TABLET" | "MOBILE" | "TABLET";
  searchLocation:
    | "ALL_LOCATIONS"
    | "ALL_LOCATIONS_ORGANIC"
    | "WEB_LOCATION"
    | "DYNAMIC_LOCATION_ALL"
    | "DYNAMIC_LOCATION_BASIC"
    | "DYNAMIC_LOCATION_ADDITIONAL";
  regionIds?: number[] | undefined;
}

interface Period {
  date1: string;
  date2: string;
}

interface SearchMetrics {
  impressions: number;
  clicks: number;
  ctr: number;
  position: number | null;
}

interface AccumulatedSearchMetrics {
  impressions: number;
  clicks: number;
  positionTotal: number;
  positionWeight: number;
}

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

function shiftDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10);
}

function normalizedDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function inPeriod(date: string, period: Period): boolean {
  return date >= period.date1 && date <= period.date2;
}

function normalizeReportUrl(value: string): string {
  try {
    return normalizeCrawlUrl(value);
  } catch {
    return value.trim();
  }
}

function rowUrl(row: UnknownRecord): string | undefined {
  for (const candidate of [row.text_indicator, row.popular_complementary_indicator]) {
    const indicator = asRecord(candidate);
    if (indicator?.type === "URL" && typeof indicator.value === "string")
      return normalizeReportUrl(indicator.value);
  }
  return undefined;
}

function emptyAccumulated(): AccumulatedSearchMetrics {
  return { impressions: 0, clicks: 0, positionTotal: 0, positionWeight: 0 };
}

function finalize(metrics: AccumulatedSearchMetrics): SearchMetrics {
  return {
    impressions: round(metrics.impressions),
    clicks: round(metrics.clicks),
    ctr: metrics.impressions === 0 ? 0 : round((metrics.clicks / metrics.impressions) * 100),
    position:
      metrics.positionWeight === 0 ? null : round(metrics.positionTotal / metrics.positionWeight),
  };
}

function collectSearchMetrics(
  response: unknown,
  period: Period,
  scope: ReadonlySet<string> | undefined,
) {
  const record = asRecord(response);
  const rawRows = Array.isArray(record?.text_indicator_to_statistics)
    ? record.text_indicator_to_statistics
    : [];
  const byUrl = new Map<string, AccumulatedSearchMetrics>();
  for (const rawRow of rawRows) {
    const row = asRecord(rawRow);
    if (!row) continue;
    const url = rowUrl(row);
    if (!url || (scope && !scope.has(url))) continue;
    const statistics = Array.isArray(row.statistics) ? row.statistics : [];
    const byDate = new Map<string, Record<string, number>>();
    for (const rawStatistic of statistics) {
      const statistic = asRecord(rawStatistic);
      const date = normalizedDate(statistic?.date);
      const field = typeof statistic?.field === "string" ? statistic.field : undefined;
      const value = finiteNumber(statistic?.value);
      if (!date || !field || value === undefined || !inPeriod(date, period)) continue;
      const daily = byDate.get(date) ?? {};
      daily[field] = value;
      byDate.set(date, daily);
    }
    const accumulated = byUrl.get(url) ?? emptyAccumulated();
    for (const daily of byDate.values()) {
      const impressions = daily.IMPRESSIONS ?? 0;
      accumulated.impressions += impressions;
      accumulated.clicks += daily.CLICKS ?? 0;
      if (daily.POSITION !== undefined) {
        const weight = impressions > 0 ? impressions : 1;
        accumulated.positionTotal += daily.POSITION * weight;
        accumulated.positionWeight += weight;
      }
    }
    byUrl.set(url, accumulated);
  }
  const aggregate = [...byUrl.values()].reduce((result, metrics) => {
    result.impressions += metrics.impressions;
    result.clicks += metrics.clicks;
    result.positionTotal += metrics.positionTotal;
    result.positionWeight += metrics.positionWeight;
    return result;
  }, emptyAccumulated());
  const sourceCount = finiteNumber(record?.count) ?? rawRows.length;
  return {
    aggregate: finalize(aggregate),
    pages: new Map([...byUrl].map(([url, metrics]) => [url, finalize(metrics)])),
    sourceCount,
    returnedRows: rawRows.length,
    truncated: sourceCount > rawRows.length,
  };
}

function collectIndexingEvents(response: unknown, period: Period) {
  const record = asRecord(response);
  const indicators = asRecord(record?.indicators);
  const sum = (name: string): number => {
    const entries = Array.isArray(indicators?.[name]) ? indicators[name] : [];
    return entries.reduce((total, rawEntry) => {
      const entry = asRecord(rawEntry);
      const date = normalizedDate(entry?.date);
      const value = finiteNumber(entry?.value);
      return date && value !== undefined && inPeriod(date, period) ? total + value : total;
    }, 0);
  };
  const appeared = sum("APPEARED_IN_SEARCH");
  const removed = sum("REMOVED_FROM_SEARCH");
  return { appeared, removed, netChange: appeared - removed };
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

function nullableMetricDelta(before: number | null, after: number | null) {
  if (before === null || after === null)
    return { before, after, absoluteDelta: null, percentDelta: null };
  return metricDelta(before, after);
}

export async function measureWebmasterImpact(
  webmaster: Pick<WebmasterClient, "getQueryAnalytics" | "getSearchEventsHistory">,
  change: SeoChange,
  options: MeasureWebmasterImpactOptions,
  now = new Date(),
) {
  const changedOn = change.timestamp.slice(0, 10);
  const periods = {
    before: {
      date1: shiftDate(changedOn, -options.periodDays),
      date2: shiftDate(changedOn, -1),
    },
    after: {
      date1: shiftDate(changedOn, options.dataDelayDays + 1),
      date2: shiftDate(changedOn, options.dataDelayDays + options.periodDays),
    },
  };
  const queryAnalyticsBody = {
    offset: 0,
    limit: options.sourceLimit,
    device_type_indicator: options.deviceType,
    search_location: options.searchLocation,
    text_indicator: "URL",
    ...(options.regionIds ? { region_ids: options.regionIds } : {}),
    sort_by_date: {
      date: periods.after.date2,
      statistic_field: "IMPRESSIONS",
      by: "DESC",
    },
  };
  const [queryAnalytics, indexingEvents] = await Promise.all([
    webmaster.getQueryAnalytics(options.hostId, queryAnalyticsBody),
    webmaster.getSearchEventsHistory(options.hostId, {
      date_from: periods.before.date1,
      date_to: periods.after.date2,
    }),
  ]);
  const scope = change.urlScope.length > 0 ? new Set(change.urlScope) : undefined;
  const before = collectSearchMetrics(queryAnalytics, periods.before, scope);
  const after = collectSearchMetrics(queryAnalytics, periods.after, scope);
  const beforeEvents = collectIndexingEvents(indexingEvents, periods.before);
  const afterEvents = collectIndexingEvents(indexingEvents, periods.after);
  const urls = [...new Set([...before.pages.keys(), ...after.pages.keys()])];
  const pages = urls
    .map((url) => {
      const previous = before.pages.get(url) ?? finalize(emptyAccumulated());
      const current = after.pages.get(url) ?? finalize(emptyAccumulated());
      return {
        url,
        impressions: metricDelta(previous.impressions, current.impressions),
        clicks: metricDelta(previous.clicks, current.clicks),
        ctr: metricDelta(previous.ctr, current.ctr),
        position: nullableMetricDelta(previous.position, current.position),
      };
    })
    .sort(
      (left, right) =>
        Math.abs(right.impressions.absoluteDelta) - Math.abs(left.impressions.absoluteDelta) ||
        left.url.localeCompare(right.url),
    );
  const today = now.toISOString().slice(0, 10);
  const latestExpectedDataDate = shiftDate(today, -options.dataDelayDays);
  const earliestQueryAnalyticsDate = shiftDate(today, -13);
  const postPeriodReady = periods.after.date2 <= latestExpectedDataDate;
  const retentionLimited = periods.before.date1 < earliestQueryAnalyticsDate;
  const minimumObservedImpressions = Math.min(
    before.aggregate.impressions,
    after.aggregate.impressions,
  );
  const lowVolume = minimumObservedImpressions < options.minImpressions;
  const truncated = before.truncated || after.truncated;
  const limitations = [
    "OBSERVATIONAL_ASSOCIATION_NOT_CAUSAL",
    `WEBMASTER_DATA_DELAY_ASSUMED_${options.dataDelayDays}_DAYS`,
    ...(lowVolume ? ["LOW_IMPRESSION_VOLUME"] : []),
    ...(!postPeriodReady ? ["POST_CHANGE_PERIOD_NOT_YET_EXPECTED"] : []),
    ...(retentionLimited ? ["QUERY_ANALYTICS_TWO_WEEK_WINDOW"] : []),
    ...(truncated ? ["QUERY_ANALYTICS_SOURCE_LIMIT"] : []),
    ...(scope ? ["INDEXING_EVENTS_ARE_TARGET_LEVEL"] : []),
  ];
  const insufficientData = lowVolume || !postPeriodReady;
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
      excludedChangeDate: changedOn,
      postChangeDelayDays: options.dataDelayDays,
    },
    dataAvailability: {
      latestExpectedDataDate,
      earliestQueryAnalyticsDate,
      postPeriodReady,
    },
    scope: scope ? "explicit_urls" : "target",
    search: {
      impressions: metricDelta(before.aggregate.impressions, after.aggregate.impressions),
      clicks: metricDelta(before.aggregate.clicks, after.aggregate.clicks),
      ctr: metricDelta(before.aggregate.ctr, after.aggregate.ctr),
      position: {
        ...nullableMetricDelta(before.aggregate.position, after.aggregate.position),
        lowerIsBetter: true,
      },
    },
    indexingEvents: {
      scope: "target",
      appeared: metricDelta(beforeEvents.appeared, afterEvents.appeared),
      removed: metricDelta(beforeEvents.removed, afterEvents.removed),
      netChange: metricDelta(beforeEvents.netChange, afterEvents.netChange),
    },
    urls: {
      totalCompared: pages.length,
      limit: options.resultLimit,
      items: pages.slice(0, options.resultLimit),
    },
    quality: {
      confidence: insufficientData
        ? "low"
        : truncated || retentionLimited || Boolean(scope)
          ? "medium"
          : "high",
      minimumRequiredImpressions: options.minImpressions,
      minimumObservedImpressions: round(minimumObservedImpressions),
      sourceRows: {
        returned: Math.max(before.returnedRows, after.returnedRows),
        total: Math.max(before.sourceCount, after.sourceCount),
      },
      limitations,
      causalClaim: false,
    },
  };
}

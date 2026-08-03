import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig, MonitorTarget } from "../config.js";
import type { MetricaClient } from "../metrica/client.js";
import { handleTool, type ResultLimits } from "../shared/result.js";
import { createPaginationInputSchema } from "../shared/pagination.js";
import type { WebmasterClient } from "../webmaster/client.js";
import { MonitoringStore, type MonitoringSnapshot } from "./store.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function metricValues(response: unknown): number[] {
  const record = asRecord(response);
  const data = Array.isArray(record?.data) ? record.data : [];
  const row = asRecord(data[0]);
  return Array.isArray(row?.metrics)
    ? row.metrics.map((value) => (typeof value === "number" ? value : 0))
    : [];
}

function structuralCount(value: unknown, pattern: RegExp): number {
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + structuralCount(item, pattern), 0);
  const record = asRecord(value);
  if (!record) return 0;
  return Object.entries(record).reduce(
    (sum, [key, item]) =>
      sum +
      (pattern.test(key) && (item === true || (typeof item === "number" && item > 0)) ? 1 : 0) +
      structuralCount(item, pattern),
    0,
  );
}

function firstNumberByKey(value: unknown, pattern: RegExp): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstNumberByKey(item, pattern);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const [key, item] of Object.entries(record)) {
    if (pattern.test(key) && typeof item === "number") return item;
    const found = firstNumberByKey(item, pattern);
    if (found !== undefined) return found;
  }
  return undefined;
}

function searchPerformance(response: unknown): NonNullable<MonitoringSnapshot["search"]> {
  const record = asRecord(response);
  const rows = Array.isArray(record?.text_indicator_to_statistics)
    ? record.text_indicator_to_statistics
    : [];
  let impressions = 0;
  let clicks = 0;
  const positions: number[] = [];
  for (const rawRow of rows) {
    const row = asRecord(rawRow);
    const statistics = Array.isArray(row?.statistics) ? row.statistics : [];
    for (const rawStatistic of statistics) {
      const statistic = asRecord(rawStatistic);
      const value = statistic?.value;
      if (typeof value !== "number") continue;
      if (statistic?.field === "IMPRESSIONS") impressions += value;
      else if (statistic?.field === "CLICKS") clicks += value;
      else if (statistic?.field === "POSITION") positions.push(value);
    }
  }
  return {
    impressions,
    clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    position:
      positions.length > 0
        ? positions.reduce((sum, position) => sum + position, 0) / positions.length
        : null,
  };
}

export async function captureSnapshot(
  target: MonitorTarget,
  store: MonitoringStore,
  metrica: MetricaClient,
  webmaster: WebmasterClient,
): Promise<MonitoringSnapshot> {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 6 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const [summary, diagnostics, sitemaps, queryAnalytics, traffic] = await Promise.all([
    webmaster.getSummary(target.hostId),
    webmaster.getDiagnostics(target.hostId),
    webmaster.listSitemaps(target.hostId, { limit: 100, offset: 0 }),
    webmaster.getQueryAnalytics(target.hostId, {
      offset: 0,
      limit: 500,
      device_type_indicator: "ALL",
      search_location: "WEB_LOCATION",
      text_indicator: "QUERY",
      sort_by_date: { date: today, statistic_field: "IMPRESSIONS", by: "DESC" },
    }),
    target.counterId
      ? metrica.getReport({
          ids: target.counterId,
          date1: from,
          date2: today,
          metrics: "ym:s:visits,ym:s:users,ym:s:anyGoalConversionRate",
          filters: "ym:s:lastSignTrafficSource=='organic'",
        })
      : Promise.resolve(undefined),
  ]);
  const metrics = traffic ? metricValues(traffic) : undefined;
  return store.add({
    target: target.name,
    hostId: target.hostId,
    ...(target.counterId ? { counterId: target.counterId } : {}),
    summary,
    diagnostics,
    sitemaps,
    search: searchPerformance(queryAnalytics),
    ...(metrics
      ? {
          organic: {
            visits: metrics[0] ?? 0,
            users: metrics[1] ?? 0,
            conversionRate: metrics[2] ?? 0,
          },
        }
      : {}),
  });
}

function compareSnapshots(current: MonitoringSnapshot, previous?: MonitoringSnapshot) {
  const alerts: Array<{
    severity: "critical" | "warning" | "info";
    code: string;
    message: string;
    change?: number;
  }> = [];
  const critical = structuralCount(current.diagnostics, /fatal|critical/i);
  const warnings = structuralCount(current.diagnostics, /warning|error/i);
  const sitemapProblems = structuralCount(current.sitemaps, /error|problem/i);
  if (critical > 0)
    alerts.push({
      severity: "critical",
      code: "CRITICAL_DIAGNOSTICS",
      message: `${critical} critical diagnostic signal(s) detected.`,
    });
  if (warnings > 0)
    alerts.push({
      severity: "warning",
      code: "DIAGNOSTIC_WARNINGS",
      message: `${warnings} warning/error diagnostic signal(s) detected.`,
    });
  if (sitemapProblems > 0)
    alerts.push({
      severity: "warning",
      code: "SITEMAP_PROBLEMS",
      message: `${sitemapProblems} Sitemap problem signal(s) detected.`,
    });
  if (previous?.organic && current.organic && previous.organic.visits > 0) {
    const change =
      ((current.organic.visits - previous.organic.visits) / previous.organic.visits) * 100;
    if (change <= -20)
      alerts.push({
        severity: change <= -50 ? "critical" : "warning",
        code: "ORGANIC_TRAFFIC_DROP",
        message: `Organic visits dropped by ${Math.abs(Math.round(change * 100) / 100)}%.`,
        change: Math.round(change * 100) / 100,
      });
  }
  const previousIndexed = previous
    ? firstNumberByKey(previous.summary, /searchable.*pages|indexed.*pages/i)
    : undefined;
  const currentIndexed = firstNumberByKey(current.summary, /searchable.*pages|indexed.*pages/i);
  if (
    previousIndexed !== undefined &&
    currentIndexed !== undefined &&
    previousIndexed > 0 &&
    currentIndexed < previousIndexed
  ) {
    const change = ((currentIndexed - previousIndexed) / previousIndexed) * 100;
    alerts.push({
      severity: change <= -20 ? "critical" : "warning",
      code: "INDEXED_PAGES_DROP",
      message: `Indexed/searchable pages dropped from ${previousIndexed} to ${currentIndexed}.`,
      change: Math.round(change * 100) / 100,
    });
  }
  if (previous?.search && current.search) {
    if (previous.search.ctr > 0) {
      const ctrChange = ((current.search.ctr - previous.search.ctr) / previous.search.ctr) * 100;
      if (ctrChange <= -20)
        alerts.push({
          severity: "warning",
          code: "SEARCH_CTR_DROP",
          message: `Aggregate search CTR dropped by ${Math.abs(Math.round(ctrChange * 100) / 100)}%.`,
          change: Math.round(ctrChange * 100) / 100,
        });
    }
    if (
      previous.search.position !== null &&
      current.search.position !== null &&
      current.search.position - previous.search.position >= 2
    )
      alerts.push({
        severity: "warning",
        code: "SEARCH_POSITION_DROP",
        message: `Average search position worsened from ${Math.round(previous.search.position * 100) / 100} to ${Math.round(current.search.position * 100) / 100}.`,
        change: Math.round((current.search.position - previous.search.position) * 100) / 100,
      });
  }
  if (alerts.length === 0)
    alerts.push({ severity: "info", code: "STABLE", message: "No alert threshold was crossed." });
  return alerts;
}

export function registerMonitoringTools(
  server: McpServer,
  store: MonitoringStore,
  metrica: MetricaClient,
  webmaster: WebmasterClient,
  config: AppConfig,
): void {
  const limits: ResultLimits = {
    maxRows: config.maxResultRows,
    maxBytes: config.maxResultBytes,
  };
  const targetSchema = z.object({
    name: z.string().min(1).max(100),
    hostId: z.string().min(1).max(2_000),
    counterId: z.number().int().positive().optional(),
  });

  server.registerTool(
    "monitor_capture_snapshot",
    {
      title: "Capture a Yandex SEO monitoring snapshot",
      description: "Persist current Webmaster health and optional seven-day organic metrics.",
      inputSchema: targetSchema,
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
          captureSnapshot(
            {
              name: input.name,
              hostId: input.hostId,
              ...(input.counterId ? { counterId: input.counterId } : {}),
            },
            store,
            metrica,
            webmaster,
          ),
        limits,
      ),
  );

  server.registerTool(
    "monitor_list_snapshots",
    {
      title: "List SEO monitoring snapshots",
      description: "Read recent persisted snapshots, optionally filtered by target name.",
      inputSchema: createPaginationInputSchema(200, 50).extend({
        target: z.string().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ target, cursor, limit }) =>
      handleTool(async () => {
        const page = await store.listPage(target, cursor, limit);
        return { snapshots: page.items, pageInfo: page.pageInfo };
      }, limits),
  );

  server.registerTool(
    "monitor_check_alerts",
    {
      title: "Check SEO monitoring alerts",
      description: "Compare the two latest snapshots and detect traffic or health regressions.",
      inputSchema: z.object({ target: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ target }) =>
      handleTool(async () => {
        const snapshots = await store.list(target, 2);
        const current = snapshots[0];
        if (!current) return { target, status: "NO_SNAPSHOTS", alerts: [] };
        return {
          target,
          status: snapshots.length > 1 ? "COMPARED" : "BASELINE_ONLY",
          currentSnapshotId: current.id,
          previousSnapshotId: snapshots[1]?.id ?? null,
          alerts: compareSnapshots(current, snapshots[1]),
        };
      }, limits),
  );
}

export function startMonitoringScheduler(
  targets: MonitorTarget[],
  intervalMs: number,
  store: MonitoringStore,
  metrica: MetricaClient,
  webmaster: WebmasterClient,
): (() => void) | undefined {
  if (intervalMs <= 0 || targets.length === 0) return undefined;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (const target of targets) {
        await captureSnapshot(target, store, metrica, webmaster).catch((error: unknown) => {
          process.stderr.write(
            `Monitoring snapshot failed for ${target.name}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      }
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

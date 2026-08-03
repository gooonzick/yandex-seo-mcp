import { z } from "zod";
import {
  CRAWL_REGRESSION_TYPES,
  type CrawlRegressionExclusion,
} from "./crawler/regression-detector.js";

const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const environmentSchema = z.object({
  YANDEX_OAUTH_TOKEN: z.string().min(1).optional(),
  YANDEX_METRICA_TOKEN: z.string().min(1).optional(),
  YANDEX_WEBMASTER_TOKEN: z.string().min(1).optional(),
  YANDEX_HTTP_TIMEOUT_MS: positiveInteger(30_000),
  YANDEX_HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  YANDEX_HTTP_MAX_CONCURRENCY: positiveInteger(8),
  YANDEX_HTTP_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),
  YANDEX_MAX_RESULT_ROWS: positiveInteger(1_000),
  YANDEX_MAX_RESULT_BYTES: positiveInteger(500_000),
  MONITOR_STORAGE_PATH: z.string().min(1).default(".yandex-seo-monitor.json"),
  MONITOR_RETENTION_DAYS: positiveInteger(90),
  MONITOR_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  MONITOR_TARGETS_JSON: z.string().default("[]"),
  CRAWLER_MAX_PAGES: positiveInteger(200),
  CRAWLER_MAX_DEPTH: z.coerce.number().int().min(0).max(20).default(5),
  CRAWLER_TIMEOUT_MS: positiveInteger(15_000),
  CRAWLER_MAX_BODY_BYTES: positiveInteger(2_000_000),
  CRAWLER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  CRAWLER_DELAY_MS: z.coerce.number().int().min(0).default(0),
  CRAWLER_USER_AGENT: z.string().min(1).max(200).default("YandexSeoMcpBot/1.0"),
  CRAWLER_SNAPSHOT_RETENTION_DAYS: positiveInteger(90),
  CRAWLER_SNAPSHOT_MAX_RUNS: positiveInteger(100),
  CRAWLER_SNAPSHOT_QUERY_DENYLIST: z
    .string()
    .default(
      "access_token,api_key,apikey,auth,authorization,code,credential,key,password,secret,session,sessionid,sid,token",
    ),
  CRAWLER_REGRESSION_EXCLUSIONS_JSON: z.string().default("[]"),
  QUERY_CLUSTER_THRESHOLD: z.coerce.number().min(0.1).max(1).default(0.42),
  QUERY_MAX_QUERIES: z.coerce.number().int().min(10).max(2_000).default(500),
  YANDEX_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  YANDEX_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  YANDEX_OAUTH_REDIRECT_URI: z.url().optional(),
  YANDEX_OAUTH_STORAGE_KEY: z.string().min(32).optional(),
  YANDEX_OAUTH_STORAGE_PATH: z.string().min(1).default(".yandex-seo-oauth.enc"),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  MCP_HTTP_BEARER_TOKEN: z.string().min(16).optional(),
  MCP_HTTP_RATE_LIMIT_PER_MINUTE: positiveInteger(120),
});

export interface AppConfig {
  metricaToken?: string;
  webmasterToken?: string;
  httpTimeoutMs: number;
  httpMaxRetries: number;
  httpMaxConcurrency?: number;
  httpCacheTtlMs?: number;
  maxResultRows: number;
  maxResultBytes: number;
  monitorStoragePath?: string;
  monitorRetentionDays?: number;
  monitorIntervalMs?: number;
  monitorTargets?: MonitorTarget[];
  crawlerMaxPages?: number;
  crawlerMaxDepth?: number;
  crawlerTimeoutMs?: number;
  crawlerMaxBodyBytes?: number;
  crawlerConcurrency?: number;
  crawlerDelayMs?: number;
  crawlerUserAgent?: string;
  crawlerSnapshotRetentionDays?: number;
  crawlerSnapshotMaxRuns?: number;
  crawlerSnapshotQueryDenylist?: string[];
  crawlerRegressionExclusions?: CrawlRegressionExclusion[];
  queryClusterThreshold?: number;
  queryMaxQueries?: number;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUri?: string;
  oauthStorageKey?: string;
  oauthStoragePath?: string;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  mcpBearerToken?: string;
  httpRateLimitPerMinute?: number;
}

export interface MonitorTarget {
  name: string;
  hostId: string;
  counterId?: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const commonToken = parsed.YANDEX_OAUTH_TOKEN;
  const parsedMonitorTargets = z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        hostId: z.string().min(1).max(2_000),
        counterId: z.number().int().positive().optional(),
      }),
    )
    .parse(JSON.parse(parsed.MONITOR_TARGETS_JSON) as unknown);
  const monitorTargets: MonitorTarget[] = parsedMonitorTargets.map((target) => ({
    name: target.name,
    hostId: target.hostId,
    ...(target.counterId ? { counterId: target.counterId } : {}),
  }));
  const crawlerRegressionExclusions = z
    .array(
      z.object({
        target: z.url(),
        types: z.array(z.enum(CRAWL_REGRESSION_TYPES)).default([]),
        urlPrefixes: z.array(z.url()).default([]),
      }),
    )
    .parse(JSON.parse(parsed.CRAWLER_REGRESSION_EXCLUSIONS_JSON) as unknown);

  const config: AppConfig = {
    httpTimeoutMs: parsed.YANDEX_HTTP_TIMEOUT_MS,
    httpMaxRetries: parsed.YANDEX_HTTP_MAX_RETRIES,
    httpMaxConcurrency: parsed.YANDEX_HTTP_MAX_CONCURRENCY,
    httpCacheTtlMs: parsed.YANDEX_HTTP_CACHE_TTL_MS,
    maxResultRows: parsed.YANDEX_MAX_RESULT_ROWS,
    maxResultBytes: parsed.YANDEX_MAX_RESULT_BYTES,
    monitorStoragePath: parsed.MONITOR_STORAGE_PATH,
    monitorRetentionDays: parsed.MONITOR_RETENTION_DAYS,
    monitorIntervalMs: parsed.MONITOR_INTERVAL_MS,
    monitorTargets,
    crawlerMaxPages: parsed.CRAWLER_MAX_PAGES,
    crawlerMaxDepth: parsed.CRAWLER_MAX_DEPTH,
    crawlerTimeoutMs: parsed.CRAWLER_TIMEOUT_MS,
    crawlerMaxBodyBytes: parsed.CRAWLER_MAX_BODY_BYTES,
    crawlerConcurrency: parsed.CRAWLER_CONCURRENCY,
    crawlerDelayMs: parsed.CRAWLER_DELAY_MS,
    crawlerUserAgent: parsed.CRAWLER_USER_AGENT,
    crawlerSnapshotRetentionDays: parsed.CRAWLER_SNAPSHOT_RETENTION_DAYS,
    crawlerSnapshotMaxRuns: parsed.CRAWLER_SNAPSHOT_MAX_RUNS,
    crawlerSnapshotQueryDenylist: parsed.CRAWLER_SNAPSHOT_QUERY_DENYLIST.split(",")
      .map((key) => key.trim().toLowerCase())
      .filter(Boolean),
    crawlerRegressionExclusions,
    queryClusterThreshold: parsed.QUERY_CLUSTER_THRESHOLD,
    queryMaxQueries: parsed.QUERY_MAX_QUERIES,
    transport: parsed.MCP_TRANSPORT,
    httpHost: parsed.MCP_HTTP_HOST,
    httpPort: parsed.MCP_HTTP_PORT,
    httpRateLimitPerMinute: parsed.MCP_HTTP_RATE_LIMIT_PER_MINUTE,
    oauthStoragePath: parsed.YANDEX_OAUTH_STORAGE_PATH,
  };
  const metricaToken = parsed.YANDEX_METRICA_TOKEN ?? commonToken;
  const webmasterToken = parsed.YANDEX_WEBMASTER_TOKEN ?? commonToken;
  if (metricaToken) config.metricaToken = metricaToken;
  if (webmasterToken) config.webmasterToken = webmasterToken;
  if (parsed.MCP_HTTP_BEARER_TOKEN) config.mcpBearerToken = parsed.MCP_HTTP_BEARER_TOKEN;
  if (parsed.YANDEX_OAUTH_CLIENT_ID) config.oauthClientId = parsed.YANDEX_OAUTH_CLIENT_ID;
  if (parsed.YANDEX_OAUTH_CLIENT_SECRET)
    config.oauthClientSecret = parsed.YANDEX_OAUTH_CLIENT_SECRET;
  if (parsed.YANDEX_OAUTH_REDIRECT_URI) config.oauthRedirectUri = parsed.YANDEX_OAUTH_REDIRECT_URI;
  if (parsed.YANDEX_OAUTH_STORAGE_KEY) config.oauthStorageKey = parsed.YANDEX_OAUTH_STORAGE_KEY;
  return config;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ActionStore } from "./actions/store.js";
import { registerActionTools } from "./actions/tools.js";
import type { AppConfig } from "./config.js";
import { DirectClient } from "./direct/client.js";
import { registerDirectTools } from "./direct/tools.js";
import { SeoCrawler } from "./crawler/crawler.js";
import { CrawlSnapshotStore } from "./crawler/snapshot-store.js";
import { registerCrawlerTools } from "./crawler/tools.js";
import type { HostResolver } from "./crawler/types.js";
import { registerQueryIntelligenceTools } from "./intelligence/tools.js";
import { SeoChangeStore } from "./impact/change-store.js";
import { registerSeoImpactTools } from "./impact/tools.js";
import { MetricaClient } from "./metrica/client.js";
import { registerMetricaTools } from "./metrica/tools.js";
import { registerMcpContent } from "./mcp/content.js";
import { MonitoringStore } from "./monitoring/store.js";
import { registerMonitoringTools } from "./monitoring/tools.js";
import { registerSeoTools } from "./seo/tools.js";
import { safeError } from "./shared/errors.js";
import { handleTool } from "./shared/result.js";
import { WebmasterClient } from "./webmaster/client.js";
import { registerWebmasterTools } from "./webmaster/tools.js";
import { WordstatClient } from "./wordstat/client.js";
import { registerWordstatTools } from "./wordstat/tools.js";

export interface ServerDependencies {
  config: AppConfig;
  fetch?: typeof globalThis.fetch;
  resolveHost?: HostResolver;
}

export interface YandexSeoServer {
  server: McpServer;
  metrica: MetricaClient;
  webmaster: WebmasterClient;
  direct: DirectClient;
  monitoring: MonitoringStore;
  crawler: SeoCrawler;
  crawlSnapshots: CrawlSnapshotStore;
  seoChanges: SeoChangeStore;
  actions: ActionStore;
}

export function createServer(dependencies: ServerDependencies): YandexSeoServer {
  const { config } = dependencies;
  const server = new McpServer({
    name: "yandex-seo-mcp",
    version: "1.3.0",
  });
  const clientOptions = {
    timeoutMs: config.httpTimeoutMs,
    maxRetries: config.httpMaxRetries,
    ...(config.httpMaxConcurrency !== undefined
      ? { maxConcurrency: config.httpMaxConcurrency }
      : {}),
    ...(config.httpCacheTtlMs !== undefined ? { cacheTtlMs: config.httpCacheTtlMs } : {}),
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
  };
  const metrica = new MetricaClient({
    ...clientOptions,
    ...(config.metricaToken ? { token: config.metricaToken } : {}),
  });
  const webmaster = new WebmasterClient({
    ...clientOptions,
    ...(config.webmasterToken ? { token: config.webmasterToken } : {}),
  });
  const limits = {
    maxRows: config.maxResultRows,
    maxBytes: config.maxResultBytes,
  };
  const direct = new DirectClient({
    ...clientOptions,
    maxConcurrency: Math.min(config.httpMaxConcurrency ?? 2, 2),
    ...(config.directToken ? { token: config.directToken } : {}),
    ...(config.directClientLogin ? { clientLogin: config.directClientLogin } : {}),
    sandbox: config.directSandbox ?? false,
  });
  const wordstat = new WordstatClient(clientOptions, config.wordstat);
  const monitoring = new MonitoringStore(
    config.monitorStoragePath ?? ".yandex-seo-monitor.json",
    config.monitorRetentionDays ?? 90,
  );
  const crawler = new SeoCrawler({
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.resolveHost ? { resolveHost: dependencies.resolveHost } : {}),
  });
  const crawlSnapshots = new CrawlSnapshotStore(
    config.monitorStoragePath ?? ".yandex-seo-monitor.json",
    {
      maxAgeDays: config.crawlerSnapshotRetentionDays ?? 90,
      maxRunsPerTarget: config.crawlerSnapshotMaxRuns ?? 100,
    },
    config.crawlerSnapshotQueryDenylist,
  );
  const seoChanges = new SeoChangeStore(
    config.monitorStoragePath ?? ".yandex-seo-monitor.json",
    config.crawlerSnapshotQueryDenylist,
  );
  const actions = new ActionStore(config.monitorStoragePath ?? ".yandex-seo-monitor.json");

  server.registerTool(
    "yandex_capabilities",
    {
      title: "Yandex SEO MCP capabilities",
      description: "Show configured services, safety limits and write-tool state.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      handleTool(
        async () => ({
          services: {
            metrica: { configured: Boolean(config.metricaToken) },
            webmaster: { configured: Boolean(config.webmasterToken) },
            wordstat: { configured: Boolean(config.wordstat) },
            direct: {
              configured: Boolean(config.directToken),
              sandbox: config.directSandbox ?? false,
              writeRequiresConfirmation: true,
            },
          },
          limits: {
            maxRows: config.maxResultRows,
            maxBytes: config.maxResultBytes,
            timeoutMs: config.httpTimeoutMs,
            maxRetries: config.httpMaxRetries,
            maxConcurrency: config.httpMaxConcurrency ?? 8,
            cacheTtlMs: config.httpCacheTtlMs ?? 30_000,
          },
          monitoring: {
            retentionDays: config.monitorRetentionDays ?? 90,
            intervalMs: config.monitorIntervalMs ?? 0,
            scheduledTargets: config.monitorTargets?.length ?? 0,
          },
          crawler: {
            maxPages: config.crawlerMaxPages ?? 200,
            maxDepth: config.crawlerMaxDepth ?? 5,
            concurrency: config.crawlerConcurrency ?? 4,
            maxBodyBytes: config.crawlerMaxBodyBytes ?? 2_000_000,
            snapshotRetentionDays: config.crawlerSnapshotRetentionDays ?? 90,
            snapshotMaxRunsPerTarget: config.crawlerSnapshotMaxRuns ?? 100,
            historyCleanupEnabled: Boolean(config.crawlerHistoryWriteToolsEnabled),
          },
          queryIntelligence: {
            maxQueries: config.queryMaxQueries ?? 500,
            clusterThreshold: config.queryClusterThreshold ?? 0.42,
            externalAiUsed: false,
          },
          multiUserOAuthConfigured: Boolean(
            config.oauthClientId && config.oauthRedirectUri && config.oauthStorageKey,
          ),
          writeToolsEnabled: true,
          transport: config.transport,
        }),
        limits,
      ),
  );

  server.registerTool(
    "yandex_connection_check",
    {
      title: "Check Yandex API connections",
      description: "Perform minimal authenticated calls to configured Yandex services.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      handleTool(async () => {
        const check = async (
          configured: boolean,
          operation: () => Promise<unknown>,
        ): Promise<Record<string, unknown>> => {
          if (!configured) return { configured: false, ok: false };
          try {
            await operation();
            return { configured: true, ok: true };
          } catch (error) {
            return { configured: true, ok: false, error: safeError(error) };
          }
        };
        const [metricaResult, webmasterResult, directResult, wordstatResult] = await Promise.all([
          check(Boolean(config.metricaToken), () =>
            metrica.listCounters({ offset: 1, per_page: 1 }),
          ),
          check(Boolean(config.webmasterToken), () => webmaster.getUser()),
          check(Boolean(config.directToken), () =>
            direct.rpc("campaigns", "get", {
              SelectionCriteria: {},
              FieldNames: ["Id"],
              Page: { Limit: 1 },
            }),
          ),
          check(Boolean(config.wordstat), () => wordstat.request("getRegionsTree", {})),
        ]);
        return {
          metrica: metricaResult,
          webmaster: webmasterResult,
          direct: directResult,
          wordstat: wordstatResult,
          ok: [metricaResult, webmasterResult, directResult, wordstatResult].some(
            (result) => result.ok === true,
          ),
        };
      }, limits),
  );

  registerMetricaTools(server, metrica, config);
  registerWordstatTools(server, wordstat, limits);
  registerDirectTools(server, direct, config);
  registerWebmasterTools(server, webmaster, config);
  registerSeoTools(server, metrica, webmaster, config);
  registerMonitoringTools(server, monitoring, metrica, webmaster, config);
  registerMcpContent(server, metrica, webmaster, monitoring, config);
  registerCrawlerTools(server, crawler, crawlSnapshots, webmaster, config);
  registerSeoImpactTools(server, seoChanges, crawlSnapshots, metrica, webmaster, config);
  registerQueryIntelligenceTools(server, webmaster, crawler, config);
  registerActionTools(server, actions, config);

  return {
    server,
    metrica,
    webmaster,
    direct,
    monitoring,
    crawler,
    crawlSnapshots,
    seoChanges,
    actions,
  };
}

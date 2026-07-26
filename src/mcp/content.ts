import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { MetricaClient } from "../metrica/client.js";
import type { MonitoringStore } from "../monitoring/store.js";
import { telemetry } from "../shared/telemetry.js";
import type { WebmasterClient } from "../webmaster/client.js";

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function registerMcpContent(
  server: McpServer,
  metrica: MetricaClient,
  webmaster: WebmasterClient,
  monitoring: MonitoringStore,
  config: AppConfig,
): void {
  server.registerResource(
    "yandex-capabilities",
    "yandex://capabilities",
    {
      title: "Yandex SEO MCP capabilities",
      description: "Configured integrations, safety limits and monitoring state.",
      mimeType: "application/json",
    },
    (uri) =>
      jsonResource(uri, {
        services: {
          metrica: Boolean(config.metricaToken),
          webmaster: Boolean(config.webmasterToken),
        },
        monitoring: {
          retentionDays: config.monitorRetentionDays ?? 90,
          scheduledTargets: config.monitorTargets?.map((target) => target.name) ?? [],
          intervalMs: config.monitorIntervalMs ?? 0,
        },
        crawler: {
          maxPages: config.crawlerMaxPages ?? 200,
          maxDepth: config.crawlerMaxDepth ?? 5,
          concurrency: config.crawlerConcurrency ?? 4,
          userAgent: config.crawlerUserAgent ?? "YandexSeoMcpBot/1.0",
        },
        queryIntelligence: {
          maxQueries: config.queryMaxQueries ?? 500,
          clusterThreshold: config.queryClusterThreshold ?? 0.42,
          externalAiUsed: false,
        },
        oauthPkceConfigured: Boolean(config.oauthClientId && config.oauthRedirectUri),
        writeToolsEnabled: config.enableWriteTools,
      }),
  );

  server.registerResource(
    "yandex-counters",
    "yandex://metrica/counters",
    {
      title: "Available Yandex Metrica counters",
      description: "Live list of counters available to the configured identity.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await metrica.listCounters({ offset: 1, per_page: 1_000 })),
  );

  server.registerResource(
    "yandex-hosts",
    "yandex://webmaster/hosts",
    {
      title: "Available Yandex Webmaster hosts",
      description: "Live list of sites available to the configured identity.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, await webmaster.listHosts()),
  );

  server.registerResource(
    "yandex-monitoring",
    "yandex://monitoring/snapshots",
    {
      title: "Recent Yandex SEO monitoring snapshots",
      description: "Recent locally persisted health and organic-traffic snapshots.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri, { snapshots: await monitoring.list(undefined, 50) }),
  );

  server.registerResource(
    "yandex-telemetry",
    "yandex://telemetry",
    {
      title: "Yandex API telemetry",
      description: "Process-local request, retry, cache and latency counters.",
      mimeType: "application/json",
    },
    (uri) => jsonResource(uri, telemetry.snapshot()),
  );

  server.registerPrompt(
    "weekly_seo_report",
    {
      title: "Weekly Yandex SEO report",
      description: "Guide an agent through a concise weekly SEO performance and health report.",
      argsSchema: {
        hostId: z.string().min(1),
        counterId: z.string().regex(/^\d+$/),
        currentPeriod: z.string().min(1),
        previousPeriod: z.string().min(1),
      },
    },
    ({ hostId, counterId, currentPeriod, previousPeriod }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Prepare a weekly SEO report for Webmaster host ${hostId} and Metrica counter ${counterId}. ` +
              `Compare ${currentPeriod} with ${previousPeriod}. Run the site audit, period comparison, ` +
              "page analysis, content-decay and growth-opportunity tools. Prioritize evidence-backed actions.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "investigate_traffic_drop",
    {
      title: "Investigate an organic traffic drop",
      description: "Guide a root-cause analysis across Metrica and Webmaster.",
      argsSchema: {
        hostId: z.string().min(1),
        counterId: z.string().regex(/^\d+$/),
        period: z.string().min(1),
      },
    },
    ({ hostId, counterId, period }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Investigate the organic traffic drop during ${period} for host ${hostId} and counter ${counterId}. ` +
              "Check monitoring alerts, indexing diagnostics, content decay, page-level search visibility, " +
              "device/region segments and conversion changes. Separate confirmed causes from hypotheses.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "prioritize_seo_backlog",
    {
      title: "Prioritize an SEO backlog",
      description: "Turn Yandex data into a ranked action backlog.",
      argsSchema: {
        hostId: z.string().min(1),
        counterId: z.string().regex(/^\d+$/),
      },
    },
    ({ hostId, counterId }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Create a prioritized SEO backlog for host ${hostId} and counter ${counterId}. ` +
              "Use the site audit, page analysis, cannibalization and opportunity forecast. " +
              "Rank actions by expected impact, confidence and effort; include the supporting metrics.",
          },
        },
      ],
    }),
  );
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { MetricaClient } from "./metrica/client.js";
import { registerMetricaTools } from "./metrica/tools.js";
import { safeError } from "./shared/errors.js";
import { handleTool } from "./shared/result.js";
import { WebmasterClient } from "./webmaster/client.js";
import { registerWebmasterTools } from "./webmaster/tools.js";

export interface ServerDependencies {
  config: AppConfig;
  fetch?: typeof globalThis.fetch;
}

export interface YandexSeoServer {
  server: McpServer;
  metrica: MetricaClient;
  webmaster: WebmasterClient;
}

export function createServer(dependencies: ServerDependencies): YandexSeoServer {
  const { config } = dependencies;
  const server = new McpServer({
    name: "yandex-seo-mcp",
    version: "0.1.0",
  });
  const clientOptions = {
    timeoutMs: config.httpTimeoutMs,
    maxRetries: config.httpMaxRetries,
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
          },
          limits: {
            maxRows: config.maxResultRows,
            maxBytes: config.maxResultBytes,
            timeoutMs: config.httpTimeoutMs,
            maxRetries: config.httpMaxRetries,
          },
          writeToolsEnabled: config.enableWriteTools,
          transport: "stdio",
        }),
        limits,
      ),
  );

  server.registerTool(
    "yandex_connection_check",
    {
      title: "Check Yandex API connections",
      description: "Perform minimal authenticated calls to Metrica and Webmaster.",
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
        const [metricaResult, webmasterResult] = await Promise.all([
          check(Boolean(config.metricaToken), () =>
            metrica.listCounters({ offset: 1, per_page: 1 }),
          ),
          check(Boolean(config.webmasterToken), () => webmaster.getUser()),
        ]);
        return {
          metrica: metricaResult,
          webmaster: webmasterResult,
          ok: metricaResult.ok === true || webmasterResult.ok === true,
        };
      }, limits),
  );

  registerMetricaTools(server, metrica, config);
  registerWebmasterTools(server, webmaster, config);

  return { server, metrica, webmaster };
}

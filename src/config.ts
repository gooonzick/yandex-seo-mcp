import { z } from "zod";

const positiveInteger = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const environmentSchema = z.object({
  YANDEX_OAUTH_TOKEN: z.string().min(1).optional(),
  YANDEX_METRICA_TOKEN: z.string().min(1).optional(),
  YANDEX_WEBMASTER_TOKEN: z.string().min(1).optional(),
  YANDEX_HTTP_TIMEOUT_MS: positiveInteger(30_000),
  YANDEX_HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  YANDEX_MAX_RESULT_ROWS: positiveInteger(1_000),
  YANDEX_MAX_RESULT_BYTES: positiveInteger(500_000),
  ENABLE_WRITE_TOOLS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  MCP_HTTP_BEARER_TOKEN: z.string().min(16).optional(),
});

export interface AppConfig {
  metricaToken?: string;
  webmasterToken?: string;
  httpTimeoutMs: number;
  httpMaxRetries: number;
  maxResultRows: number;
  maxResultBytes: number;
  enableWriteTools: boolean;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  mcpBearerToken?: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const commonToken = parsed.YANDEX_OAUTH_TOKEN;

  const config: AppConfig = {
    httpTimeoutMs: parsed.YANDEX_HTTP_TIMEOUT_MS,
    httpMaxRetries: parsed.YANDEX_HTTP_MAX_RETRIES,
    maxResultRows: parsed.YANDEX_MAX_RESULT_ROWS,
    maxResultBytes: parsed.YANDEX_MAX_RESULT_BYTES,
    enableWriteTools: parsed.ENABLE_WRITE_TOOLS,
    transport: parsed.MCP_TRANSPORT,
    httpHost: parsed.MCP_HTTP_HOST,
    httpPort: parsed.MCP_HTTP_PORT,
  };
  const metricaToken = parsed.YANDEX_METRICA_TOKEN ?? commonToken;
  const webmasterToken = parsed.YANDEX_WEBMASTER_TOKEN ?? commonToken;
  if (metricaToken) config.metricaToken = metricaToken;
  if (webmasterToken) config.webmasterToken = webmasterToken;
  if (parsed.MCP_HTTP_BEARER_TOKEN) config.mcpBearerToken = parsed.MCP_HTTP_BEARER_TOKEN;
  return config;
}

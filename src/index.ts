#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { startHttpTransport } from "./transports/http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const yandexServer = createServer({ config });
  let closeTransport: () => Promise<void>;

  const shutdown = async (): Promise<void> => {
    await closeTransport();
    await yandexServer.server.close();
    process.exitCode = 0;
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (config.transport === "http") {
    const httpServer = await startHttpTransport(yandexServer, config);
    closeTransport = () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    process.stderr.write(
      `Yandex SEO MCP listening on http://${config.httpHost}:${config.httpPort}/mcp\n`,
    );
  } else {
    const transport = new StdioServerTransport();
    closeTransport = async () => transport.close();
    await yandexServer.server.connect(transport);
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof ZodError
      ? `Invalid configuration: ${error.issues.map((issue) => issue.message).join("; ")}`
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

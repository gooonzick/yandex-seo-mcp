import { serve, type HttpBindings, type ServerType } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { AppConfig } from "../config.js";
import type { YandexSeoServer } from "../server.js";

export async function startHttpTransport(
  yandexServer: YandexSeoServer,
  config: AppConfig,
): Promise<ServerType> {
  if (
    config.httpHost !== "127.0.0.1" &&
    config.httpHost !== "localhost" &&
    config.httpHost !== "::1" &&
    !config.mcpBearerToken
  ) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required when HTTP binds to a non-loopback host");
  }

  const app = new Hono<{ Bindings: HttpBindings }>();
  if (config.mcpBearerToken) {
    app.use("/mcp", bearerAuth({ token: config.mcpBearerToken }));
  }

  const transport = new StreamableHTTPServerTransport({});
  await yandexServer.server.connect(
    transport as unknown as Parameters<typeof yandexServer.server.connect>[0],
  );

  app.all("/mcp", async (context) => {
    try {
      const parsedBody =
        context.req.method === "POST" ? await context.req.json().catch(() => undefined) : undefined;
      await transport.handleRequest(context.env.incoming, context.env.outgoing, parsedBody);
      return context.body(null);
    } catch {
      if (!context.env.outgoing.headersSent) {
        return context.json(
          {
            jsonrpc: "2.0",
            error: { code: -32_603, message: "Internal server error" },
            id: null,
          },
          500,
        );
      }
      return context.body(null);
    }
  });

  app.get("/health", (context) => context.json({ status: "ok", transport: "streamable-http" }));

  const httpServer = await new Promise<ServerType>((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: config.httpHost,
        port: config.httpPort,
      },
      () => {
        server.off("error", reject);
        resolve(server);
      },
    );
    server.once("error", reject);
  });
  return httpServer;
}

import { serve, type HttpBindings, type ServerType } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { YandexOAuthManager } from "../auth/oauth.js";
import type { AppConfig } from "../config.js";
import { createServer, type YandexSeoServer } from "../server.js";
import { telemetry } from "../shared/telemetry.js";

export function createOAuthProfileConfig(config: AppConfig, accessToken: string): AppConfig {
  const profileConfig = { ...config };
  // An agency login belongs to the operator, not to arbitrary OAuth users.
  delete profileConfig.directClientLogin;
  return {
    ...profileConfig,
    metricaToken: accessToken,
    webmasterToken: accessToken,
    directToken: accessToken,
  };
}

export async function startHttpTransport(
  yandexServer: YandexSeoServer,
  config: AppConfig,
): Promise<ServerType> {
  const oauthConfigured = Boolean(
    config.oauthClientId && config.oauthRedirectUri && config.oauthStorageKey,
  );
  if (
    config.httpHost !== "127.0.0.1" &&
    config.httpHost !== "localhost" &&
    config.httpHost !== "::1" &&
    !config.mcpBearerToken &&
    !oauthConfigured
  ) {
    throw new Error(
      "MCP_HTTP_BEARER_TOKEN or Yandex OAuth PKCE is required when HTTP binds to a non-loopback host",
    );
  }

  const app = new Hono<{ Bindings: HttpBindings }>();
  const oauth = oauthConfigured ? new YandexOAuthManager(config) : undefined;
  const profileSessions = new Map<
    string,
    { server: YandexSeoServer; transport: StreamableHTTPServerTransport }
  >();
  const rateWindows = new Map<string, { startedAt: number; count: number }>();

  const transport = new StreamableHTTPServerTransport({});
  await yandexServer.server.connect(
    transport as unknown as Parameters<typeof yandexServer.server.connect>[0],
  );

  if (oauth) {
    app.get("/oauth/start", (context) => {
      const profile = context.req.query("profile");
      if (!profile || !/^[a-zA-Z0-9_.@-]{1,100}$/.test(profile))
        return context.json({ error: "A valid profile query parameter is required" }, 400);
      return context.json(oauth.createAuthorization(profile));
    });

    app.get("/oauth/callback", async (context) => {
      const state = context.req.query("state");
      const code = context.req.query("code");
      if (!state || !code) return context.json({ error: "state and code are required" }, 400);
      try {
        const result = await oauth.exchangeCallback(state, code);
        return context.json({
          status: "authorized",
          profile: result.profile,
          mcpBearerToken: result.sessionToken,
          warning: "Store this MCP bearer token securely; it is shown only once.",
        });
      } catch (error) {
        return context.json(
          { error: error instanceof Error ? error.message : "OAuth callback failed" },
          400,
        );
      }
    });
  }

  app.all("/mcp", async (context) => {
    try {
      const remoteAddress = context.env.incoming.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      const window = rateWindows.get(remoteAddress);
      const limit = config.httpRateLimitPerMinute ?? 120;
      if (!window || now - window.startedAt >= 60_000) {
        rateWindows.set(remoteAddress, { startedAt: now, count: 1 });
      } else {
        window.count += 1;
        if (window.count > limit)
          return context.json({ error: "rate_limit_exceeded" }, 429, {
            "Retry-After": "60",
          });
      }

      const authorization = context.req.header("authorization");
      const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      let selectedTransport = transport;
      if (config.mcpBearerToken || oauth) {
        if (bearer && config.mcpBearerToken && bearer === config.mcpBearerToken) {
          selectedTransport = transport;
        } else if (bearer && oauth) {
          const profile = await oauth.resolveSessionToken(bearer);
          if (!profile) {
            return context.json({ error: "invalid_token" }, 401, {
              "WWW-Authenticate": 'Bearer error="invalid_token"',
            });
          }
          const sessionKey = createHash("sha256").update(bearer).digest("hex");
          let session = profileSessions.get(sessionKey);
          if (!session) {
            const profileServer = createServer({
              config: createOAuthProfileConfig(config, profile.accessToken),
            });
            const profileTransport = new StreamableHTTPServerTransport({});
            await profileServer.server.connect(
              profileTransport as unknown as Parameters<typeof profileServer.server.connect>[0],
            );
            session = { server: profileServer, transport: profileTransport };
            profileSessions.set(sessionKey, session);
          }
          selectedTransport = session.transport;
        } else {
          return context.json({ error: "authentication_required" }, 401, {
            "WWW-Authenticate": "Bearer",
          });
        }
      }
      const parsedBody =
        context.req.method === "POST" ? await context.req.json().catch(() => undefined) : undefined;
      await selectedTransport.handleRequest(context.env.incoming, context.env.outgoing, parsedBody);
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
  app.get("/ready", (context) =>
    context.json({
      status:
        config.metricaToken || config.webmasterToken || oauthConfigured ? "ready" : "degraded",
      services: {
        metrica: Boolean(config.metricaToken),
        webmaster: Boolean(config.webmasterToken),
        multiUserOAuth: oauthConfigured,
      },
    }),
  );
  app.get("/metrics", (context) => context.json(telemetry.snapshot()));

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
  httpServer.once("close", () => {
    for (const session of profileSessions.values()) void session.server.server.close();
    profileSessions.clear();
  });
  return httpServer;
}

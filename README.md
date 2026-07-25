# Yandex SEO MCP

An MCP server for Yandex Metrica and Yandex Webmaster. It gives AI clients
typed tools for analytics reports, indexing data, search queries, sitemaps,
recrawling, and the Metrica Logs API.

## Features

- Yandex Metrica counters, goals, custom reports, trends, organic landing-page
  and search-phrase presets.
- Metrica Logs API evaluation, creation, status checks, and size-limited TSV
  downloads.
- Yandex Webmaster sites, summaries, indexing status, indexed pages, search
  queries, query/URL analytics, diagnostics, sitemaps, and recrawl requests.
- Cross-service SEO analysis for growth opportunities, content decay, and
  period-over-period Metrica comparisons.
- `stdio` transport for local MCP clients.
- Streamable HTTP transport powered by Hono.
- Write tools disabled by default.
- OAuth tokens are never accepted as tool arguments or returned in responses.
- Retries for `429` and `5xx` responses, request timeouts, Zod validation, and
  configurable result-size limits.

## Requirements

- Node.js 24.
- A Yandex OAuth application.
- `metrika:read` permission for Yandex Metrica. Request write access separately
  only if you need it.
- `webmaster:hostinfo` permission for Yandex Webmaster. Mutating operations may
  also require `webmaster:verify`.

Create a Yandex OAuth application with the minimum required permissions and
obtain a user OAuth token. Never commit tokens to Git.

## Getting Yandex OAuth tokens

This server uses user OAuth tokens: API responses contain only the counters and
sites available to the Yandex account that authorized the application.

1. Open the [Yandex OAuth application page](https://oauth.yandex.com/client/new)
   and create an application.
2. Add only the permissions you need:
   - `metrika:read` for read-only access to Yandex Metrica.
   - `webmaster:hostinfo` for read-only access to Yandex Webmaster.
   - `webmaster:verify` only if you enable Webmaster write operations.
3. Save the application and copy its client ID.
4. Open the following URL, replacing `<CLIENT_ID>` with your client ID:

   ```text
   https://oauth.yandex.com/authorize?response_type=token&client_id=<CLIENT_ID>
   ```

5. Sign in with the Yandex account that owns or can access the required Metrica
   counters and Webmaster sites, then approve the requested permissions.
6. Copy the returned access token and store it only in your local MCP client
   configuration or secret manager.

If one application has permissions for both services, configure a shared token:

```text
YANDEX_OAUTH_TOKEN=your-token
```

You can also use separate applications or tokens when the permissions differ:

```text
YANDEX_METRICA_TOKEN=metrica-token
YANDEX_WEBMASTER_TOKEN=webmaster-token
```

Service-specific tokens take precedence over `YANDEX_OAUTH_TOKEN`. If a token is
compromised, revoke it in Yandex ID and issue a new one. See the official
[Metrica authorization guide](https://yandex.ru/dev/metrika/en/intro/authorization)
and
[Webmaster OAuth guide](https://yandex.ru/dev/webmaster/doc/ru/tasks/how-to-get-oauth)
for service-specific details.

## MCP client configuration

The package can be run directly with `npx`:

```json
{
  "mcpServers": {
    "yandex-seo": {
      "command": "npx",
      "args": ["-y", "@gooonzick/yandex-seo-mcp"],
      "env": {
        "YANDEX_METRICA_TOKEN": "oauth-token",
        "YANDEX_WEBMASTER_TOKEN": "oauth-token"
      }
    }
  }
}
```

You can use `YANDEX_OAUTH_TOKEN` as a shared fallback for both services.

### Claude Code in this repository

When Claude Code is started from a clone of this repository, do not use the
`npx` configuration above in the project-level `.mcp.json`. Because the current
directory is the package itself, npm can resolve the local package without
creating its CLI link, and the MCP process exits with
`yandex-seo-mcp: command not found`. Claude Code reports that process failure as
`Failed to reconnect ... -32000: Connection closed`.

Build the local entry point first:

```bash
pnpm install
pnpm build
```

Then use the local build in `.mcp.json`:

```json
{
  "mcpServers": {
    "yandex-seo": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "YANDEX_METRICA_TOKEN": "oauth-token",
        "YANDEX_WEBMASTER_TOKEN": "oauth-token"
      }
    }
  }
}
```

Verify the connection or capture the server's stderr with:

```bash
claude mcp get yandex-seo
claude --debug-file /tmp/claude-mcp.log mcp get yandex-seo
```

To install the CLI globally instead:

```bash
npm install --global @gooonzick/yandex-seo-mcp
yandex-seo-mcp
```

## HTTP transport

The server uses `stdio` by default. To start a local Streamable HTTP server:

```bash
MCP_TRANSPORT=http npx -y @gooonzick/yandex-seo-mcp
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`. The health endpoint is
`http://127.0.0.1:3000/health`.

Binding to an address other than loopback requires an
`MCP_HTTP_BEARER_TOKEN` containing at least 16 characters:

```bash
MCP_TRANSPORT=http \
MCP_HTTP_HOST=0.0.0.0 \
MCP_HTTP_BEARER_TOKEN='replace-with-a-long-random-secret' \
npx -y @gooonzick/yandex-seo-mcp
```

For a public deployment, also use TLS, a reverse proxy, proper OAuth
authentication, encrypted token storage, and network-level access controls.

## Environment variables

| Variable                  | Default     | Description                                      |
| ------------------------- | ----------- | ------------------------------------------------ |
| `YANDEX_OAUTH_TOKEN`      | —           | Shared fallback token                            |
| `YANDEX_METRICA_TOKEN`    | —           | Yandex Metrica token                             |
| `YANDEX_WEBMASTER_TOKEN`  | —           | Yandex Webmaster token                           |
| `YANDEX_HTTP_TIMEOUT_MS`  | `30000`     | Upstream request timeout                         |
| `YANDEX_HTTP_MAX_RETRIES` | `3`         | Retry count for transient upstream errors        |
| `YANDEX_MAX_RESULT_ROWS`  | `1000`      | Maximum number of items in each result array     |
| `YANDEX_MAX_RESULT_BYTES` | `500000`    | Maximum MCP response text size                   |
| `ENABLE_WRITE_TOOLS`      | `false`     | Enable write tools that require confirmation     |
| `MCP_TRANSPORT`           | `stdio`     | Transport: `stdio` or `http`                     |
| `MCP_HTTP_HOST`           | `127.0.0.1` | HTTP bind address                                |
| `MCP_HTTP_PORT`           | `3000`      | HTTP port                                        |
| `MCP_HTTP_BEARER_TOKEN`   | —           | Bearer token required for non-loopback HTTP bind |

See [.env.example](.env.example) for a complete configuration template.

## Security

- There is no unrestricted `raw_api_request` tool.
- Both upstream API base URLs are fixed, preventing tool arguments from causing
  SSRF.
- Logs API downloads are always constrained by the MCP response-size limit.
- `metrica_logs_clean` and `webmaster_request_recrawl` are registered only when
  `ENABLE_WRITE_TOOLS=true`, and both require `confirm: true`.
- Errors return safe categories and request IDs without exposing authorization
  headers.

## Development

Install dependencies and run the complete validation suite:

```bash
pnpm install
pnpm run check
```

Run the server from source:

```bash
pnpm dev
```

Live smoke tests are opt-in and require OAuth tokens:

```bash
YANDEX_METRICA_TOKEN=... \
YANDEX_WEBMASTER_TOKEN=... \
pnpm test:live
```

API research and implementation notes:

- [Yandex Metrica API contract](docs/research/metrica-api-contract.md)
- [Yandex Webmaster API contract](docs/research/webmaster-api-contract.md)
- [MCP SDK contract](docs/research/mcp-sdk-contract.md)
- [Implementation plan](docs/plans/yandex-seo-mcp-implementation-plan.md)

## License

[MIT](LICENSE)

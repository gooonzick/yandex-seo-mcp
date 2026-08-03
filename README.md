# Yandex SEO MCP

An MCP server for Yandex Metrica and Yandex Webmaster. It gives AI clients
typed tools for analytics reports, indexing data, search queries, sitemaps,
recrawling, and the Metrica Logs API.

## Features

- Yandex Metrica counters, goal details, access grants, custom reports, trends,
  organic landing-page and search-phrase presets.
- Metrica Logs API evaluation, creation, request listing, status checks, cancellation,
  cleanup, and size-limited TSV downloads.
- Yandex Webmaster sites, ownership verification, summaries, indexing status,
  indexed pages, search queries, query/URL analytics, diagnostics, user-added
  Sitemaps, URL recrawl requests, and priority Sitemap recrawl status/actions.
- Cross-service page analysis, growth forecasting, cannibalization detection,
  content decay, period comparisons, and a compact site audit.
- Safe Metrica segment and attribution presets for devices, regions, visitor
  type, acquisition sources, search engines, ecommerce, and segment comparison.
- Persistent SEO snapshots, regression alerts, retention, and optional
  background monitoring.
- MCP resources for counters, sites, monitoring and telemetry, plus reusable
  report, incident-analysis and backlog prompts.
- `stdio` transport for local MCP clients.
- Streamable HTTP transport powered by Hono.
- Write tools always registered and protected by explicit confirmation.
- OAuth tokens are never accepted as tool arguments or returned in responses.
- Retries for `429` and `5xx`, bounded concurrency, short-lived GET caching,
  request telemetry, inbound rate limiting, Zod validation, and result limits.
- Optional multi-user Authorization Code + PKCE with encrypted token storage
  and isolated MCP bearer sessions.
- A bounded same-origin technical crawler with robots.txt and Sitemap support,
  on-page metadata checks, duplicate detection and internal-link graph analysis.
- Sitemap/crawl/Webmaster index-sample reconciliation with a prioritized recrawl
  backlog.
- Deterministic query clustering, intent classification, cluster-to-page maps,
  content-gap scoring and evidence-based content briefs.

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

The `/ready` endpoint reports deployment readiness; `/metrics` exposes
process-local request, retry, cache and latency counters.

### Multi-user OAuth with PKCE

For a remote multi-user deployment, configure:

```text
YANDEX_OAUTH_CLIENT_ID=...
YANDEX_OAUTH_CLIENT_SECRET=...
YANDEX_OAUTH_REDIRECT_URI=https://mcp.example.com/oauth/callback
YANDEX_OAUTH_STORAGE_KEY=a-long-random-secret-of-at-least-32-characters
```

Open `/oauth/start?profile=<profile-name>`, visit the returned authorization URL,
and complete the Yandex consent flow. The callback returns a one-time MCP bearer
token. Yandex access and refresh tokens are stored in an AES-256-GCM encrypted
file and each bearer token receives an isolated server/client pair. Use TLS,
restrict the callback URL, and keep both storage key and returned bearer token in
a secret manager.

### Monitoring

Snapshots can be captured with `monitor_capture_snapshot` and compared with
`monitor_check_alerts`. To schedule snapshots, provide targets and an interval:

```text
MONITOR_INTERVAL_MS=3600000
MONITOR_TARGETS_JSON=[{"name":"production","hostId":"https:example.com:443","counterId":123}]
```

`monitor_list_snapshots` accepts `limit` and an opaque `cursor`, returning
`snapshots` with `{ limit, hasMore, nextCursor }` in `pageInfo`. Cursors are bound
to the target filter; restart without a cursor after changing filters.

### Technical crawler

The crawler exposes:

- `crawler_audit_site` for HTTP, metadata, canonical, robots, hreflang,
  structured-data and duplicate checks; its result includes a stable `runId` and
  an explicit `completed` or `partial` status;
- `crawler_save_snapshot` to dry-run or persist that most recent `runId`
  idempotently (`dryRun=false` also requires `confirm=true`);
- `crawler_analyze_internal_links` for orphan, deep, weakly linked and broken
  pages;
- `crawler_reconcile_yandex_index` for Sitemap/crawl/Webmaster comparison and a
  safe recrawl backlog.

It crawls only the submitted public HTTP(S) origin, checks resolved IP addresses
before every request and redirect, respects robots rules, bounds redirects,
response bytes, depth, page count and concurrency, and never executes page
JavaScript.

Snapshots share `MONITOR_STORAGE_PATH`, are written atomically, and retain no
response body or fetch-error text. URL credentials, fragments and keys from
`CRAWLER_SNAPSHOT_QUERY_DENYLIST` are removed before persistence. Age and
per-target count limits are controlled by `CRAWLER_SNAPSHOT_RETENTION_DAYS` and
`CRAWLER_SNAPSHOT_MAX_RUNS`.

Before overwriting an existing valid storage file, the server preserves its
previous generation at `<MONITOR_STORAGE_PATH>.bak` with mode `0600`. Invalid or
unsupported storage fails closed and is never overwritten automatically. See the
[backup and recovery procedure](docs/architecture/storage-backup-and-recovery.md).

Persisted issues use a versioned stable fingerprint based on normalized URL,
category and issue code. Volatile evidence does not change identity; link issues
also include the related URL so separate broken links are not deduplicated.

The versioned crawl-history storage model and migration contract are documented
in [`docs/architecture/crawl-snapshot-storage.md`](docs/architecture/crawl-snapshot-storage.md).
The shared cursor contract is documented in
[`docs/architecture/cursor-pagination.md`](docs/architecture/cursor-pagination.md).

### Query Intelligence

The Query Intelligence layer uses Webmaster query analytics and crawler metadata
without sending search queries to external AI services:

- `query_intelligence_cluster_queries` groups related queries and classifies
  informational, commercial, transactional, navigational and local intent;
- `query_intelligence_map_pages` builds a cluster-to-page map and identifies
  semantic cannibalization;
- `query_intelligence_find_content_gaps` ranks missing, weak, conflicting and
  technically blocked coverage;
- `query_intelligence_generate_content_brief` produces a deterministic outline,
  FAQ candidates, structured-data suggestions, internal-link sources and target
  metrics.

The latest result is available through
`yandex://query-intelligence/last-analysis`. Clustering is intentionally
reproducible and lexical; editorial and live SERP validation are still required.

## Environment variables

| Variable                          | Default                    | Description                                 |
| --------------------------------- | -------------------------- | ------------------------------------------- |
| `YANDEX_OAUTH_TOKEN`              | —                          | Shared fallback token                       |
| `YANDEX_METRICA_TOKEN`            | —                          | Yandex Metrica token                        |
| `YANDEX_WEBMASTER_TOKEN`          | —                          | Yandex Webmaster token                      |
| `YANDEX_HTTP_TIMEOUT_MS`          | `30000`                    | Upstream request timeout                    |
| `YANDEX_HTTP_MAX_RETRIES`         | `3`                        | Transient-error retry count                 |
| `YANDEX_HTTP_MAX_CONCURRENCY`     | `8`                        | Maximum parallel upstream requests          |
| `YANDEX_HTTP_CACHE_TTL_MS`        | `30000`                    | Successful GET cache lifetime; `0` disables |
| `YANDEX_MAX_RESULT_ROWS`          | `1000`                     | Maximum items per result array              |
| `YANDEX_MAX_RESULT_BYTES`         | `500000`                   | Maximum MCP response text size              |
| `MONITOR_STORAGE_PATH`            | `.yandex-seo-monitor.json` | Monitoring and crawl snapshot file          |
| `MONITOR_RETENTION_DAYS`          | `90`                       | Snapshot retention                          |
| `MONITOR_INTERVAL_MS`             | `0`                        | Scheduler interval; `0` disables            |
| `MONITOR_TARGETS_JSON`            | `[]`                       | Scheduled target definitions                |
| `CRAWLER_MAX_PAGES`               | `200`                      | Hard maximum pages per crawl                |
| `CRAWLER_MAX_DEPTH`               | `5`                        | Hard maximum link depth                     |
| `CRAWLER_TIMEOUT_MS`              | `15000`                    | Per-request crawler timeout                 |
| `CRAWLER_MAX_BODY_BYTES`          | `2000000`                  | Maximum downloaded response body            |
| `CRAWLER_CONCURRENCY`             | `4`                        | Maximum parallel crawler requests           |
| `CRAWLER_DELAY_MS`                | `0`                        | Minimum delay between crawler requests      |
| `CRAWLER_USER_AGENT`              | `YandexSeoMcpBot/1.0`      | Crawler HTTP user agent                     |
| `CRAWLER_SNAPSHOT_RETENTION_DAYS` | `90`                       | Maximum crawl snapshot age                  |
| `CRAWLER_SNAPSHOT_MAX_RUNS`       | `100`                      | Maximum runs retained per target            |
| `CRAWLER_SNAPSHOT_QUERY_DENYLIST` | common secret keys         | Comma-separated URL query keys to omit      |
| `QUERY_CLUSTER_THRESHOLD`         | `0.42`                     | Minimum lexical clustering similarity       |
| `QUERY_MAX_QUERIES`               | `500`                      | Maximum Webmaster queries per analysis      |
| `MCP_TRANSPORT`                   | `stdio`                    | Transport: `stdio` or `http`                |
| `MCP_HTTP_HOST`                   | `127.0.0.1`                | HTTP bind address                           |
| `MCP_HTTP_PORT`                   | `3000`                     | HTTP port                                   |
| `MCP_HTTP_BEARER_TOKEN`           | —                          | Static HTTP bearer token                    |
| `MCP_HTTP_RATE_LIMIT_PER_MINUTE`  | `120`                      | Per-address HTTP request limit              |
| `YANDEX_OAUTH_CLIENT_ID`          | —                          | Multi-user OAuth client ID                  |
| `YANDEX_OAUTH_CLIENT_SECRET`      | —                          | OAuth confidential-client secret            |
| `YANDEX_OAUTH_REDIRECT_URI`       | —                          | Exact public callback URL                   |
| `YANDEX_OAUTH_STORAGE_KEY`        | —                          | Encryption key material, at least 32 chars  |
| `YANDEX_OAUTH_STORAGE_PATH`       | `.yandex-seo-oauth.enc`    | Encrypted OAuth profile store               |

See [.env.example](.env.example) for a complete configuration template.

## Security

- There is no unrestricted `raw_api_request` tool.
- Both upstream API base URLs are fixed, preventing tool arguments from causing
  SSRF.
- Logs API downloads are always constrained by the MCP response-size limit.
- Counter/grant management, host/verification/Sitemap management, Logs cleanup
  and cancellation, and recrawl actions require `confirm: true`.
- Errors return safe categories and request IDs without exposing authorization
  headers.
- Monitoring files use owner-only permissions; OAuth tokens are encrypted at
  rest and never returned by tools or resources.
- Crawler requests reject credentials in URLs, localhost, private/reserved IP
  ranges, mixed public/private DNS answers and unsafe redirect targets.

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

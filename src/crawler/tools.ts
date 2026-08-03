import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { YandexApiError } from "../shared/errors.js";
import { createPaginationInputSchema } from "../shared/pagination.js";
import { handleTool, type ResultLimits } from "../shared/result.js";
import { telemetry } from "../shared/telemetry.js";
import type { WebmasterClient } from "../webmaster/client.js";
import { SeoCrawler } from "./crawler.js";
import type { CrawlSnapshotStore } from "./snapshot-store.js";
import { isAllowedByRobots } from "./robots.js";
import type { CrawlLimits, CrawlResult } from "./types.js";

function crawlLimits(
  config: AppConfig,
  input: {
    maxPages?: number | undefined;
    maxDepth?: number | undefined;
    concurrency?: number | undefined;
    delayMs?: number | undefined;
  },
): CrawlLimits {
  return {
    maxPages: Math.min(
      input.maxPages ?? config.crawlerMaxPages ?? 200,
      config.crawlerMaxPages ?? 200,
    ),
    maxDepth: Math.min(input.maxDepth ?? config.crawlerMaxDepth ?? 5, config.crawlerMaxDepth ?? 5),
    timeoutMs: config.crawlerTimeoutMs ?? 15_000,
    maxBodyBytes: config.crawlerMaxBodyBytes ?? 2_000_000,
    concurrency: Math.min(
      input.concurrency ?? config.crawlerConcurrency ?? 4,
      config.crawlerConcurrency ?? 4,
    ),
    delayMs: Math.max(input.delayMs ?? config.crawlerDelayMs ?? 0, config.crawlerDelayMs ?? 0),
    userAgent: config.crawlerUserAgent ?? "YandexSeoMcpBot/1.0",
  };
}

const crawlInputSchema = z.object({
  startUrl: z.url(),
  maxPages: z.number().int().min(1).max(2_000).optional(),
  maxDepth: z.number().int().min(0).max(20).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
  delayMs: z.number().int().min(0).max(60_000).optional(),
});

const crawlSnapshotListSchema = createPaginationInputSchema(200, 50).extend({
  target: z.url().optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
});

const crawlSnapshotGetSchema = createPaginationInputSchema(200, 50).extend({
  runId: z.uuid(),
  section: z.enum(["summary", "pages", "issues", "links"]).default("summary"),
});

const crawlSnapshotCompareSchema = z.object({
  beforeRunId: z.uuid(),
  afterRunId: z.uuid(),
  exampleLimit: z.number().int().min(1).max(200).default(50),
});

function extractUrls(value: unknown): string[] {
  const urls = new Set<string>();
  const visit = (item: unknown, key = "") => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child, key);
      return;
    }
    if (!item || typeof item !== "object") {
      if (typeof item === "string" && /url/i.test(key)) {
        try {
          urls.add(new URL(item).href);
        } catch {
          // Ignore non-URL values.
        }
      }
      return;
    }
    for (const [childKey, child] of Object.entries(item as Record<string, unknown>))
      visit(child, childKey);
  };
  visit(value);
  return [...urls];
}

function normalize(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

function recommendations(result: CrawlResult) {
  const items: Array<{
    priority: "critical" | "high" | "medium";
    code: string;
    count: number;
    action: string;
  }> = [];
  const issueCount = (code: string) => result.summary.issueCounts[code] ?? 0;
  if (result.linkAnalysis.brokenInternalLinks.length > 0)
    items.push({
      priority: "critical",
      code: "FIX_BROKEN_INTERNAL_LINKS",
      count: result.linkAnalysis.brokenInternalLinks.length,
      action: "Repair or replace internal links whose crawled targets return an error.",
    });
  if (result.linkAnalysis.orphanPages.length > 0)
    items.push({
      priority: "high",
      code: "LINK_ORPHAN_PAGES",
      count: result.linkAnalysis.orphanPages.length,
      action: "Add contextual internal links to Sitemap pages with no discovered inbound links.",
    });
  const deep = result.linkAnalysis.deepestPages.filter((page) => page.depth > 3);
  if (deep.length > 0)
    items.push({
      priority: "medium",
      code: "REDUCE_CLICK_DEPTH",
      count: deep.length,
      action: "Link important deep pages from hubs or navigation to reduce click depth.",
    });
  if (issueCount("NOINDEX") > 0)
    items.push({
      priority: "high",
      code: "REVIEW_NOINDEX",
      count: issueCount("NOINDEX"),
      action: "Confirm that crawled noindex directives are intentional.",
    });
  if (issueCount("CANONICAL_MISMATCH") > 0)
    items.push({
      priority: "high",
      code: "REVIEW_CANONICALS",
      count: issueCount("CANONICAL_MISMATCH"),
      action: "Review canonicals that point away from the crawled final URL.",
    });
  return items;
}

export function registerCrawlerTools(
  server: McpServer,
  crawler: SeoCrawler,
  snapshotStore: CrawlSnapshotStore,
  webmaster: WebmasterClient,
  config: AppConfig,
): void {
  const resultLimits: ResultLimits = {
    maxRows: config.maxResultRows,
    maxBytes: config.maxResultBytes,
  };

  server.registerTool(
    "crawler_audit_site",
    {
      title: "Run a technical SEO crawl",
      description:
        "Crawl one public origin with robots/Sitemap support and audit status, metadata, canonicals, structured data and links.",
      inputSchema: crawlInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(() => crawler.crawl(input.startUrl, crawlLimits(config, input)), resultLimits),
  );

  server.registerTool(
    "crawler_save_snapshot",
    {
      title: "Save the most recent crawl snapshot",
      description:
        "Persist the completed or partial crawl identified by runId. Dry-run is the default; an actual write requires confirm=true.",
      inputSchema: z.object({
        runId: z.uuid(),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      handleTool(async () => {
        const result = crawler.getLastResult();
        if (!result || result.runId !== input.runId)
          throw new Error("The requested run is not the most recent crawl in this server process");
        if (!input.dryRun && !input.confirm)
          throw new Error("Set confirm=true to persist the crawl snapshot");
        try {
          const saved = await snapshotStore.save(result, input.dryRun);
          telemetry.event(
            input.dryRun
              ? "crawler_snapshot_dry_run"
              : saved.created
                ? "crawler_snapshot_created"
                : "crawler_snapshot_idempotent",
          );
          return saved;
        } catch (error) {
          telemetry.event("crawler_snapshot_failure");
          throw error;
        }
      }, resultLimits),
  );

  server.registerTool(
    "crawler_list_snapshots",
    {
      title: "List saved crawl snapshots",
      description:
        "Return compact crawl run summaries filtered by normalized target and inclusive ISO date range, with cursor pagination.",
      inputSchema: crawlSnapshotListSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) =>
      handleTool(async () => {
        const page = await snapshotStore.list(input);
        telemetry.event("crawler_snapshot_list");
        return { snapshots: page.items, pageInfo: page.pageInfo };
      }, resultLimits),
  );

  server.registerTool(
    "crawler_get_snapshot",
    {
      title: "Get one saved crawl snapshot",
      description:
        "Return a compact snapshot summary by default, or one cursor-paginated pages, issues or links section.",
      inputSchema: crawlSnapshotGetSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) =>
      handleTool(async () => {
        if (input.section === "summary") {
          if (input.cursor)
            throw new YandexApiError("VALIDATION", "Summary section does not accept a cursor");
          const snapshot = await snapshotStore.getSummary(input.runId);
          if (!snapshot) throw new YandexApiError("NOT_FOUND", "Crawl snapshot was not found");
          telemetry.event("crawler_snapshot_get_summary");
          return { snapshot };
        }
        const page = await snapshotStore.getSection(
          input.runId,
          input.section,
          input.cursor,
          input.limit,
        );
        if (!page) throw new YandexApiError("NOT_FOUND", "Crawl snapshot was not found");
        telemetry.event("crawler_snapshot_get_section");
        return {
          runId: input.runId,
          section: input.section,
          [input.section]: page.items,
          pageInfo: page.pageInfo,
        };
      }, resultLimits),
  );

  server.registerTool(
    "crawler_compare_snapshots",
    {
      title: "Compare two saved crawl snapshots",
      description:
        "Compare two snapshots of the same target, separating crawl configuration changes from page and stable-fingerprint issue lifecycle changes.",
      inputSchema: crawlSnapshotCompareSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) =>
      handleTool(async () => {
        const comparison = await snapshotStore.compare(
          input.beforeRunId,
          input.afterRunId,
          input.exampleLimit,
        );
        telemetry.event("crawler_snapshot_compare");
        return comparison;
      }, resultLimits),
  );

  server.registerTool(
    "crawler_reconcile_yandex_index",
    {
      title: "Reconcile Sitemap, crawl and Yandex index samples",
      description:
        "Compare Sitemap URLs with technical crawl results and Webmaster indexing samples; produce a recrawl backlog.",
      inputSchema: crawlInputSchema.extend({
        hostId: z.string().min(1).max(2_000),
        indexSampleLimit: z.number().int().min(1).max(1_000).default(1_000),
        resultLimit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const [crawl, indexing] = await Promise.all([
          crawler.crawl(input.startUrl, crawlLimits(config, input)),
          webmaster.getIndexingSamples(input.hostId, {
            offset: 0,
            limit: input.indexSampleLimit,
          }),
        ]);
        const sitemap = new Map(crawl.sitemapEntries.map((entry) => [normalize(entry.url), entry]));
        const indexed = new Set(extractUrls(indexing).map(normalize));
        const pages = new Map(
          crawl.pages.flatMap((page) => [
            [normalize(page.url), page] as const,
            [normalize(page.finalUrl), page] as const,
          ]),
        );
        const sitemapNotObservedInIndexSample = [...sitemap.keys()].filter(
          (url) => !indexed.has(url),
        );
        const indexedOutsideSitemap = [...indexed].filter((url) => !sitemap.has(url));
        const sitemapTechnicalProblems = [...sitemap.keys()].flatMap((url) => {
          const page = pages.get(url);
          const reasons: string[] = [];
          if (!isAllowedByRobots(new URL(url), crawl.robots)) reasons.push("BLOCKED_BY_ROBOTS");
          if (!page) reasons.push("NOT_CRAWLED_WITHIN_LIMIT");
          else {
            if (page.status >= 400 || page.fetchError) reasons.push("FETCH_OR_HTTP_ERROR");
            if (page.metadata?.robots.includes("noindex")) reasons.push("NOINDEX");
            if (page.issues.includes("CANONICAL_MISMATCH")) reasons.push("CANONICAL_MISMATCH");
          }
          return reasons.length > 0 ? [{ url, reasons }] : [];
        });
        const invalidLastmod = crawl.sitemapEntries
          .filter(
            (entry) =>
              entry.lastModified &&
              (Number.isNaN(Date.parse(entry.lastModified)) ||
                Date.parse(entry.lastModified) > Date.now() + 24 * 60 * 60 * 1_000),
          )
          .map((entry) => ({ url: entry.url, lastModified: entry.lastModified }));
        const recrawlBacklog = sitemapTechnicalProblems
          .filter((item) => !item.reasons.includes("BLOCKED_BY_ROBOTS"))
          .slice(0, input.resultLimit);
        return {
          caveat:
            "Webmaster indexing samples may be partial; absence from the sample is not proof that a URL is not indexed.",
          counts: {
            sitemap: sitemap.size,
            crawled: crawl.pages.length,
            indexedSample: indexed.size,
            sitemapNotObservedInIndexSample: sitemapNotObservedInIndexSample.length,
            indexedOutsideSitemap: indexedOutsideSitemap.length,
            sitemapTechnicalProblems: sitemapTechnicalProblems.length,
            invalidLastmod: invalidLastmod.length,
          },
          sitemapNotObservedInIndexSample: sitemapNotObservedInIndexSample.slice(
            0,
            input.resultLimit,
          ),
          indexedOutsideSitemap: indexedOutsideSitemap.slice(0, input.resultLimit),
          sitemapTechnicalProblems: sitemapTechnicalProblems.slice(0, input.resultLimit),
          invalidLastmod: invalidLastmod.slice(0, input.resultLimit),
          recrawlBacklog,
        };
      }, resultLimits),
  );

  server.registerTool(
    "crawler_analyze_internal_links",
    {
      title: "Analyze internal linking",
      description:
        "Find orphan, deep, weakly linked and broken pages and return a prioritized internal-linking backlog.",
      inputSchema: crawlInputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const crawl = await crawler.crawl(input.startUrl, crawlLimits(config, input));
        return {
          origin: crawl.origin,
          summary: crawl.summary,
          linkAnalysis: crawl.linkAnalysis,
          recommendations: recommendations(crawl),
        };
      }, resultLimits),
  );

  server.registerResource(
    "crawler-last-audit",
    "yandex://crawler/last-audit",
    {
      title: "Most recent technical SEO crawl",
      description: "The latest crawl result held by this server process.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(crawler.getLastResult() ?? { status: "NO_CRAWL_YET" }, null, 2),
        },
      ],
    }),
  );
}

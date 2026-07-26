import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { SeoCrawler } from "../crawler/crawler.js";
import type { CrawledPage, CrawlLimits } from "../crawler/types.js";
import { handleTool, type ResultLimits } from "../shared/result.js";
import type { WebmasterClient } from "../webmaster/client.js";
import {
  clusterQueries,
  normalizeQuery,
  querySimilarity,
  queryTokens,
  type QueryCluster,
  type QuerySignal,
  type SearchIntent,
} from "./clustering.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseQuerySignals(response: unknown): QuerySignal[] {
  const record = asRecord(response);
  const rows = Array.isArray(record?.text_indicator_to_statistics)
    ? record.text_indicator_to_statistics
    : [];
  return rows.flatMap((rawRow): QuerySignal[] => {
    const row = asRecord(rawRow);
    const primary = asRecord(row?.text_indicator);
    const complementary = asRecord(row?.popular_complementary_indicator);
    const query =
      primary?.type === "QUERY"
        ? primary.value
        : complementary?.type === "QUERY"
          ? complementary.value
          : undefined;
    if (typeof query !== "string") return [];
    const url =
      primary?.type === "URL"
        ? primary.value
        : complementary?.type === "URL"
          ? complementary.value
          : undefined;
    let impressions = 0;
    let clicks = 0;
    let demand = 0;
    const positions: number[] = [];
    for (const rawStatistic of Array.isArray(row?.statistics) ? row.statistics : []) {
      const statistic = asRecord(rawStatistic);
      const value = number(statistic?.value);
      if (value === undefined) continue;
      if (statistic?.field === "IMPRESSIONS") impressions += value;
      else if (statistic?.field === "CLICKS") clicks += value;
      else if (statistic?.field === "DEMAND") demand += value;
      else if (statistic?.field === "POSITION") positions.push(value);
    }
    return [
      {
        query,
        ...(typeof url === "string" ? { url } : {}),
        impressions,
        clicks,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        position:
          positions.length > 0
            ? positions.reduce((sum, position) => sum + position, 0) / positions.length
            : null,
        demand,
      },
    ];
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function serializeCluster(cluster: QueryCluster) {
  return {
    ...cluster,
    metrics: {
      ...cluster.metrics,
      ctr: round(cluster.metrics.ctr),
      position: cluster.metrics.position === null ? null : round(cluster.metrics.position),
    },
    queries: cluster.queries.map((query) => ({
      ...query,
      ctr: round(query.ctr),
      position: query.position === null ? null : round(query.position),
    })),
  };
}

function crawlLimits(config: AppConfig, maxPages: number, maxDepth: number): CrawlLimits {
  return {
    maxPages: Math.min(maxPages, config.crawlerMaxPages ?? 200),
    maxDepth: Math.min(maxDepth, config.crawlerMaxDepth ?? 5),
    timeoutMs: config.crawlerTimeoutMs ?? 15_000,
    maxBodyBytes: config.crawlerMaxBodyBytes ?? 2_000_000,
    concurrency: config.crawlerConcurrency ?? 4,
    delayMs: config.crawlerDelayMs ?? 0,
    userAgent: config.crawlerUserAgent ?? "YandexSeoMcpBot/1.0",
  };
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

function pageText(page: CrawledPage): string {
  return [page.metadata?.title, page.metadata?.description, ...(page.metadata?.h1 ?? [])]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function tokenCoverage(cluster: QueryCluster, page: CrawledPage): number {
  const pageTokens = new Set(queryTokens(pageText(page)));
  const relevant = cluster.tokens.slice(0, 12);
  if (relevant.length === 0) return 0;
  return relevant.filter((token) => pageTokens.has(token)).length / relevant.length;
}

function mapClusters(clusters: QueryCluster[]) {
  return clusters.map((cluster) => {
    const mappedQueries = cluster.queries.filter((query) => query.url).length;
    return {
      clusterId: cluster.id,
      label: cluster.label,
      intent: cluster.intent,
      primaryQuery: cluster.primaryQuery,
      queryCount: cluster.queries.length,
      coveragePercent: round((mappedQueries / cluster.queries.length) * 100),
      primaryPage: cluster.pages[0]?.url ?? null,
      competingPageCount: cluster.pages.length,
      cannibalization: cluster.pages.length > 1,
      pages: cluster.pages,
      metrics: {
        ...cluster.metrics,
        ctr: round(cluster.metrics.ctr),
        position: cluster.metrics.position === null ? null : round(cluster.metrics.position),
      },
    };
  });
}

async function getClusters(
  webmaster: WebmasterClient,
  input: {
    hostId: string;
    date: string;
    sourceLimit: number;
    minImpressions: number;
    similarityThreshold: number;
  },
): Promise<{ signals: QuerySignal[]; clusters: QueryCluster[] }> {
  const response = await webmaster.getQueryAnalytics(input.hostId, {
    offset: 0,
    limit: input.sourceLimit,
    device_type_indicator: "ALL",
    search_location: "WEB_LOCATION",
    text_indicator: "QUERY",
    sort_by_date: { date: input.date, statistic_field: "IMPRESSIONS", by: "DESC" },
  });
  const signals = parseQuerySignals(response).filter(
    (signal) => signal.impressions >= input.minImpressions,
  );
  return {
    signals,
    clusters: clusterQueries(signals, input.similarityThreshold),
  };
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function briefSections(intent: SearchIntent, primaryQuery: string, relatedQueries: string[]) {
  const topic = titleCase(normalizeQuery(primaryQuery));
  const common = [
    { heading: `${topic}: главное`, purpose: "Directly answer the dominant search intent." },
    {
      heading: "Ключевые характеристики и варианты",
      purpose: "Cover important cluster modifiers.",
    },
  ];
  const byIntent: Record<SearchIntent, Array<{ heading: string; purpose: string }>> = {
    informational: [
      { heading: `Что такое ${topic}`, purpose: "Give a concise definition and context." },
      { heading: `Как работает ${topic}`, purpose: "Explain the process step by step." },
      { heading: "Частые ошибки", purpose: "Address risks and misconceptions." },
    ],
    commercial: [
      { heading: "Критерии выбора", purpose: "Help compare available approaches or products." },
      { heading: "Сравнение вариантов", purpose: "Present evidence-based trade-offs." },
      { heading: "Отзывы и практические примеры", purpose: "Support the decision with proof." },
    ],
    transactional: [
      { heading: "Варианты и цены", purpose: "Answer purchase and pricing intent." },
      { heading: "Как заказать", purpose: "Make the conversion path explicit." },
      { heading: "Доставка, оплата и гарантии", purpose: "Resolve transactional objections." },
    ],
    local: [
      { heading: "Адрес и зона обслуживания", purpose: "Answer local availability intent." },
      { heading: "Как добраться", purpose: "Provide practical location details." },
      { heading: "Контакты и часы работы", purpose: "Enable a local conversion." },
    ],
    navigational: [
      { heading: "Быстрые действия", purpose: "Route users to the requested destination." },
      { heading: "Контакты и поддержка", purpose: "Resolve navigational follow-up needs." },
    ],
    mixed: common,
  };
  const questions = relatedQueries
    .filter((query) =>
      /^(?:как|что|почему|где|когда|сколько|how|what|why|where)(?:\s|$)/i.test(query),
    )
    .slice(0, 6);
  return {
    sections: [...common, ...byIntent[intent]].filter(
      (section, index, all) =>
        all.findIndex((candidate) => candidate.heading === section.heading) === index,
    ),
    faq: questions,
  };
}

export function registerQueryIntelligenceTools(
  server: McpServer,
  webmaster: WebmasterClient,
  crawler: SeoCrawler,
  config: AppConfig,
): void {
  const limits: ResultLimits = {
    maxRows: config.maxResultRows,
    maxBytes: config.maxResultBytes,
  };
  let lastAnalysis: unknown = { status: "NO_ANALYSIS_YET" };
  const commonSchema = z.object({
    hostId: z.string().min(1).max(2_000),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sourceLimit: z
      .number()
      .int()
      .min(10)
      .max(config.queryMaxQueries ?? 500)
      .default(config.queryMaxQueries ?? 500),
    resultLimit: z.number().int().min(1).max(200).default(50),
    minImpressions: z.number().nonnegative().default(10),
    similarityThreshold: z
      .number()
      .min(0.1)
      .max(1)
      .default(config.queryClusterThreshold ?? 0.42),
  });

  server.registerTool(
    "query_intelligence_cluster_queries",
    {
      title: "Cluster Yandex search queries",
      description:
        "Group Webmaster queries using reproducible lexical similarity and classify dominant search intent.",
      inputSchema: commonSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const result = await getClusters(webmaster, input);
        lastAnalysis = {
          type: "QUERY_CLUSTERS",
          date: input.date,
          sourceCount: result.signals.length,
          clusterCount: result.clusters.length,
          clusters: result.clusters.slice(0, input.resultLimit).map(serializeCluster),
        };
        return lastAnalysis;
      }, limits),
  );

  server.registerTool(
    "query_intelligence_map_pages",
    {
      title: "Map query clusters to landing pages",
      description:
        "Build a cluster-to-page map, measure mapping coverage and flag semantic cannibalization.",
      inputSchema: commonSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const result = await getClusters(webmaster, input);
        const mapped = mapClusters(result.clusters);
        lastAnalysis = {
          type: "QUERY_PAGE_MAP",
          date: input.date,
          clusterCount: mapped.length,
          mappedClusterCount: mapped.filter((cluster) => cluster.primaryPage).length,
          cannibalizedClusterCount: mapped.filter((cluster) => cluster.cannibalization).length,
          clusters: mapped.slice(0, input.resultLimit),
        };
        return lastAnalysis;
      }, limits),
  );

  server.registerTool(
    "query_intelligence_find_content_gaps",
    {
      title: "Find content gaps",
      description:
        "Compare query clusters with crawled pages and rank missing, weak, conflicting or technically blocked coverage.",
      inputSchema: commonSchema.extend({
        startUrl: z.url(),
        crawlMaxPages: z.number().int().min(1).max(2_000).default(200),
        crawlMaxDepth: z.number().int().min(0).max(20).default(5),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const [queryResult, crawl] = await Promise.all([
          getClusters(webmaster, input),
          crawler.crawl(
            input.startUrl,
            crawlLimits(config, input.crawlMaxPages, input.crawlMaxDepth),
          ),
        ]);
        const pagesByUrl = new Map(
          crawl.pages.flatMap((page) => [
            [normalizeUrl(page.url), page] as const,
            [normalizeUrl(page.finalUrl), page] as const,
          ]),
        );
        const htmlPages = crawl.pages.filter((page) => page.metadata);
        const gaps = queryResult.clusters
          .map((cluster) => {
            const observedPages = cluster.pages.flatMap((mapping) => {
              try {
                const page = pagesByUrl.get(normalizeUrl(mapping.url));
                return page ? [page] : [];
              } catch {
                return [];
              }
            });
            const bestSemanticPage = htmlPages
              .map((page) => ({ page, relevance: tokenCoverage(cluster, page) }))
              .sort((left, right) => right.relevance - left.relevance)[0];
            const primaryPage = observedPages[0] ?? bestSemanticPage?.page;
            const relevance = primaryPage ? tokenCoverage(cluster, primaryPage) : 0;
            const gapTypes: string[] = [];
            if (cluster.pages.length === 0 && relevance < 0.3) gapTypes.push("MISSING_PAGE");
            if (cluster.pages.length > 0 && observedPages.length === 0)
              gapTypes.push("MAPPED_PAGE_NOT_CRAWLED");
            if (primaryPage && relevance < 0.3) gapTypes.push("WEAK_PAGE_RELEVANCE");
            if (cluster.pages.length > 1) gapTypes.push("CANNIBALIZATION");
            if (
              primaryPage &&
              (primaryPage.status >= 400 ||
                primaryPage.metadata?.robots.includes("noindex") ||
                primaryPage.issues.includes("CANONICAL_MISMATCH"))
            )
              gapTypes.push("TECHNICAL_BLOCKER");
            const score =
              cluster.metrics.impressions *
              Math.max(0.01, 1 - cluster.metrics.ctr / 100) *
              (1 + gapTypes.length);
            return {
              clusterId: cluster.id,
              label: cluster.label,
              intent: cluster.intent,
              primaryQuery: cluster.primaryQuery,
              queryCount: cluster.queries.length,
              metrics: {
                ...cluster.metrics,
                ctr: round(cluster.metrics.ctr),
                position:
                  cluster.metrics.position === null ? null : round(cluster.metrics.position),
              },
              mappedPages: cluster.pages.map((page) => page.url),
              bestMatchingPage: primaryPage?.finalUrl ?? null,
              relevance: round(relevance * 100),
              gapTypes,
              score: round(score),
            };
          })
          .filter((gap) => gap.gapTypes.length > 0)
          .sort((left, right) => right.score - left.score);
        lastAnalysis = {
          type: "CONTENT_GAPS",
          date: input.date,
          crawlSummary: crawl.summary,
          analyzedClusters: queryResult.clusters.length,
          gapCount: gaps.length,
          gaps: gaps.slice(0, input.resultLimit),
          methodology:
            "Deterministic query clustering plus token coverage against crawled title, description and H1 fields.",
        };
        return lastAnalysis;
      }, limits),
  );

  server.registerTool(
    "query_intelligence_generate_content_brief",
    {
      title: "Generate an evidence-based content brief",
      description:
        "Create a deterministic content outline, target metrics and internal-link suggestions for the cluster nearest a seed query.",
      inputSchema: commonSchema.extend({
        seedQuery: z.string().min(2).max(500),
        startUrl: z.url().optional(),
        crawlMaxPages: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const queryResult = await getClusters(webmaster, input);
        const selected = queryResult.clusters
          .map((cluster) => ({
            cluster,
            similarity: Math.max(
              querySimilarity(input.seedQuery, cluster.primaryQuery),
              querySimilarity(input.seedQuery, cluster.label),
            ),
          }))
          .sort((left, right) => right.similarity - left.similarity)[0];
        if (!selected) return { status: "NO_MATCHING_QUERIES", seedQuery: input.seedQuery };
        const crawl = input.startUrl
          ? await crawler.crawl(
              input.startUrl,
              crawlLimits(config, input.crawlMaxPages, config.crawlerMaxDepth ?? 5),
            )
          : undefined;
        const cluster = selected.cluster;
        const structure = briefSections(
          cluster.intent,
          cluster.primaryQuery,
          cluster.queries.map((query) => query.query),
        );
        const currentPages = new Set(cluster.pages.map((page) => page.url));
        const internalLinks = (crawl?.pages ?? [])
          .filter((page) => page.metadata && !currentPages.has(page.finalUrl))
          .map((page) => ({
            url: page.finalUrl,
            title: page.metadata?.title,
            relevance: querySimilarity(cluster.primaryQuery, pageText(page)),
          }))
          .filter((page) => page.relevance >= 0.08)
          .sort((left, right) => right.relevance - left.relevance)
          .slice(0, 10)
          .map((page) => ({ ...page, relevance: round(page.relevance * 100) }));
        const targetCtr = 10;
        const projectedClicks = cluster.metrics.impressions * (targetCtr / 100);
        const topic = titleCase(normalizeQuery(cluster.primaryQuery));
        lastAnalysis = {
          type: "CONTENT_BRIEF",
          seedQuery: input.seedQuery,
          matchedCluster: {
            id: cluster.id,
            label: cluster.label,
            similarity: round(selected.similarity * 100),
            intent: cluster.intent,
            primaryQuery: cluster.primaryQuery,
            relatedQueries: cluster.queries.map((query) => query.query),
          },
          recommendedTitleVariants: [
            topic,
            cluster.intent === "transactional" || cluster.intent === "commercial"
              ? `${topic}: варианты, цены и критерии выбора`
              : `${topic}: полное руководство`,
          ],
          recommendedH1: topic,
          sections: structure.sections,
          faqQuestions: structure.faq,
          structuredDataSuggestions:
            cluster.intent === "transactional"
              ? ["Product", "Offer", "BreadcrumbList"]
              : cluster.intent === "informational"
                ? ["Article", "FAQPage", "BreadcrumbList"]
                : ["WebPage", "BreadcrumbList"],
          internalLinkSources: internalLinks,
          targetMetrics: {
            impressions: cluster.metrics.impressions,
            currentClicks: cluster.metrics.clicks,
            currentCtr: round(cluster.metrics.ctr),
            targetCtr,
            projectedClicks: round(projectedClicks),
            estimatedAdditionalClicks: round(Math.max(0, projectedClicks - cluster.metrics.clicks)),
          },
          note: "This is a deterministic evidence brief, not generated prose; editorial review and SERP validation remain required.",
        };
        return lastAnalysis;
      }, limits),
  );

  server.registerResource(
    "query-intelligence-last-analysis",
    "yandex://query-intelligence/last-analysis",
    {
      title: "Latest query intelligence analysis",
      description: "The latest clusters, page map, content gaps or content brief in this process.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(lastAnalysis, null, 2),
        },
      ],
    }),
  );
}

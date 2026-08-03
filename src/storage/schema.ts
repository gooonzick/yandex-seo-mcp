import { z } from "zod";

export const CURRENT_STORAGE_VERSION = 2 as const;
export const CRAWL_FINGERPRINT_VERSION = 2 as const;

const isoTimestamp = z.string().datetime({ offset: true });
const normalizedUrl = z.url().refine((value) => normalizeCrawlUrl(value) === value, {
  message: "URL must use the canonical crawl normalization",
});

export const monitoringSnapshotSchema = z
  .object({
    id: z.string().min(1),
    target: z.string().min(1),
    hostId: z.string().min(1),
    counterId: z.number().int().positive().optional(),
    capturedAt: isoTimestamp,
    summary: z.unknown(),
    diagnostics: z.unknown(),
    sitemaps: z.unknown(),
    organic: z
      .object({
        visits: z.number(),
        users: z.number(),
        conversionRate: z.number(),
      })
      .optional(),
    search: z
      .object({
        impressions: z.number(),
        clicks: z.number(),
        ctr: z.number(),
        position: z.number().nullable(),
      })
      .optional(),
  })
  .strict();

export type MonitoringSnapshot = z.infer<typeof monitoringSnapshotSchema>;

export const crawlRunSchema = z
  .object({
    id: z.uuid(),
    target: normalizedUrl,
    startedAt: isoTimestamp,
    finishedAt: isoTimestamp.nullable(),
    status: z.enum(["running", "completed", "partial", "failed"]),
    parameters: z
      .object({
        startUrl: normalizedUrl,
        maxPages: z.number().int().positive(),
        maxDepth: z.number().int().nonnegative(),
        timeoutMs: z.number().int().positive(),
        maxBodyBytes: z.number().int().positive(),
        concurrency: z.number().int().positive(),
        delayMs: z.number().int().nonnegative(),
        userAgent: z.string().min(1).max(200),
      })
      .strict(),
    failureCode: z.string().min(1).optional(),
  })
  .strict();

export const crawlPageSchema = z
  .object({
    runId: z.uuid(),
    url: normalizedUrl,
    finalUrl: normalizedUrl,
    depth: z.number().int().nonnegative(),
    status: z.number().int().min(0).max(599),
    contentType: z.string().nullable(),
    responseBytes: z.number().int().nonnegative(),
    indexable: z.boolean(),
    canonical: normalizedUrl.nullable(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    headings: z.array(z.string()),
  })
  .strict();

export const crawlIssueSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    pageUrl: normalizedUrl.nullable(),
    code: z.string().min(1),
    category: z.enum(["redirect", "canonical", "metadata", "indexing", "link", "crawl"]),
    severity: z.enum(["info", "warning", "error", "critical"]),
    fingerprint: z.string().min(1),
    fingerprintVersion: z.number().int().min(1).max(CRAWL_FINGERPRINT_VERSION),
    details: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const crawlLinkSchema = z
  .object({
    runId: z.uuid(),
    sourceUrl: normalizedUrl,
    targetUrl: normalizedUrl,
    kind: z.enum(["internal", "external"]),
    follow: z.boolean(),
    targetStatus: z.number().int().min(0).max(599).nullable(),
  })
  .strict();

export const crawlAggregateSchema = z
  .object({
    runId: z.uuid(),
    discovered: z.number().int().nonnegative(),
    crawled: z.number().int().nonnegative(),
    successfulHtml: z.number().int().nonnegative(),
    blockedByRobots: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    statusCounts: z.record(z.string(), z.number().int().nonnegative()),
    issueCounts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export const storageSchema = z
  .object({
    version: z.literal(CURRENT_STORAGE_VERSION),
    monitoringSnapshots: z.array(monitoringSnapshotSchema),
    crawl: z
      .object({
        runs: z.array(crawlRunSchema),
        pages: z.array(crawlPageSchema),
        issues: z.array(crawlIssueSchema),
        links: z.array(crawlLinkSchema),
        aggregates: z.array(crawlAggregateSchema),
      })
      .strict(),
  })
  .strict();

export type StorageData = z.infer<typeof storageSchema>;
export type CrawlRun = z.infer<typeof crawlRunSchema>;
export type CrawlPage = z.infer<typeof crawlPageSchema>;
export type CrawlIssue = z.infer<typeof crawlIssueSchema>;
export type CrawlLink = z.infer<typeof crawlLinkSchema>;
export type CrawlAggregate = z.infer<typeof crawlAggregateSchema>;

export function emptyStorage(): StorageData {
  return {
    version: CURRENT_STORAGE_VERSION,
    monitoringSnapshots: [],
    crawl: { runs: [], pages: [], issues: [], links: [], aggregates: [] },
  };
}

export function normalizeCrawlUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.username = "";
  url.password = "";
  url.searchParams.sort();
  return url.href;
}

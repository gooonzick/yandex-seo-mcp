import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CrawlSnapshotStore } from "../src/crawler/snapshot-store.js";
import type { CrawlResult } from "../src/crawler/types.js";

const result: CrawlResult = {
  runId: "11111111-1111-4111-8111-111111111111",
  status: "partial",
  partialReasons: ["FETCH_ERRORS"],
  startedAt: "2026-08-03T10:00:00.000Z",
  finishedAt: "2026-08-03T10:01:00.000Z",
  startUrl: "https://user:password@example.com/?page=1&token=run-secret#fragment",
  origin: "https://example.com",
  limits: {
    maxPages: 1,
    maxDepth: 2,
    timeoutMs: 1_000,
    maxBodyBytes: 100_000,
    concurrency: 1,
    delayMs: 0,
    userAgent: "test-crawler",
  },
  robots: { url: "https://example.com/robots.txt", fetched: true, sitemaps: [], rules: [] },
  sitemapEntries: [],
  pages: [
    {
      url: "https://example.com/?token=page-secret&page=1",
      finalUrl: "https://example.com/?page=1&session=session-secret",
      depth: 0,
      status: 200,
      contentType: "text/html",
      responseBytes: 250,
      redirectChain: [],
      fetchError: "must-not-be-persisted",
      metadata: {
        title: "Stored metadata title",
        description: "Stored metadata description",
        h1: ["Stored heading"],
        canonical: "https://example.com/?authorization=auth-secret&page=1",
        robots: [],
        hreflang: [],
        structuredDataTypes: [],
        internalLinks: ["https://example.com/next?api_key=key-secret&sort=asc"],
        externalLinks: ["https://external.example/path?password=password-secret&ref=site"],
      },
      issues: ["SHORT_TITLE"],
    },
  ],
  summary: {
    discovered: 2,
    crawled: 1,
    successfulHtml: 1,
    blockedByRobots: 0,
    errors: 0,
    issueCounts: { SHORT_TITLE: 1 },
  },
  linkAnalysis: {
    orphanPages: ["https://example.com/?page=1&token=orphan-secret"],
    deepestPages: [],
    lowInternalLinkPages: [],
    brokenInternalLinks: [
      {
        source: "https://example.com/?page=1&session=source-secret",
        target: "https://example.com/next?sort=asc&api_key=broken-secret",
        status: 404,
      },
    ],
  },
  duplicateGroups: { titles: [], descriptions: [] },
};

describe("CrawlSnapshotStore", () => {
  it("persists a sanitized partial audit idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-crawl-snapshot-"));
    const filePath = join(directory, "snapshots.json");
    const store = new CrawlSnapshotStore(filePath, { maxAgeDays: 90, maxRunsPerTarget: 100 });

    expect(await store.save(result)).toMatchObject({ created: true, status: "partial" });
    expect(await store.save(result)).toMatchObject({ created: false, status: "partial" });

    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw) as {
      crawl: {
        runs: Array<{ target: string; status: string; failureCode?: string }>;
        pages: Array<{ url: string; canonical: string }>;
        issues: Array<{
          code: string;
          fingerprint: string;
          fingerprintVersion: number;
          details: Record<string, unknown>;
        }>;
        links: Array<{ targetUrl: string }>;
        aggregates: Array<{ issueCounts: Record<string, number> }>;
      };
    };
    expect(data.crawl.runs).toHaveLength(1);
    expect(data.crawl.runs[0]).toMatchObject({
      target: "https://example.com/?page=1",
      status: "partial",
      failureCode: "FETCH_ERRORS",
    });
    expect(data.crawl.pages[0]).toMatchObject({
      url: "https://example.com/?page=1",
      canonical: "https://example.com/?page=1",
    });
    expect(data.crawl.issues.map(({ code }) => code)).toEqual([
      "SHORT_TITLE",
      "ORPHAN_PAGE",
      "BROKEN_INTERNAL_LINK",
    ]);
    expect(new Set(data.crawl.issues.map(({ fingerprint }) => fingerprint)).size).toBe(3);
    expect(data.crawl.issues.every(({ fingerprintVersion }) => fingerprintVersion === 2)).toBe(
      true,
    );
    expect(data.crawl.aggregates[0]?.issueCounts).toEqual({
      SHORT_TITLE: 1,
      ORPHAN_PAGE: 1,
      BROKEN_INTERNAL_LINK: 1,
    });
    expect(data.crawl.links.map(({ targetUrl }) => targetUrl)).toEqual([
      "https://example.com/next?sort=asc",
      "https://external.example/path?ref=site",
    ]);
    expect(raw).not.toMatch(
      /run-secret|page-secret|session-secret|auth-secret|key-secret|password-secret|orphan-secret|source-secret|broken-secret/,
    );
    expect(raw).not.toContain("must-not-be-persisted");
  });

  it("lists compact summaries and paginates detailed sections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-crawl-list-"));
    const store = new CrawlSnapshotStore(join(directory, "snapshots.json"), {
      maxAgeDays: 90,
      maxRunsPerTarget: 100,
    });
    const newer: CrawlResult = {
      ...structuredClone(result),
      runId: "22222222-2222-4222-8222-222222222222",
      startedAt: "2026-08-03T11:00:00.000Z",
      finishedAt: "2026-08-03T11:01:00.000Z",
    };
    await store.save(result);
    await store.save(newer);

    const first = await store.list({
      target: "https://example.com/?page=1&token=filter-secret",
      dateFrom: "2026-08-03T09:00:00.000Z",
      dateTo: "2026-08-03T12:00:00.000Z",
      limit: 1,
    });
    expect(first.items).toMatchObject([
      {
        run: { id: newer.runId },
        counts: { pages: 1, issues: 3, links: 2 },
        aggregate: { crawled: 1 },
      },
    ]);
    expect(first.pageInfo).toMatchObject({ hasMore: true });

    const second = await store.list({
      target: "https://example.com/?page=1",
      dateFrom: "2026-08-03T09:00:00.000Z",
      dateTo: "2026-08-03T12:00:00.000Z",
      cursor: first.pageInfo.nextCursor ?? undefined,
      limit: 1,
    });
    expect(second.items[0]?.run.id).toBe(result.runId);
    expect(second.pageInfo).toMatchObject({ hasMore: false, nextCursor: null });

    expect(await store.getSummary(result.runId)).toMatchObject({
      run: { id: result.runId },
      counts: { pages: 1, issues: 3, links: 2 },
    });
    const issues = await store.getSection(result.runId, "issues", undefined, 2);
    expect(issues?.items).toHaveLength(2);
    expect(issues?.pageInfo).toMatchObject({ hasMore: true });
    const remainingIssues = await store.getSection(
      result.runId,
      "issues",
      issues?.pageInfo.nextCursor ?? undefined,
      2,
    );
    expect(remainingIssues?.items).toHaveLength(1);
    expect(await store.getSummary("33333333-3333-4333-8333-333333333333")).toBeUndefined();
    await expect(
      store.list({
        dateFrom: "2026-08-04T00:00:00.000Z",
        dateTo: "2026-08-03T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toThrow(/dateFrom must not be later/);
  });

  it("compares site changes separately from crawl configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-crawl-compare-"));
    const store = new CrawlSnapshotStore(join(directory, "snapshots.json"), {
      maxAgeDays: 90,
      maxRunsPerTarget: 100,
    });
    const page = result.pages[0]!;
    const baseline: CrawlResult = {
      ...structuredClone(result),
      status: "completed",
      partialReasons: [],
      pages: [
        { ...structuredClone(page), url: "https://example.com/", finalUrl: "https://example.com/" },
        {
          ...structuredClone(page),
          url: "https://example.com/old",
          finalUrl: "https://example.com/old",
          issues: [],
        },
        {
          ...structuredClone(page),
          url: "https://example.com/recover",
          finalUrl: "https://example.com/recover",
          status: 500,
          metadata: null,
          issues: ["HTTP_500"],
        },
        {
          ...structuredClone(page),
          url: "https://example.com/stable",
          finalUrl: "https://example.com/stable",
        },
      ],
      linkAnalysis: {
        orphanPages: [],
        deepestPages: [],
        lowInternalLinkPages: [],
        brokenInternalLinks: [],
      },
    };
    const current: CrawlResult = {
      ...structuredClone(baseline),
      runId: "22222222-2222-4222-8222-222222222222",
      startedAt: "2026-08-03T11:00:00.000Z",
      finishedAt: "2026-08-03T11:01:00.000Z",
      limits: { ...baseline.limits, maxDepth: baseline.limits.maxDepth + 1 },
      pages: [
        {
          ...structuredClone(baseline.pages[0]!),
          status: 500,
          metadata: null,
        },
        {
          ...structuredClone(page),
          url: "https://example.com/recover",
          finalUrl: "https://example.com/recover",
          issues: [],
        },
        {
          ...structuredClone(baseline.pages[3]!),
          metadata: {
            ...structuredClone(baseline.pages[3]!.metadata!),
            internalLinks: [
              ...baseline.pages[3]!.metadata!.internalLinks,
              "https://example.com/added-link",
            ],
          },
        },
        {
          ...structuredClone(page),
          url: "https://example.com/new",
          finalUrl: "https://example.com/new",
          issues: ["MISSING_TITLE"],
        },
      ],
    };
    await store.save(baseline);
    await store.save(current);

    const comparison = await store.compare(baseline.runId, current.runId, 3);

    expect(comparison.configuration).toMatchObject({
      changed: true,
      changes: [{ field: "maxDepth", before: 2, after: 3 }],
    });
    expect(comparison.summary.pages).toEqual({
      new: 1,
      resolved: 1,
      worsened: 1,
      improved: 1,
      unchanged: 1,
    });
    expect(comparison.summary.pageFieldChanges).toMatchObject({
      status: 2,
      indexable: 2,
      canonical: 2,
      title: 2,
      description: 2,
      headings: 2,
      links: 3,
    });
    expect(comparison.summary.issues).toMatchObject({ new: 1, resolved: 1, unchanged: 2 });
    expect(comparison.examples.pages).toHaveLength(3);
    expect(comparison.examples.issues.length).toBeLessThanOrEqual(3);
    expect(comparison.examples.pages.map(({ state }) => state)).toEqual([
      "new",
      "resolved",
      "worsened",
    ]);
    await expect(store.compare(baseline.runId, baseline.runId, 10)).rejects.toThrow(
      /must be different/,
    );
    await expect(
      store.compare(baseline.runId, "33333333-3333-4333-8333-333333333333", 10),
    ).rejects.toThrow(/not found/);
  });
});

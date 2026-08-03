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
});

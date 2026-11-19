import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrawlSnapshotStore } from "../src/crawler/snapshot-store.js";
import type { CrawlResult } from "../src/crawler/types.js";
import { SeoChangeStore } from "../src/impact/change-store.js";

interface ResultOptions {
  runId: string;
  startedAt: string;
  finishedAt: string;
  scopedTitle: string;
  otherTitle: string;
  scopedIssues?: string[];
  otherIssues?: string[];
}

function result(options: ResultOptions): CrawlResult {
  const page = (path: string, title: string, issues: string[]) => ({
    url: `https://example.com/${path}`,
    finalUrl: `https://example.com/${path}`,
    depth: 1,
    status: 200,
    contentType: "text/html",
    responseBytes: 100,
    redirectChain: [],
    metadata: {
      title,
      description: "Description",
      h1: ["Heading"],
      canonical: `https://example.com/${path}`,
      robots: [],
      hreflang: [],
      structuredDataTypes: [],
      internalLinks: [],
      externalLinks: [],
    },
    issues,
  });
  return {
    runId: options.runId,
    status: "completed",
    partialReasons: [],
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    startUrl: "https://example.com/",
    origin: "https://example.com",
    limits: {
      maxPages: 10,
      maxDepth: 2,
      timeoutMs: 1_000,
      maxBodyBytes: 100_000,
      concurrency: 1,
      delayMs: 0,
      userAgent: "impact-test",
    },
    robots: { url: "https://example.com/robots.txt", fetched: true, sitemaps: [], rules: [] },
    sitemapEntries: [],
    pages: [
      page("scoped", options.scopedTitle, options.scopedIssues ?? []),
      page("other", options.otherTitle, options.otherIssues ?? []),
    ],
    summary: {
      discovered: 2,
      crawled: 2,
      successfulHtml: 2,
      blockedByRobots: 0,
      errors: 0,
      issueCounts: {},
    },
    linkAnalysis: {
      orphanPages: [],
      deepestPages: [],
      lowInternalLinkPages: [],
      brokenInternalLinks: [],
    },
    duplicateGroups: { titles: [], descriptions: [] },
  };
}

describe("SEO change crawl impact", () => {
  // Fixtures are dated 2026-08-03; pin the clock so retention keeps them.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the nearest crawl pair and filters by URL scope and change type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-change-impact-"));
    const filePath = join(directory, "snapshots.json");
    const snapshots = new CrawlSnapshotStore(filePath, { maxAgeDays: 90, maxRunsPerTarget: 100 });
    const changes = new SeoChangeStore(filePath);
    const runs: ResultOptions[] = [
      {
        runId: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-03T07:59:00.000Z",
        finishedAt: "2026-08-03T08:00:00.000Z",
        scopedTitle: "Older title",
        otherTitle: "Older other",
      },
      {
        runId: "22222222-2222-4222-8222-222222222222",
        startedAt: "2026-08-03T08:59:00.000Z",
        finishedAt: "2026-08-03T09:00:00.000Z",
        scopedTitle: "Before title",
        otherTitle: "Before other",
        scopedIssues: ["SHORT_TITLE"],
        otherIssues: ["SHORT_TITLE"],
      },
      {
        runId: "33333333-3333-4333-8333-333333333333",
        startedAt: "2026-08-03T10:59:00.000Z",
        finishedAt: "2026-08-03T11:00:00.000Z",
        scopedTitle: "After title",
        otherTitle: "After other",
      },
      {
        runId: "44444444-4444-4444-8444-444444444444",
        startedAt: "2026-08-03T11:59:00.000Z",
        finishedAt: "2026-08-03T12:00:00.000Z",
        scopedTitle: "Later title",
        otherTitle: "Later other",
      },
    ];
    for (const run of runs) await snapshots.save(result(run));
    const { change } = await changes.record({
      target: "https://example.com/",
      timestamp: "2026-08-03T10:00:00.000Z",
      type: "metadata",
      urlScope: ["https://example.com/scoped"],
      description: "Scoped metadata release",
      externalReference: "deploy:scoped-metadata",
    });

    const impact = await snapshots.compareForChange(change, 20);

    expect(impact).toMatchObject({
      status: "compared",
      crawlPair: { before: { runId: runs[1]!.runId }, after: { runId: runs[2]!.runId } },
      relevance: { scope: "explicit_urls" },
      comparison: {
        summary: {
          pages: { unchanged: 1 },
          issues: { resolved: 1 },
          pageFieldChanges: { title: 1 },
        },
        examples: {
          pages: [{ url: "https://example.com/scoped", changes: [{ field: "title" }] }],
          issues: [{ pageUrl: "https://example.com/scoped", category: "metadata" }],
        },
      },
    });
  });

  it("returns insufficient_data when a crawl side is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-change-impact-missing-"));
    const filePath = join(directory, "snapshots.json");
    const snapshots = new CrawlSnapshotStore(filePath, { maxAgeDays: 90, maxRunsPerTarget: 100 });
    const changes = new SeoChangeStore(filePath);
    await snapshots.save(
      result({
        runId: "55555555-5555-4555-8555-555555555555",
        startedAt: "2026-08-03T08:59:00.000Z",
        finishedAt: "2026-08-03T09:00:00.000Z",
        scopedTitle: "Before title",
        otherTitle: "Before other",
      }),
    );
    const { change } = await changes.record({
      target: "https://example.com/",
      timestamp: "2026-08-03T10:00:00.000Z",
      type: "content",
      urlScope: [],
      description: "Content release",
      externalReference: "cms:content-release",
    });

    await expect(snapshots.compareForChange(change, 20)).resolves.toMatchObject({
      status: "insufficient_data",
      crawlPair: { before: { runId: "55555555-5555-4555-8555-555555555555" }, after: null },
      missing: ["crawl_after_change"],
    });
  });
});

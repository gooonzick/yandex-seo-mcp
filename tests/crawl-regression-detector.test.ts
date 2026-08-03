import { describe, expect, it } from "vitest";
import { detectCrawlRegressions } from "../src/crawler/regression-detector.js";
import {
  emptyStorage,
  type CrawlIssue,
  type CrawlLink,
  type CrawlPage,
  type CrawlRun,
} from "../src/storage/schema.js";

const beforeRunId = "11111111-1111-4111-8111-111111111111";
const afterRunId = "22222222-2222-4222-8222-222222222222";

function run(id: string, maxDepth: number): CrawlRun {
  return {
    id,
    target: "https://example.com/",
    startedAt: id === beforeRunId ? "2026-08-03T10:00:00.000Z" : "2026-08-03T11:00:00.000Z",
    finishedAt: id === beforeRunId ? "2026-08-03T10:01:00.000Z" : "2026-08-03T11:01:00.000Z",
    status: "completed",
    parameters: {
      startUrl: "https://example.com/",
      maxPages: 100,
      maxDepth,
      timeoutMs: 1_000,
      maxBodyBytes: 100_000,
      concurrency: 1,
      delayMs: 0,
      userAgent: "test-crawler",
    },
  };
}

function page(runId: string, path: string, overrides: Partial<CrawlPage> = {}): CrawlPage {
  const url = `https://example.com/${path}`;
  return {
    runId,
    url,
    finalUrl: url,
    depth: 1,
    status: 200,
    contentType: "text/html",
    responseBytes: 100,
    indexable: true,
    canonical: url,
    title: "A sufficiently descriptive page title",
    description: "A sufficiently descriptive page description for regression tests.",
    headings: ["Heading"],
    ...overrides,
  };
}

function issue(runId: string, path: string, code: string, fingerprint: string): CrawlIssue {
  return {
    id: fingerprint.padEnd(8, "0") + "-0000-4000-8000-000000000000",
    runId,
    pageUrl: `https://example.com/${path}`,
    code,
    category: code === "NOINDEX" ? "indexing" : code === "ORPHAN_PAGE" ? "link" : "redirect",
    severity: "warning",
    fingerprint,
    fingerprintVersion: 2,
    details: {},
  };
}

function link(runId: string, source: string, target: string): CrawlLink {
  return {
    runId,
    sourceUrl: `https://example.com/${source}`,
    targetUrl: `https://example.com/${target}`,
    kind: "internal",
    follow: true,
    targetStatus: 200,
  };
}

describe("detectCrawlRegressions", () => {
  it("groups mass changes, scores incidents and applies target exclusions", () => {
    const data = emptyStorage();
    const before = run(beforeRunId, 2);
    const after = run(afterRunId, 3);
    data.crawl.runs.push(before, after);
    const paths = [
      ...Array.from({ length: 5 }, (_, index) => `server-${index}`),
      "client",
      "noindex",
      "canonical",
      "redirect",
      "orphan",
      "target",
      "source-1",
      "source-2",
    ];
    data.crawl.pages.push(...paths.map((path) => page(beforeRunId, path)));
    data.crawl.pages.push(
      ...paths.map((path) => {
        if (path.startsWith("server-"))
          return page(afterRunId, path, { status: 500, indexable: false });
        if (path === "client") return page(afterRunId, path, { status: 404, indexable: false });
        if (path === "noindex") return page(afterRunId, path, { indexable: false });
        if (path === "canonical")
          return page(afterRunId, path, { canonical: "https://example.com/preferred" });
        return page(afterRunId, path);
      }),
    );
    data.crawl.issues.push(
      issue(afterRunId, "noindex", "NOINDEX", "noindex"),
      issue(afterRunId, "redirect", "REDIRECT_CHAIN", "redirect"),
      issue(afterRunId, "orphan", "ORPHAN_PAGE", "orphan"),
    );
    data.crawl.links.push(
      link(beforeRunId, "source-1", "target"),
      link(beforeRunId, "source-2", "target"),
      link(afterRunId, "source-1", "target"),
    );

    const report = detectCrawlRegressions(data, before, after, 2, [
      {
        target: "https://example.com/",
        types: ["NEW_HTTP_4XX"],
        urlPrefixes: ["https://example.com/client"],
      },
    ]);

    expect(report.summary).toEqual({
      incidentCount: 6,
      affectedUrlCount: 10,
      excludedFindingCount: 1,
      massChangeCount: 1,
    });
    expect(report.incidents.map(({ type }) => type)).toEqual([
      "NEW_HTTP_5XX",
      "CANONICAL_DRIFT",
      "NEW_NOINDEX",
      "INTERNAL_LINK_LOSS",
      "NEW_ORPHAN_PAGE",
      "NEW_REDIRECT_CHAIN",
    ]);
    expect(report.incidents.find(({ type }) => type === "NEW_HTTP_5XX")).toMatchObject({
      severity: "critical",
      confidence: 0.9,
      massChange: true,
      affectedUrlCount: 5,
      sampleUrls: ["https://example.com/server-0", "https://example.com/server-1"],
    });
    expect(detectCrawlRegressions(data, before, after, 2, []).incidents[0]?.id).toBe(
      detectCrawlRegressions(data, before, after, 2, []).incidents[0]?.id,
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { SeoCrawler } from "../src/crawler/crawler.js";
import { parseHtml } from "../src/crawler/parser.js";
import { isAllowedByRobots, parseRobots } from "../src/crawler/robots.js";
import { isPublicAddress } from "../src/crawler/security.js";
import type { CrawlLimits } from "../src/crawler/types.js";

const limits: CrawlLimits = {
  maxPages: 10,
  maxDepth: 3,
  timeoutMs: 1_000,
  maxBodyBytes: 100_000,
  concurrency: 2,
  delayMs: 0,
  userAgent: "YandexSeoMcpBot/1.0",
};

function response(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("technical SEO crawler", () => {
  it("parses on-page metadata and structured data", () => {
    const metadata = parseHtml(
      `<!doctype html><html><head>
        <title>Example technical SEO page</title>
        <meta name="description" content="A useful page description for crawler tests and SEO metadata parsing.">
        <meta name="robots" content="index,follow">
        <link rel="canonical" href="/page">
        <link rel="alternate" hreflang="ru" href="/ru/page">
        <script type="application/ld+json">{"@type":"Article"}</script>
      </head><body><h1>Page heading</h1><a href="/about">About</a><a href="https://other.test/">External</a></body></html>`,
      "https://example.com/page",
      "https://example.com",
    );

    expect(metadata).toMatchObject({
      title: "Example technical SEO page",
      canonical: "https://example.com/page",
      h1: ["Page heading"],
      structuredDataTypes: ["Article"],
      internalLinks: ["https://example.com/about"],
      externalLinks: ["https://other.test/"],
    });
  });

  it("applies longest robots.txt rule and blocks private networks", () => {
    const robots = parseRobots(
      "User-agent: *\nDisallow: /private\nAllow: /private/public\nSitemap: /sitemap.xml",
      "https://example.com/robots.txt",
      limits.userAgent,
    );

    expect(isAllowedByRobots(new URL("https://example.com/private/a"), robots)).toBe(false);
    expect(isAllowedByRobots(new URL("https://example.com/private/public/a"), robots)).toBe(true);
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
  });

  it("crawls Sitemap pages and finds technical and link issues", async () => {
    const pages = new Map<string, Response>([
      [
        "https://example.com/robots.txt",
        response(
          "User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml",
          "text/plain",
        ),
      ],
      [
        "https://example.com/sitemap.xml",
        response(
          `<?xml version="1.0"?><urlset>
            <url><loc>https://example.com/</loc></url>
            <url><loc>https://example.com/about</loc></url>
            <url><loc>https://example.com/orphan</loc></url>
            <url><loc>https://example.com/broken</loc></url>
            <url><loc>https://example.com/private</loc></url>
          </urlset>`,
          "application/xml",
        ),
      ],
      [
        "https://example.com/",
        response(
          `<html><head><title>Home page with a descriptive title</title>
          <meta name="description" content="A long enough homepage description used by the technical crawler test suite.">
          <link rel="canonical" href="https://example.com/"></head>
          <body><h1>Home</h1><a href="/about">About</a><a href="/broken">Broken</a></body></html>`,
          "text/html",
        ),
      ],
      [
        "https://example.com/about",
        response(
          `<html><head><title>Duplicate page title for testing</title>
          <meta name="description" content="A duplicated description that is intentionally long enough for testing purposes.">
          <link rel="canonical" href="/about"></head><body><h1>About</h1><a href="/">Home</a></body></html>`,
          "text/html",
        ),
      ],
      [
        "https://example.com/orphan",
        response(
          `<html><head><title>Duplicate page title for testing</title>
          <meta name="description" content="A duplicated description that is intentionally long enough for testing purposes.">
          <link rel="canonical" href="/orphan"></head><body><h1>Orphan</h1></body></html>`,
          "text/html",
        ),
      ],
      ["https://example.com/broken", response("missing", "text/html", 404)],
    ]);
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const found = pages.get(String(input));
      return found ? found.clone() : response("not mocked", "text/plain", 404);
    });
    const crawler = new SeoCrawler({
      fetch: fetchMock as unknown as typeof fetch,
      resolveHost: async () => ["93.184.216.34"],
    });

    const result = await crawler.crawl("https://example.com/", limits);

    expect(result.summary).toMatchObject({
      crawled: 4,
      blockedByRobots: 1,
      errors: 1,
    });
    expect(result.linkAnalysis.orphanPages).toContain("https://example.com/orphan");
    expect(result.linkAnalysis.brokenInternalLinks).toContainEqual({
      source: "https://example.com/",
      target: "https://example.com/broken",
      status: 404,
    });
    expect(result.duplicateGroups.titles[0]?.urls).toHaveLength(2);
    expect(crawler.getLastResult()?.origin).toBe("https://example.com");
  });

  it("rejects a crawler target resolving to a private address", async () => {
    const crawler = new SeoCrawler({
      fetch: vi.fn() as unknown as typeof fetch,
      resolveHost: async () => ["127.0.0.1"],
    });

    await expect(crawler.crawl("http://internal.example/", limits)).rejects.toThrow(
      "private, reserved or unresolved",
    );
  });
});

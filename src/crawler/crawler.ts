import { parseHtml } from "./parser.js";
import { isAllowedByRobots, parseRobots } from "./robots.js";
import { assertSafePublicUrl, defaultHostResolver } from "./security.js";
import { decodeSitemap, parseSitemap } from "./sitemap.js";
import type {
  CrawledPage,
  CrawlLimits,
  CrawlResult,
  HostResolver,
  RobotsInfo,
  SitemapEntry,
} from "./types.js";

interface CrawlerDependencies {
  fetch?: typeof globalThis.fetch;
  resolveHost?: HostResolver;
}

interface BoundedResponse {
  status: number;
  finalUrl: string;
  contentType: string | null;
  bytes: Uint8Array;
  redirects: string[];
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  if (
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")
  )
    url.port = "";
  return url.href;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes)
    throw new Error(`Response exceeds ${maxBytes} byte crawler limit`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error(`Response exceeds ${maxBytes} byte crawler limit`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function pageIssues(page: CrawledPage): string[] {
  const issues: string[] = [];
  if (page.fetchError) issues.push("FETCH_ERROR");
  if (page.status >= 300 && page.status < 400) issues.push("REDIRECT");
  if (page.status >= 400) issues.push("HTTP_ERROR");
  if (page.redirectChain.length > 1) issues.push("REDIRECT_CHAIN");
  const metadata = page.metadata;
  if (!metadata) return issues;
  if (!metadata.title) issues.push("MISSING_TITLE");
  else if (metadata.title.length < 20) issues.push("SHORT_TITLE");
  else if (metadata.title.length > 65) issues.push("LONG_TITLE");
  if (!metadata.description) issues.push("MISSING_DESCRIPTION");
  else if (metadata.description.length < 50) issues.push("SHORT_DESCRIPTION");
  else if (metadata.description.length > 170) issues.push("LONG_DESCRIPTION");
  if (metadata.h1.length === 0) issues.push("MISSING_H1");
  if (metadata.h1.length > 1) issues.push("MULTIPLE_H1");
  if (metadata.robots.some((directive) => directive === "noindex")) issues.push("NOINDEX");
  if (!metadata.canonical) issues.push("MISSING_CANONICAL");
  else if (normalizeUrl(metadata.canonical) !== normalizeUrl(page.finalUrl))
    issues.push("CANONICAL_MISMATCH");
  if (metadata.structuredDataTypes.includes("INVALID_JSON_LD"))
    issues.push("INVALID_STRUCTURED_DATA");
  return issues;
}

function duplicateGroups(
  pages: CrawledPage[],
  field: "title" | "description",
): Array<{ value: string; urls: string[] }> {
  const grouped = new Map<string, string[]>();
  for (const page of pages) {
    const value = page.metadata?.[field];
    if (!value) continue;
    const urls = grouped.get(value) ?? [];
    urls.push(page.finalUrl);
    grouped.set(value, urls);
  }
  return [...grouped.entries()]
    .filter(([, urls]) => urls.length > 1)
    .map(([value, urls]) => ({ value, urls }))
    .sort((left, right) => right.urls.length - left.urls.length);
}

export class SeoCrawler {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly resolveHost: HostResolver;
  private recentResult?: CrawlResult;

  public constructor(dependencies: CrawlerDependencies = {}) {
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch;
    this.resolveHost = dependencies.resolveHost ?? defaultHostResolver;
  }

  public getLastResult(): CrawlResult | undefined {
    return this.recentResult ? structuredClone(this.recentResult) : undefined;
  }

  public async crawl(startUrlValue: string, limits: CrawlLimits): Promise<CrawlResult> {
    const startedAt = new Date().toISOString();
    const startUrl = new URL(startUrlValue);
    startUrl.hash = "";
    await assertSafePublicUrl(startUrl, this.resolveHost);
    const origin = startUrl.origin;
    const robots = await this.fetchRobots(origin, limits);
    const sitemapEntries = await this.fetchSitemaps(
      robots.sitemaps.length > 0 ? robots.sitemaps : [`${origin}/sitemap.xml`],
      origin,
      limits,
    );
    const queue: Array<{ url: string; depth: number }> = [
      { url: normalizeUrl(startUrl.href), depth: 0 },
    ];
    const seeded = new Set(queue.map((item) => item.url));
    for (const entry of sitemapEntries) {
      if (queue.length >= limits.maxPages) break;
      const normalized = normalizeUrl(entry.url);
      if (new URL(entry.url).origin === origin && !seeded.has(normalized)) {
        seeded.add(normalized);
        queue.push({ url: normalized, depth: 0 });
      }
    }
    const discovered = new Set(queue.map((item) => item.url));
    const pages: CrawledPage[] = [];
    let blockedByRobots = 0;
    const effectiveDelay = Math.max(limits.delayMs, robots.crawlDelayMs ?? 0);

    while (queue.length > 0 && pages.length < limits.maxPages) {
      const batch = queue.splice(
        0,
        Math.min(effectiveDelay > 0 ? 1 : limits.concurrency, limits.maxPages - pages.length),
      );
      const results = await Promise.all(
        batch.map(async (item): Promise<CrawledPage | undefined> => {
          const url = new URL(item.url);
          if (!isAllowedByRobots(url, robots)) {
            blockedByRobots += 1;
            return undefined;
          }
          if (effectiveDelay > 0) await sleep(effectiveDelay);
          return this.fetchPage(item.url, item.depth, origin, limits);
        }),
      );
      for (const page of results) {
        if (!page) continue;
        pages.push(page);
        if (!page.metadata || page.depth >= limits.maxDepth) continue;
        for (const link of page.metadata.internalLinks) {
          const normalized = normalizeUrl(link);
          if (discovered.has(normalized) || discovered.size >= limits.maxPages * 10) continue;
          discovered.add(normalized);
          queue.push({ url: normalized, depth: page.depth + 1 });
        }
      }
    }

    const statusByUrl = new Map<string, CrawledPage>();
    const inbound = new Map<string, number>();
    for (const page of pages) {
      statusByUrl.set(normalizeUrl(page.url), page);
      statusByUrl.set(normalizeUrl(page.finalUrl), page);
      for (const link of page.metadata?.internalLinks ?? []) {
        const key = normalizeUrl(link);
        inbound.set(key, (inbound.get(key) ?? 0) + 1);
      }
    }
    const brokenInternalLinks: Array<{
      source: string;
      target: string;
      status: number | null;
    }> = [];
    for (const page of pages) {
      for (const link of page.metadata?.internalLinks ?? []) {
        const target = statusByUrl.get(normalizeUrl(link));
        if (target && (target.status >= 400 || target.fetchError))
          brokenInternalLinks.push({
            source: page.finalUrl,
            target: link,
            status: target.fetchError ? null : target.status,
          });
      }
    }
    const crawledUrls = new Set(pages.map((page) => normalizeUrl(page.finalUrl)));
    const orphanPages = sitemapEntries
      .map((entry) => normalizeUrl(entry.url))
      .filter(
        (url) =>
          crawledUrls.has(url) &&
          url !== normalizeUrl(startUrl.href) &&
          (inbound.get(url) ?? 0) === 0,
      );
    const issueCounts: Record<string, number> = {};
    for (const page of pages)
      for (const issue of page.issues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    const result: CrawlResult = {
      startedAt,
      finishedAt: new Date().toISOString(),
      startUrl: normalizeUrl(startUrl.href),
      origin,
      limits,
      robots,
      sitemapEntries,
      pages,
      summary: {
        discovered: discovered.size,
        crawled: pages.length,
        successfulHtml: pages.filter(
          (page) => page.status >= 200 && page.status < 300 && page.metadata,
        ).length,
        blockedByRobots,
        errors: pages.filter((page) => page.fetchError || page.status >= 400).length,
        issueCounts,
      },
      linkAnalysis: {
        orphanPages: [...new Set(orphanPages)],
        deepestPages: pages
          .filter((page) => page.metadata)
          .map((page) => ({ url: page.finalUrl, depth: page.depth }))
          .sort((left, right) => right.depth - left.depth)
          .slice(0, 50),
        lowInternalLinkPages: pages
          .filter((page) => page.metadata)
          .map((page) => ({
            url: page.finalUrl,
            inboundLinks: inbound.get(normalizeUrl(page.finalUrl)) ?? 0,
          }))
          .filter((page) => page.inboundLinks <= 1)
          .sort((left, right) => left.inboundLinks - right.inboundLinks)
          .slice(0, 100),
        brokenInternalLinks: brokenInternalLinks.slice(0, 200),
      },
      duplicateGroups: {
        titles: duplicateGroups(pages, "title").slice(0, 50),
        descriptions: duplicateGroups(pages, "description").slice(0, 50),
      },
    };
    this.recentResult = structuredClone(result);
    return result;
  }

  private async fetchPage(
    url: string,
    depth: number,
    origin: string,
    limits: CrawlLimits,
  ): Promise<CrawledPage> {
    try {
      const response = await this.fetchBounded(url, limits, "text/html,application/xhtml+xml");
      const contentType = response.contentType?.toLowerCase() ?? "";
      const metadata =
        response.status >= 200 &&
        response.status < 300 &&
        (contentType.includes("text/html") || contentType.includes("application/xhtml+xml"))
          ? parseHtml(new TextDecoder().decode(response.bytes), response.finalUrl, origin)
          : undefined;
      const page: CrawledPage = {
        url,
        finalUrl: response.finalUrl,
        depth,
        status: response.status,
        contentType: response.contentType,
        responseBytes: response.bytes.byteLength,
        redirectChain: response.redirects,
        ...(metadata ? { metadata } : {}),
        issues: [],
      };
      page.issues = pageIssues(page);
      return page;
    } catch (error) {
      const page: CrawledPage = {
        url,
        finalUrl: url,
        depth,
        status: 0,
        contentType: null,
        responseBytes: 0,
        redirectChain: [],
        fetchError: error instanceof Error ? error.message : String(error),
        issues: [],
      };
      page.issues = pageIssues(page);
      return page;
    }
  }

  private async fetchRobots(origin: string, limits: CrawlLimits): Promise<RobotsInfo> {
    const url = `${origin}/robots.txt`;
    try {
      const response = await this.fetchBounded(url, limits, "text/plain");
      if (response.status < 200 || response.status >= 300)
        return {
          url,
          fetched: true,
          status: response.status,
          sitemaps: [],
          rules: [],
        };
      return {
        ...parseRobots(new TextDecoder().decode(response.bytes), url, limits.userAgent),
        status: response.status,
      };
    } catch (error) {
      return {
        url,
        fetched: false,
        sitemaps: [],
        rules: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async fetchSitemaps(
    seeds: string[],
    origin: string,
    limits: CrawlLimits,
  ): Promise<SitemapEntry[]> {
    const queue = [...new Set(seeds)];
    const visited = new Set<string>();
    const entries = new Map<string, SitemapEntry>();
    while (queue.length > 0 && visited.size < 20 && entries.size < limits.maxPages * 10) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        if (new URL(url).origin !== origin) continue;
        const response = await this.fetchBounded(url, limits, "application/xml,text/xml");
        if (response.status < 200 || response.status >= 300) continue;
        const parsed = parseSitemap(decodeSitemap(response.bytes), url);
        for (const entry of parsed.entries) {
          if (new URL(entry.url).origin === origin) entries.set(normalizeUrl(entry.url), entry);
        }
        for (const child of parsed.childSitemaps) if (!visited.has(child)) queue.push(child);
      } catch {
        // Missing or malformed Sitemaps are reported through reconciliation counts.
      }
    }
    return [...entries.values()];
  }

  private async fetchBounded(
    initialUrl: string,
    limits: CrawlLimits,
    accept: string,
  ): Promise<BoundedResponse> {
    let current = new URL(initialUrl);
    const redirects: string[] = [];
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      await assertSafePublicUrl(current, this.resolveHost);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
      try {
        const response = await this.fetchImplementation(current, {
          redirect: "manual",
          headers: { "User-Agent": limits.userAgent, Accept: accept },
          signal: controller.signal,
        });
        redirects.push(current.href);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new Error(`Redirect ${response.status} has no Location header`);
          current = new URL(location, current);
          continue;
        }
        return {
          status: response.status,
          finalUrl: current.href,
          contentType: response.headers.get("content-type"),
          bytes: await readBounded(response, limits.maxBodyBytes),
          redirects,
        };
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("Crawler redirect limit exceeded");
  }
}

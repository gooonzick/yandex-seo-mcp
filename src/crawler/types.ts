export interface CrawlLimits {
  maxPages: number;
  maxDepth: number;
  timeoutMs: number;
  maxBodyBytes: number;
  concurrency: number;
  delayMs: number;
  userAgent: string;
}

export interface PageMetadata {
  title: string | null;
  description: string | null;
  h1: string[];
  canonical: string | null;
  robots: string[];
  hreflang: Array<{ language: string; url: string }>;
  structuredDataTypes: string[];
  internalLinks: string[];
  externalLinks: string[];
}

export interface CrawledPage {
  url: string;
  finalUrl: string;
  depth: number;
  status: number;
  contentType: string | null;
  responseBytes: number;
  redirectChain: string[];
  metadata?: PageMetadata;
  fetchError?: string;
  issues: string[];
}

export interface RobotsInfo {
  url: string;
  fetched: boolean;
  status?: number;
  sitemaps: string[];
  crawlDelayMs?: number;
  rules: Array<{ allow: boolean; path: string }>;
  error?: string;
}

export interface SitemapEntry {
  url: string;
  lastModified?: string;
  source: string;
}

export interface CrawlResult {
  startedAt: string;
  finishedAt: string;
  startUrl: string;
  origin: string;
  limits: CrawlLimits;
  robots: RobotsInfo;
  sitemapEntries: SitemapEntry[];
  pages: CrawledPage[];
  summary: {
    discovered: number;
    crawled: number;
    successfulHtml: number;
    blockedByRobots: number;
    errors: number;
    issueCounts: Record<string, number>;
  };
  linkAnalysis: {
    orphanPages: string[];
    deepestPages: Array<{ url: string; depth: number }>;
    lowInternalLinkPages: Array<{ url: string; inboundLinks: number }>;
    brokenInternalLinks: Array<{ source: string; target: string; status: number | null }>;
  };
  duplicateGroups: {
    titles: Array<{ value: string; urls: string[] }>;
    descriptions: Array<{ value: string; urls: string[] }>;
  };
}

export type HostResolver = (hostname: string) => Promise<string[]>;

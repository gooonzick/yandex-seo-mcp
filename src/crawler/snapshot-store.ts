import { createHash, randomUUID } from "node:crypto";
import { StorageFile } from "../storage/file-store.js";
import { pruneCrawlHistory, type CrawlRetentionPolicy } from "../storage/retention.js";
import {
  CRAWL_FINGERPRINT_VERSION,
  normalizeCrawlUrl,
  type CrawlAggregate,
  type CrawlIssue,
  type CrawlLink,
  type CrawlPage,
  type CrawlRun,
  type StorageData,
} from "../storage/schema.js";
import type { CrawledPage, CrawlResult } from "./types.js";

export const DEFAULT_QUERY_PARAMETER_DENYLIST = [
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "code",
  "credential",
  "key",
  "password",
  "secret",
  "session",
  "sessionid",
  "sid",
  "token",
] as const;

export interface SaveSnapshotResult {
  runId: string;
  created: boolean;
  dryRun: boolean;
  status: CrawlRun["status"];
  counts: { pages: number; issues: number; links: number };
}

function sanitizeUrl(value: string, denylist: ReadonlySet<string>): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (denylist.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return normalizeCrawlUrl(url.href);
}

function issueCategory(code: string): CrawlIssue["category"] {
  if (code.includes("REDIRECT")) return "redirect";
  if (code.includes("CANONICAL")) return "canonical";
  if (code.includes("TITLE") || code.includes("DESCRIPTION") || code.includes("H1"))
    return "metadata";
  if (code === "NOINDEX") return "indexing";
  if (code.includes("LINK") || code === "ORPHAN_PAGE") return "link";
  return "crawl";
}

function issueSeverity(code: string): CrawlIssue["severity"] {
  if (code === "FETCH_ERROR" || code === "HTTP_ERROR") return "error";
  if (code === "REDIRECT_CHAIN" || code === "CANONICAL_MISMATCH" || code === "NOINDEX")
    return "warning";
  return "info";
}

function issueFingerprint(pageUrl: string | null, code: string): string {
  return createHash("sha256")
    .update(`${CRAWL_FINGERPRINT_VERSION}\0${pageUrl ?? "target"}\0${code}`)
    .digest("hex");
}

function pageRecord(runId: string, page: CrawledPage, denylist: ReadonlySet<string>): CrawlPage {
  const finalUrl = sanitizeUrl(page.finalUrl, denylist);
  return {
    runId,
    url: sanitizeUrl(page.url, denylist),
    finalUrl,
    depth: page.depth,
    status: page.status,
    contentType: page.contentType,
    responseBytes: page.responseBytes,
    indexable:
      page.status >= 200 &&
      page.status < 300 &&
      Boolean(page.metadata) &&
      !page.metadata?.robots.includes("noindex"),
    canonical: page.metadata?.canonical ? sanitizeUrl(page.metadata.canonical, denylist) : null,
    title: page.metadata?.title ?? null,
    description: page.metadata?.description ?? null,
    headings: page.metadata?.h1 ?? [],
  };
}

function buildSnapshot(
  result: CrawlResult,
  denylistValues: readonly string[],
): {
  run: CrawlRun;
  pages: CrawlPage[];
  issues: CrawlIssue[];
  links: CrawlLink[];
  aggregate: CrawlAggregate;
} {
  const denylist = new Set(denylistValues.map((key) => key.trim().toLowerCase()).filter(Boolean));
  const pages = result.pages.map((page) => pageRecord(result.runId, page, denylist));
  const statusByUrl = new Map<string, number>();
  for (const page of pages) {
    statusByUrl.set(page.url, page.status);
    statusByUrl.set(page.finalUrl, page.status);
  }
  const issues = result.pages.flatMap((page) => {
    const pageUrl = sanitizeUrl(page.finalUrl, denylist);
    return page.issues.map((code): CrawlIssue => ({
      id: randomUUID(),
      runId: result.runId,
      pageUrl,
      code,
      category: issueCategory(code),
      severity: issueSeverity(code),
      fingerprint: issueFingerprint(pageUrl, code),
      fingerprintVersion: CRAWL_FINGERPRINT_VERSION,
      details: {},
    }));
  });
  const linkKeys = new Set<string>();
  const links: CrawlLink[] = [];
  for (const page of result.pages) {
    const sourceUrl = sanitizeUrl(page.finalUrl, denylist);
    const addLinks = (values: string[], kind: CrawlLink["kind"]) => {
      for (const value of values) {
        const targetUrl = sanitizeUrl(value, denylist);
        const key = `${sourceUrl}\0${targetUrl}\0${kind}`;
        if (linkKeys.has(key)) continue;
        linkKeys.add(key);
        links.push({
          runId: result.runId,
          sourceUrl,
          targetUrl,
          kind,
          follow: true,
          targetStatus: kind === "internal" ? (statusByUrl.get(targetUrl) ?? null) : null,
        });
      }
    };
    addLinks(page.metadata?.internalLinks ?? [], "internal");
    addLinks(page.metadata?.externalLinks ?? [], "external");
  }
  const statusCounts: Record<string, number> = {};
  for (const page of pages) {
    const key = String(page.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  return {
    run: {
      id: result.runId,
      target: sanitizeUrl(result.startUrl, denylist),
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      status: result.status,
      parameters: {
        startUrl: sanitizeUrl(result.startUrl, denylist),
        ...result.limits,
      },
      ...(result.status === "partial"
        ? { failureCode: result.partialReasons.join(",") || "INCOMPLETE_CRAWL" }
        : {}),
    },
    pages,
    issues,
    links,
    aggregate: { runId: result.runId, ...result.summary, statusCounts },
  };
}

export class CrawlSnapshotStore {
  private readonly storage: StorageFile;

  public constructor(
    filePath: string,
    private readonly retention: CrawlRetentionPolicy,
    private readonly queryParameterDenylist: readonly string[] = DEFAULT_QUERY_PARAMETER_DENYLIST,
  ) {
    this.storage = new StorageFile(filePath);
  }

  public async save(result: CrawlResult, dryRun = false): Promise<SaveSnapshotResult> {
    const snapshot = buildSnapshot(result, this.queryParameterDenylist);
    const response = (created: boolean): SaveSnapshotResult => ({
      runId: result.runId,
      created,
      dryRun,
      status: snapshot.run.status,
      counts: {
        pages: snapshot.pages.length,
        issues: snapshot.issues.length,
        links: snapshot.links.length,
      },
    });
    if (dryRun) {
      const data = await this.storage.read();
      return response(!data.crawl.runs.some((run) => run.id === result.runId));
    }
    let created = false;
    await this.storage.update((data): StorageData => {
      if (data.crawl.runs.some((run) => run.id === result.runId)) return data;
      created = true;
      data.crawl.runs.push(snapshot.run);
      data.crawl.pages.push(...snapshot.pages);
      data.crawl.issues.push(...snapshot.issues);
      data.crawl.links.push(...snapshot.links);
      data.crawl.aggregates.push(snapshot.aggregate);
      return pruneCrawlHistory(data, this.retention);
    });
    return response(created);
  }
}

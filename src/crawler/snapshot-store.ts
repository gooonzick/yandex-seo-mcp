import { randomUUID } from "node:crypto";
import { StorageFile } from "../storage/file-store.js";
import { pruneCrawlHistory, type CrawlRetentionPolicy } from "../storage/retention.js";
import { YandexApiError } from "../shared/errors.js";
import {
  createPaginationScope,
  mapCursorPage,
  paginateByKey,
  type CursorPage,
} from "../shared/pagination.js";
import {
  normalizeCrawlUrl,
  type CrawlAggregate,
  type CrawlIssue,
  type CrawlLink,
  type CrawlPage,
  type CrawlRun,
  type StorageData,
} from "../storage/schema.js";
import type { CrawledPage, CrawlResult } from "./types.js";
import { createCrawlIssueFingerprint } from "./issue-fingerprint.js";
import { compareCrawlSnapshots, type CrawlSnapshotComparison } from "./snapshot-compare.js";

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

export interface CrawlSnapshotSummary {
  run: CrawlRun;
  aggregate: CrawlAggregate | null;
  counts: { pages: number; issues: number; links: number };
}

export interface ListCrawlSnapshotsOptions {
  target?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export type CrawlSnapshotSection = "pages" | "issues" | "links";
export type CrawlSnapshotSectionRecord = CrawlPage | CrawlIssue | CrawlLink;

function sanitizeUrl(value: string, denylist: ReadonlySet<string>): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (denylist.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return normalizeCrawlUrl(url.href);
}

function normalizeDateFilter(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp))
    throw new YandexApiError("VALIDATION", `${name} must be an ISO date`);
  return new Date(timestamp).toISOString();
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
  if (code === "FETCH_ERROR" || code === "HTTP_ERROR" || code === "BROKEN_INTERNAL_LINK")
    return "error";
  if (
    code === "REDIRECT_CHAIN" ||
    code === "CANONICAL_MISMATCH" ||
    code === "NOINDEX" ||
    code === "ORPHAN_PAGE"
  )
    return "warning";
  return "info";
}

function issueRecord(
  runId: string,
  targetUrl: string,
  pageUrl: string | null,
  code: string,
  details: Record<string, unknown> = {},
  relatedUrl?: string,
): CrawlIssue {
  const category = issueCategory(code);
  return {
    id: randomUUID(),
    runId,
    pageUrl,
    code,
    category,
    severity: issueSeverity(code),
    ...createCrawlIssueFingerprint({
      targetUrl,
      pageUrl,
      code,
      category,
      ...(relatedUrl ? { relatedUrl } : {}),
      details,
    }),
    details,
  };
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
  const targetUrl = sanitizeUrl(result.startUrl, denylist);
  const pages = result.pages.map((page) => pageRecord(result.runId, page, denylist));
  const statusByUrl = new Map<string, number>();
  for (const page of pages) {
    statusByUrl.set(page.url, page.status);
    statusByUrl.set(page.finalUrl, page.status);
  }
  const pageIssues = result.pages.flatMap((page) => {
    const pageUrl = sanitizeUrl(page.finalUrl, denylist);
    return page.issues.map((code) => issueRecord(result.runId, targetUrl, pageUrl, code));
  });
  const derivedLinkIssues = [
    ...result.linkAnalysis.orphanPages.map((url) => {
      const pageUrl = sanitizeUrl(url, denylist);
      return issueRecord(result.runId, targetUrl, pageUrl, "ORPHAN_PAGE");
    }),
    ...result.linkAnalysis.brokenInternalLinks.map((link) => {
      const pageUrl = sanitizeUrl(link.source, denylist);
      const relatedUrl = sanitizeUrl(link.target, denylist);
      return issueRecord(
        result.runId,
        targetUrl,
        pageUrl,
        "BROKEN_INTERNAL_LINK",
        { relatedUrl, targetStatus: link.status },
        relatedUrl,
      );
    }),
  ];
  const issues = [
    ...new Map(
      [...pageIssues, ...derivedLinkIssues].map((issue) => [issue.fingerprint, issue]),
    ).values(),
  ];
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
  const issueCounts: Record<string, number> = {};
  for (const issue of issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
  return {
    run: {
      id: result.runId,
      target: targetUrl,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      status: result.status,
      parameters: {
        startUrl: targetUrl,
        ...result.limits,
      },
      ...(result.status === "partial"
        ? { failureCode: result.partialReasons.join(",") || "INCOMPLETE_CRAWL" }
        : {}),
    },
    pages,
    issues,
    links,
    aggregate: { runId: result.runId, ...result.summary, statusCounts, issueCounts },
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

  public async list(options: ListCrawlSnapshotsOptions): Promise<CursorPage<CrawlSnapshotSummary>> {
    const data = pruneCrawlHistory(await this.storage.read(), this.retention);
    const denylist = new Set(
      this.queryParameterDenylist.map((key) => key.trim().toLowerCase()).filter(Boolean),
    );
    const target = options.target ? sanitizeUrl(options.target, denylist) : undefined;
    const dateFrom = normalizeDateFilter(options.dateFrom, "dateFrom");
    const dateTo = normalizeDateFilter(options.dateTo, "dateTo");
    if (dateFrom && dateTo && dateFrom > dateTo)
      throw new YandexApiError("VALIDATION", "dateFrom must not be later than dateTo");
    const runs = data.crawl.runs.filter((run) => {
      const timestamp = run.finishedAt ?? run.startedAt;
      return (
        (!target || run.target === target) &&
        (!dateFrom || timestamp >= dateFrom) &&
        (!dateTo || timestamp <= dateTo)
      );
    });
    return mapCursorPage(
      paginateByKey(runs, {
        scope: createPaginationScope("crawl-snapshots", { target, dateFrom, dateTo }),
        cursor: options.cursor,
        limit: options.limit,
        order: "desc",
        getKey: (run) => `${run.finishedAt ?? run.startedAt}\0${run.id}`,
      }),
      (run) => this.summary(data, run),
    );
  }

  public async getSummary(runId: string): Promise<CrawlSnapshotSummary | undefined> {
    const data = pruneCrawlHistory(await this.storage.read(), this.retention);
    const run = data.crawl.runs.find((candidate) => candidate.id === runId);
    return run ? this.summary(data, run) : undefined;
  }

  public async getSection(
    runId: string,
    section: CrawlSnapshotSection,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<CrawlSnapshotSectionRecord> | undefined> {
    const data = pruneCrawlHistory(await this.storage.read(), this.retention);
    if (!data.crawl.runs.some((run) => run.id === runId)) return undefined;
    const records = data.crawl[section].filter((record) => record.runId === runId);
    const getKey = (record: CrawlSnapshotSectionRecord): string => {
      if ("url" in record) return `${record.url}\0${record.finalUrl}`;
      if ("id" in record) return `${record.pageUrl ?? ""}\0${record.code}\0${record.id}`;
      return `${record.sourceUrl}\0${record.targetUrl}\0${record.kind}`;
    };
    return paginateByKey(records, {
      scope: createPaginationScope("crawl-snapshot-section", { runId, section }),
      cursor,
      limit,
      order: "asc",
      getKey,
    });
  }

  public async compare(
    beforeRunId: string,
    afterRunId: string,
    exampleLimit: number,
  ): Promise<CrawlSnapshotComparison> {
    if (beforeRunId === afterRunId)
      throw new YandexApiError("VALIDATION", "beforeRunId and afterRunId must be different");
    const data = pruneCrawlHistory(await this.storage.read(), this.retention);
    const beforeRun = data.crawl.runs.find(({ id }) => id === beforeRunId);
    const afterRun = data.crawl.runs.find(({ id }) => id === afterRunId);
    if (!beforeRun || !afterRun)
      throw new YandexApiError("NOT_FOUND", "One or both crawl snapshots were not found");
    if (beforeRun.target !== afterRun.target)
      throw new YandexApiError("VALIDATION", "Crawl snapshots must have the same target");
    return compareCrawlSnapshots(data, beforeRun, afterRun, exampleLimit);
  }

  private summary(data: StorageData, run: CrawlRun): CrawlSnapshotSummary {
    return {
      run: structuredClone(run),
      aggregate:
        structuredClone(data.crawl.aggregates.find((record) => record.runId === run.id)) ?? null,
      counts: {
        pages: data.crawl.pages.filter((record) => record.runId === run.id).length,
        issues: data.crawl.issues.filter((record) => record.runId === run.id).length,
        links: data.crawl.links.filter((record) => record.runId === run.id).length,
      },
    };
  }
}

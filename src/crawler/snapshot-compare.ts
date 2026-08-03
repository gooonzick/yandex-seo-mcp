import type { CrawlIssue, CrawlLink, CrawlPage, CrawlRun, StorageData } from "../storage/schema.js";

export type CrawlDiffState = "new" | "resolved" | "worsened" | "improved" | "unchanged";

export interface CrawlValueChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface CrawlPageDiff {
  url: string;
  state: CrawlDiffState;
  healthScore: { before: number | null; after: number | null };
  changes: CrawlValueChange[];
}

export interface CrawlIssueDiff {
  fingerprint: string;
  fingerprintVersion: number;
  code: string;
  pageUrl: string | null;
  state: CrawlDiffState;
  severity: { before: CrawlIssue["severity"] | null; after: CrawlIssue["severity"] | null };
}

export interface CrawlSnapshotComparison {
  before: { runId: string; target: string; capturedAt: string };
  after: { runId: string; target: string; capturedAt: string };
  configuration: { changed: boolean; changes: CrawlValueChange[] };
  summary: {
    pages: Record<CrawlDiffState, number>;
    issues: Record<CrawlDiffState, number>;
    pageFieldChanges: Record<string, number>;
  };
  examples: { limit: number; pages: CrawlPageDiff[]; issues: CrawlIssueDiff[] };
}

const states: readonly CrawlDiffState[] = ["new", "resolved", "worsened", "improved", "unchanged"];

function stateCounts(): Record<CrawlDiffState, number> {
  return { new: 0, resolved: 0, worsened: 0, improved: 0, unchanged: 0 };
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function linkValue(link: CrawlLink): string {
  return `${link.kind}\0${link.follow ? "follow" : "nofollow"}\0${link.targetUrl}\0${link.targetStatus ?? "unknown"}`;
}

function pageLinks(data: StorageData, runId: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const link of data.crawl.links) {
    if (link.runId !== runId) continue;
    const values = result.get(link.sourceUrl) ?? [];
    values.push(linkValue(link));
    result.set(link.sourceUrl, values);
  }
  for (const values of result.values()) values.sort();
  return result;
}

function pageHealth(page: CrawlPage, links: readonly string[]): number {
  let score = 0;
  if (page.status < 200 || page.status >= 500) score += 4;
  else if (page.status >= 400) score += 3;
  else if (page.status >= 300) score += 1;
  if (!page.indexable) score += 2;
  if (page.canonical && page.canonical !== page.finalUrl) score += 1;
  if (!page.title?.trim()) score += 1;
  if (!page.description?.trim()) score += 1;
  if (page.headings.length === 0) score += 1;
  score += links.filter((value) => /\0(?:4\d\d|5\d\d)$/.test(value)).length;
  return score;
}

function pageChanges(
  before: CrawlPage,
  after: CrawlPage,
  beforeLinks: readonly string[],
  afterLinks: readonly string[],
): CrawlValueChange[] {
  const pairs: Array<[string, unknown, unknown]> = [
    ["status", before.status, after.status],
    ["indexable", before.indexable, after.indexable],
    ["canonical", before.canonical, after.canonical],
    ["title", before.title, after.title],
    ["description", before.description, after.description],
    ["headings", before.headings, after.headings],
    ["links", beforeLinks, afterLinks],
  ];
  return pairs
    .filter(([, left, right]) => !equal(left, right))
    .map(([field, left, right]) => ({ field, before: left, after: right }));
}

function comparePages(data: StorageData, beforeRun: CrawlRun, afterRun: CrawlRun): CrawlPageDiff[] {
  const beforePages = new Map(
    data.crawl.pages.filter(({ runId }) => runId === beforeRun.id).map((page) => [page.url, page]),
  );
  const afterPages = new Map(
    data.crawl.pages.filter(({ runId }) => runId === afterRun.id).map((page) => [page.url, page]),
  );
  const beforeLinks = pageLinks(data, beforeRun.id);
  const afterLinks = pageLinks(data, afterRun.id);
  const urls = [...new Set([...beforePages.keys(), ...afterPages.keys()])].sort();
  return urls.map((url): CrawlPageDiff => {
    const before = beforePages.get(url);
    const after = afterPages.get(url);
    if (!before)
      return {
        url,
        state: "new",
        healthScore: {
          before: null,
          after: pageHealth(after!, afterLinks.get(after!.finalUrl) ?? []),
        },
        changes: [],
      };
    if (!after)
      return {
        url,
        state: "resolved",
        healthScore: {
          before: pageHealth(before, beforeLinks.get(before.finalUrl) ?? []),
          after: null,
        },
        changes: [],
      };
    const previousLinks = beforeLinks.get(before.finalUrl) ?? [];
    const currentLinks = afterLinks.get(after.finalUrl) ?? [];
    const previousScore = pageHealth(before, previousLinks);
    const currentScore = pageHealth(after, currentLinks);
    return {
      url,
      state:
        currentScore > previousScore
          ? "worsened"
          : currentScore < previousScore
            ? "improved"
            : "unchanged",
      healthScore: { before: previousScore, after: currentScore },
      changes: pageChanges(before, after, previousLinks, currentLinks),
    };
  });
}

function severityRank(severity: CrawlIssue["severity"]): number {
  return { info: 0, warning: 1, error: 2, critical: 3 }[severity];
}

function issueKey(issue: CrawlIssue): string {
  return `${issue.fingerprintVersion}\0${issue.fingerprint}`;
}

function compareIssues(
  data: StorageData,
  beforeRun: CrawlRun,
  afterRun: CrawlRun,
): CrawlIssueDiff[] {
  const beforeIssues = new Map(
    data.crawl.issues
      .filter(({ runId }) => runId === beforeRun.id)
      .map((issue) => [issueKey(issue), issue]),
  );
  const afterIssues = new Map(
    data.crawl.issues
      .filter(({ runId }) => runId === afterRun.id)
      .map((issue) => [issueKey(issue), issue]),
  );
  const keys = [...new Set([...beforeIssues.keys(), ...afterIssues.keys()])].sort();
  return keys.map((key): CrawlIssueDiff => {
    const before = beforeIssues.get(key);
    const after = afterIssues.get(key);
    const issue = after ?? before!;
    let state: CrawlDiffState;
    if (!before) state = "new";
    else if (!after) state = "resolved";
    else if (severityRank(after.severity) > severityRank(before.severity)) state = "worsened";
    else if (severityRank(after.severity) < severityRank(before.severity)) state = "improved";
    else state = "unchanged";
    return {
      fingerprint: issue.fingerprint,
      fingerprintVersion: issue.fingerprintVersion,
      code: issue.code,
      pageUrl: issue.pageUrl,
      state,
      severity: { before: before?.severity ?? null, after: after?.severity ?? null },
    };
  });
}

function configurationChanges(before: CrawlRun, after: CrawlRun): CrawlValueChange[] {
  return Object.keys(before.parameters)
    .sort()
    .filter((field) => {
      const key = field as keyof CrawlRun["parameters"];
      return !equal(before.parameters[key], after.parameters[key]);
    })
    .map((field) => {
      const key = field as keyof CrawlRun["parameters"];
      return { field, before: before.parameters[key], after: after.parameters[key] };
    });
}

function prioritize<T extends { state: CrawlDiffState }>(items: readonly T[]): T[] {
  const rank = new Map(states.map((state, index) => [state, index]));
  return [...items].sort(
    (left, right) => (rank.get(left.state) ?? 99) - (rank.get(right.state) ?? 99),
  );
}

export function compareCrawlSnapshots(
  data: StorageData,
  beforeRun: CrawlRun,
  afterRun: CrawlRun,
  exampleLimit: number,
): CrawlSnapshotComparison {
  const pages = comparePages(data, beforeRun, afterRun);
  const issues = compareIssues(data, beforeRun, afterRun);
  const pageStates = stateCounts();
  const issueStates = stateCounts();
  const pageFieldChanges: Record<string, number> = {};
  for (const page of pages) {
    pageStates[page.state] += 1;
    for (const change of page.changes)
      pageFieldChanges[change.field] = (pageFieldChanges[change.field] ?? 0) + 1;
  }
  for (const issue of issues) issueStates[issue.state] += 1;
  const configuration = configurationChanges(beforeRun, afterRun);
  return {
    before: {
      runId: beforeRun.id,
      target: beforeRun.target,
      capturedAt: beforeRun.finishedAt ?? beforeRun.startedAt,
    },
    after: {
      runId: afterRun.id,
      target: afterRun.target,
      capturedAt: afterRun.finishedAt ?? afterRun.startedAt,
    },
    configuration: { changed: configuration.length > 0, changes: configuration },
    summary: { pages: pageStates, issues: issueStates, pageFieldChanges },
    examples: {
      limit: exampleLimit,
      pages: prioritize(pages).slice(0, exampleLimit),
      issues: prioritize(issues).slice(0, exampleLimit),
    },
  };
}

import { createHash } from "node:crypto";
import { normalizeCrawlUrl, type CrawlRun, type StorageData } from "../storage/schema.js";

export const CRAWL_REGRESSION_TYPES = [
  "NEW_HTTP_4XX",
  "NEW_HTTP_5XX",
  "NEW_NOINDEX",
  "CANONICAL_DRIFT",
  "NEW_REDIRECT_CHAIN",
  "NEW_ORPHAN_PAGE",
  "INTERNAL_LINK_LOSS",
] as const;

export type CrawlRegressionType = (typeof CRAWL_REGRESSION_TYPES)[number];
export type CrawlRegressionSeverity = "low" | "medium" | "high" | "critical";

export interface CrawlRegressionExclusion {
  target: string;
  types: CrawlRegressionType[];
  urlPrefixes: string[];
}

export interface CrawlRegressionIncident {
  id: string;
  type: CrawlRegressionType;
  severity: CrawlRegressionSeverity;
  confidence: number;
  massChange: boolean;
  affectedUrlCount: number;
  sampleUrls: string[];
}

export interface CrawlRegressionReport {
  beforeRunId: string;
  afterRunId: string;
  target: string;
  context: {
    configurationChanged: boolean;
    partialInput: boolean;
    massChangeThreshold: number;
  };
  summary: {
    incidentCount: number;
    affectedUrlCount: number;
    excludedFindingCount: number;
    massChangeCount: number;
  };
  incidents: CrawlRegressionIncident[];
}

const baseSeverity: Record<CrawlRegressionType, CrawlRegressionSeverity> = {
  NEW_HTTP_4XX: "high",
  NEW_HTTP_5XX: "critical",
  NEW_NOINDEX: "high",
  CANONICAL_DRIFT: "high",
  NEW_REDIRECT_CHAIN: "medium",
  NEW_ORPHAN_PAGE: "medium",
  INTERNAL_LINK_LOSS: "medium",
};

const baseConfidence: Record<CrawlRegressionType, number> = {
  NEW_HTTP_4XX: 1,
  NEW_HTTP_5XX: 1,
  NEW_NOINDEX: 0.98,
  CANONICAL_DRIFT: 1,
  NEW_REDIRECT_CHAIN: 0.98,
  NEW_ORPHAN_PAGE: 0.95,
  INTERNAL_LINK_LOSS: 0.9,
};

function runParametersEqual(before: CrawlRun, after: CrawlRun): boolean {
  return JSON.stringify(before.parameters) === JSON.stringify(after.parameters);
}

function issueKey(issue: StorageData["crawl"]["issues"][number]): string {
  return `${issue.fingerprintVersion}\0${issue.fingerprint}`;
}

function internalInboundLinks(data: StorageData, runId: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const link of data.crawl.links) {
    if (link.runId !== runId || link.kind !== "internal") continue;
    const sources = result.get(link.targetUrl) ?? new Set<string>();
    sources.add(link.sourceUrl);
    result.set(link.targetUrl, sources);
  }
  return result;
}

function normalizedPolicyTarget(target: string): string | undefined {
  try {
    return normalizeCrawlUrl(target);
  } catch {
    return undefined;
  }
}

function excluded(
  target: string,
  type: CrawlRegressionType,
  url: string,
  policies: readonly CrawlRegressionExclusion[],
): boolean {
  return policies.some((policy) => {
    if (normalizedPolicyTarget(policy.target) !== target) return false;
    if (policy.types.length > 0 && !policy.types.includes(type)) return false;
    return (
      policy.urlPrefixes.length === 0 || policy.urlPrefixes.some((prefix) => url.startsWith(prefix))
    );
  });
}

function severityRank(severity: CrawlRegressionSeverity): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[severity];
}

function escalate(severity: CrawlRegressionSeverity): CrawlRegressionSeverity {
  return ({ low: "medium", medium: "high", high: "critical", critical: "critical" } as const)[
    severity
  ];
}

function incidentId(beforeRunId: string, afterRunId: string, type: CrawlRegressionType): string {
  return createHash("sha256")
    .update(`${beforeRunId}\0${afterRunId}\0${type}`)
    .digest("hex")
    .slice(0, 24);
}

function confidence(type: CrawlRegressionType, before: CrawlRun, after: CrawlRun): number {
  let value = baseConfidence[type];
  if (before.status === "partial" || after.status === "partial") value -= 0.15;
  if (!runParametersEqual(before, after)) value -= 0.1;
  return Math.max(0.5, Math.round(value * 100) / 100);
}

export function detectCrawlRegressions(
  data: StorageData,
  beforeRun: CrawlRun,
  afterRun: CrawlRun,
  sampleLimit: number,
  policies: readonly CrawlRegressionExclusion[],
): CrawlRegressionReport {
  const findings = new Map(
    CRAWL_REGRESSION_TYPES.map((type) => [type, new Set<string>()] as const),
  );
  const beforePages = new Map(
    data.crawl.pages.filter(({ runId }) => runId === beforeRun.id).map((page) => [page.url, page]),
  );
  const afterPages = new Map(
    data.crawl.pages.filter(({ runId }) => runId === afterRun.id).map((page) => [page.url, page]),
  );
  for (const [url, afterPage] of afterPages) {
    const beforePage = beforePages.get(url);
    if (!beforePage) continue;
    if (beforePage.status < 400 && afterPage.status >= 400 && afterPage.status < 500)
      findings.get("NEW_HTTP_4XX")!.add(url);
    if (beforePage.status < 400 && afterPage.status >= 500) findings.get("NEW_HTTP_5XX")!.add(url);
    if (beforePage.canonical !== afterPage.canonical && afterPage.canonical !== afterPage.finalUrl)
      findings.get("CANONICAL_DRIFT")!.add(url);
  }

  const beforeIssueKeys = new Set(
    data.crawl.issues.filter(({ runId }) => runId === beforeRun.id).map(issueKey),
  );
  for (const issue of data.crawl.issues) {
    if (issue.runId !== afterRun.id || beforeIssueKeys.has(issueKey(issue)) || !issue.pageUrl)
      continue;
    if (issue.code === "NOINDEX") findings.get("NEW_NOINDEX")!.add(issue.pageUrl);
    if (issue.code === "REDIRECT_CHAIN") findings.get("NEW_REDIRECT_CHAIN")!.add(issue.pageUrl);
    if (issue.code === "ORPHAN_PAGE") findings.get("NEW_ORPHAN_PAGE")!.add(issue.pageUrl);
  }

  const beforeInbound = internalInboundLinks(data, beforeRun.id);
  const afterInbound = internalInboundLinks(data, afterRun.id);
  for (const url of afterPages.keys()) {
    if (!beforePages.has(url)) continue;
    if ((beforeInbound.get(url)?.size ?? 0) > (afterInbound.get(url)?.size ?? 0))
      findings.get("INTERNAL_LINK_LOSS")!.add(url);
  }

  let excludedFindingCount = 0;
  const totalPages = Math.max(1, afterPages.size);
  const massThreshold = Math.max(5, Math.ceil(totalPages * 0.2));
  const incidents: CrawlRegressionIncident[] = [];
  for (const type of CRAWL_REGRESSION_TYPES) {
    const urls = [...findings.get(type)!].sort().filter((url) => {
      const isExcluded = excluded(afterRun.target, type, url, policies);
      if (isExcluded) excludedFindingCount += 1;
      return !isExcluded;
    });
    if (urls.length === 0) continue;
    const massChange = urls.length >= massThreshold;
    incidents.push({
      id: incidentId(beforeRun.id, afterRun.id, type),
      type,
      severity: massChange ? escalate(baseSeverity[type]) : baseSeverity[type],
      confidence: confidence(type, beforeRun, afterRun),
      massChange,
      affectedUrlCount: urls.length,
      sampleUrls: urls.slice(0, sampleLimit),
    });
  }
  incidents.sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.type.localeCompare(right.type),
  );
  return {
    beforeRunId: beforeRun.id,
    afterRunId: afterRun.id,
    target: afterRun.target,
    context: {
      configurationChanged: !runParametersEqual(beforeRun, afterRun),
      partialInput: beforeRun.status === "partial" || afterRun.status === "partial",
      massChangeThreshold: massThreshold,
    },
    summary: {
      incidentCount: incidents.length,
      affectedUrlCount: incidents.reduce((sum, incident) => sum + incident.affectedUrlCount, 0),
      excludedFindingCount,
      massChangeCount: incidents.filter(({ massChange }) => massChange).length,
    },
    incidents,
  };
}

import type { SeoChangeCrawlImpact } from "../crawler/snapshot-store.js";
import type { SeoChange } from "../storage/schema.js";
import type { measureMetricaImpact } from "./metrica-impact.js";
import type { measureWebmasterImpact } from "./webmaster-impact.js";

export type MetricaImpact = Awaited<ReturnType<typeof measureMetricaImpact>>;
export type WebmasterImpact = Awaited<ReturnType<typeof measureWebmasterImpact>>;
export type UnifiedImpactStatus =
  "positive" | "negative" | "mixed" | "neutral" | "insufficient_data";

export interface ImpactEvidence {
  source: "crawl" | "metrica" | "webmaster";
  signal: string;
  direction: "positive" | "negative";
  before?: number | null;
  after?: number | null;
  delta: number;
  unit: "count" | "percent" | "position";
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function addEvidence(
  evidence: ImpactEvidence[],
  input: Omit<ImpactEvidence, "delta"> & { delta: number },
): void {
  if (input.delta === 0) return;
  evidence.push({ ...input, delta: round(input.delta) });
}

function addPercentMetric(
  evidence: ImpactEvidence[],
  source: ImpactEvidence["source"],
  signal: string,
  metric: { before: number; after: number; percentDelta: number | null },
  minimumPercent = 5,
): void {
  if (metric.percentDelta === null || Math.abs(metric.percentDelta) < minimumPercent) return;
  addEvidence(evidence, {
    source,
    signal,
    direction: metric.percentDelta > 0 ? "positive" : "negative",
    before: metric.before,
    after: metric.after,
    delta: metric.percentDelta,
    unit: "percent",
  });
}

export function combineChangeImpact(
  change: SeoChange,
  crawl: SeoChangeCrawlImpact,
  metrica: MetricaImpact,
  webmaster: WebmasterImpact,
  calculatedAt = new Date(),
) {
  const evidence: ImpactEvidence[] = [];
  if (crawl.status === "compared" && crawl.comparison) {
    const { pages, issues } = crawl.comparison.summary;
    const resolvedIssues = issues.resolved + issues.improved;
    const introducedIssues = issues.new + issues.worsened;
    const improvedPages = pages.improved;
    const worsenedPages = pages.worsened;
    addEvidence(evidence, {
      source: "crawl",
      signal: "technical_issues_resolved",
      direction: "positive",
      delta: resolvedIssues,
      unit: "count",
    });
    addEvidence(evidence, {
      source: "crawl",
      signal: "technical_issues_introduced",
      direction: "negative",
      delta: introducedIssues,
      unit: "count",
    });
    addEvidence(evidence, {
      source: "crawl",
      signal: "page_health_improved",
      direction: "positive",
      delta: improvedPages,
      unit: "count",
    });
    addEvidence(evidence, {
      source: "crawl",
      signal: "page_health_worsened",
      direction: "negative",
      delta: worsenedPages,
      unit: "count",
    });
  }
  if (metrica.status === "measured") {
    addPercentMetric(evidence, "metrica", "organic_visits", metrica.metrics.visits);
    addPercentMetric(evidence, "metrica", "organic_users", metrica.metrics.users);
    addPercentMetric(evidence, "metrica", "converted_visits", metrica.metrics.conversions);
  }
  if (webmaster.status === "measured") {
    addPercentMetric(evidence, "webmaster", "search_impressions", webmaster.search.impressions);
    addPercentMetric(evidence, "webmaster", "search_clicks", webmaster.search.clicks);
    addPercentMetric(evidence, "webmaster", "search_ctr", webmaster.search.ctr);
    const positionDelta = webmaster.search.position.absoluteDelta;
    if (positionDelta !== null && Math.abs(positionDelta) >= 0.5) {
      addEvidence(evidence, {
        source: "webmaster",
        signal: "average_position",
        direction: positionDelta < 0 ? "positive" : "negative",
        before: webmaster.search.position.before,
        after: webmaster.search.position.after,
        delta: positionDelta,
        unit: "position",
      });
    }
    const indexingDelta = webmaster.indexingEvents.netChange.absoluteDelta;
    addEvidence(evidence, {
      source: "webmaster",
      signal: "indexing_net_change",
      direction: indexingDelta > 0 ? "positive" : "negative",
      before: webmaster.indexingEvents.netChange.before,
      after: webmaster.indexingEvents.netChange.after,
      delta: indexingDelta,
      unit: "count",
    });
  }
  const domains = {
    technical: crawl.status === "compared",
    traffic: metrica.status === "measured",
    search: webmaster.status === "measured",
  };
  const availableDomainCount = Object.values(domains).filter(Boolean).length;
  const hasPositive = evidence.some(({ direction }) => direction === "positive");
  const hasNegative = evidence.some(({ direction }) => direction === "negative");
  let status: UnifiedImpactStatus;
  if (availableDomainCount < 2) status = "insufficient_data";
  else if (hasPositive && hasNegative) status = "mixed";
  else if (hasPositive) status = "positive";
  else if (hasNegative) status = "negative";
  else status = "neutral";
  const externalConfidences = [
    ...(metrica.status === "measured" ? [metrica.quality.confidence] : []),
    ...(webmaster.status === "measured" ? [webmaster.quality.confidence] : []),
  ];
  const confidence =
    status === "insufficient_data"
      ? "low"
      : availableDomainCount === 3 && externalConfidences.every((value) => value === "high")
        ? "high"
        : "medium";
  const crawlConfigurationChanged = Boolean(crawl.comparison?.configuration.changed);
  const alternativeExplanations = [
    {
      code: "TEMPORAL_ASSOCIATION",
      explanation: "The evidence follows the change in time but does not establish causality.",
    },
    {
      code: "UNOBSERVED_EXTERNAL_FACTORS",
      explanation:
        "Seasonality, campaigns, competitors and search-engine updates may affect the same metrics.",
    },
    {
      code: "OVERLAPPING_CHANGES",
      explanation: "Other releases during either comparison period may contribute to the result.",
    },
    ...(crawlConfigurationChanged
      ? [
          {
            code: "CRAWL_CONFIGURATION_CHANGED",
            explanation: "The paired crawls used different crawler parameters.",
          },
        ]
      : []),
  ];
  const limitations = [
    ...new Set([
      ...metrica.quality.limitations,
      ...webmaster.quality.limitations,
      ...(crawl.status === "insufficient_data" ? (crawl.missing ?? []) : []),
      ...(availableDomainCount < 2 ? ["FEWER_THAN_TWO_EVIDENCE_DOMAINS"] : []),
    ]),
  ];
  return {
    status,
    confidence,
    causalClaim: false,
    calculation: {
      calculatedAt: calculatedAt.toISOString(),
      stateless: true,
      recalculatesOnEveryCall: true,
    },
    change: {
      id: change.id,
      target: change.target,
      timestamp: change.timestamp,
      type: change.type,
      urlScope: change.urlScope,
    },
    coverage: { ...domains, availableDomainCount, requiredDomainCount: 2 },
    timeline: {
      change: { timestamp: change.timestamp, type: change.type },
      crawl: {
        status: crawl.status,
        pair: crawl.crawlPair,
        summary: crawl.comparison?.summary ?? null,
      },
      indexing: {
        status: webmaster.status,
        periods: webmaster.periods,
        events: webmaster.indexingEvents,
        dataAvailability: webmaster.dataAvailability,
      },
      search: {
        status: webmaster.status,
        periods: webmaster.periods,
        metrics: webmaster.search,
      },
      traffic: {
        status: metrica.status,
        periods: metrica.periods,
        metrics: metrica.metrics,
      },
    },
    evidence,
    alternativeExplanations,
    limitations,
    components: { crawl, metrica, webmaster },
  };
}

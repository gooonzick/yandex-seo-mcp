import { describe, expect, it } from "vitest";
import type { SeoChangeCrawlImpact } from "../src/crawler/snapshot-store.js";
import {
  combineChangeImpact,
  type MetricaImpact,
  type WebmasterImpact,
} from "../src/impact/change-impact.js";
import type { SeoChange } from "../src/storage/schema.js";

const change: SeoChange = {
  id: "11111111-1111-4111-8111-111111111111",
  target: "https://example.com/",
  timestamp: "2026-07-01T10:00:00.000Z",
  type: "deploy",
  urlScope: [],
  description: "SEO release",
  externalReference: "deploy:unified-impact",
};

function crawlImpact(
  options: { introduced?: number; resolved?: number } = {},
): SeoChangeCrawlImpact {
  return {
    status: "compared",
    change,
    crawlPair: {
      before: {
        runId: "22222222-2222-4222-8222-222222222222",
        capturedAt: "2026-06-30T10:00:00.000Z",
      },
      after: {
        runId: "33333333-3333-4333-8333-333333333333",
        capturedAt: "2026-07-02T10:00:00.000Z",
      },
    },
    relevance: { scope: "target", pageFields: [], issueCategories: [] },
    comparison: {
      before: {
        runId: "22222222-2222-4222-8222-222222222222",
        target: change.target,
        capturedAt: "2026-06-30T10:00:00.000Z",
      },
      after: {
        runId: "33333333-3333-4333-8333-333333333333",
        target: change.target,
        capturedAt: "2026-07-02T10:00:00.000Z",
      },
      configuration: { changed: false, changes: [] },
      summary: {
        pages: { new: 0, resolved: 0, worsened: 0, improved: 1, unchanged: 0 },
        issues: {
          new: options.introduced ?? 0,
          resolved: options.resolved ?? 2,
          worsened: 0,
          improved: 0,
          unchanged: 0,
        },
        pageFieldChanges: {},
      },
      examples: { limit: 20, pages: [], issues: [] },
    },
  };
}

function delta(before: number, after: number) {
  const absoluteDelta = after - before;
  return {
    before,
    after,
    absoluteDelta,
    percentDelta: before === 0 ? null : (absoluteDelta / before) * 100,
  };
}

function metricaImpact(status: "measured" | "insufficient_data" = "measured"): MetricaImpact {
  return {
    status,
    periods: {
      before: { date1: "2026-06-01", date2: "2026-06-28" },
      after: { date1: "2026-07-02", date2: "2026-07-29" },
    },
    metrics: {
      visits: delta(100, 120),
      users: delta(80, 88),
      conversions: delta(10, 13),
      conversionRate: delta(10, 10.83),
    },
    quality: { confidence: status === "measured" ? "high" : "low", limitations: [] },
  } as unknown as MetricaImpact;
}

function webmasterImpact(positionAfter = 4): WebmasterImpact {
  return {
    status: "measured",
    periods: {
      before: { date1: "2026-06-27", date2: "2026-06-30" },
      after: { date1: "2026-07-04", date2: "2026-07-07" },
    },
    dataAvailability: {},
    search: {
      impressions: delta(1_000, 1_100),
      clicks: delta(100, 120),
      ctr: delta(10, 10.91),
      position: { ...delta(5, positionAfter), lowerIsBetter: true },
    },
    indexingEvents: {
      netChange: delta(0, 2),
    },
    quality: { confidence: "high", limitations: [] },
  } as unknown as WebmasterImpact;
}

describe("combineChangeImpact", () => {
  it("returns positive when all available domains improve", () => {
    const result = combineChangeImpact(
      change,
      crawlImpact(),
      metricaImpact(),
      webmasterImpact(),
      new Date("2026-08-03T12:00:00.000Z"),
    );

    expect(result).toMatchObject({
      status: "positive",
      confidence: "high",
      causalClaim: false,
      calculation: {
        calculatedAt: "2026-08-03T12:00:00.000Z",
        stateless: true,
        recalculatesOnEveryCall: true,
      },
      coverage: { technical: true, traffic: true, search: true, availableDomainCount: 3 },
    });
    expect(result.evidence.map(({ signal }) => signal)).toEqual(
      expect.arrayContaining([
        "technical_issues_resolved",
        "organic_visits",
        "search_clicks",
        "average_position",
        "indexing_net_change",
      ]),
    );
    expect(result.alternativeExplanations.map(({ code }) => code)).toContain(
      "TEMPORAL_ASSOCIATION",
    );
  });

  it("returns mixed when technical and search evidence disagree", () => {
    const result = combineChangeImpact(
      change,
      crawlImpact({ introduced: 3, resolved: 0 }),
      metricaImpact(),
      webmasterImpact(7),
    );

    expect(result.status).toBe("mixed");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: "technical_issues_introduced", direction: "negative" }),
        expect.objectContaining({ signal: "organic_visits", direction: "positive" }),
        expect.objectContaining({ signal: "average_position", direction: "negative" }),
      ]),
    );
  });

  it("returns negative when all material signals worsen", () => {
    const crawl = crawlImpact({ introduced: 3, resolved: 0 });
    crawl.comparison!.summary.pages.improved = 0;
    const metrica = metricaImpact();
    metrica.metrics.visits = delta(100, 80);
    metrica.metrics.users = delta(100, 85);
    metrica.metrics.conversions = delta(100, 70);
    const webmaster = webmasterImpact(7);
    webmaster.search.impressions = delta(1_000, 800);
    webmaster.search.clicks = delta(100, 70);
    webmaster.search.ctr = delta(10, 8.75);
    webmaster.indexingEvents.netChange = delta(2, -1);

    expect(combineChangeImpact(change, crawl, metrica, webmaster).status).toBe("negative");
  });

  it("returns neutral when sufficient domains have no material movement", () => {
    const crawl = crawlImpact({ introduced: 0, resolved: 0 });
    crawl.comparison!.summary.pages.improved = 0;
    const metrica = metricaImpact();
    metrica.metrics.visits = delta(100, 103);
    metrica.metrics.users = delta(100, 103);
    metrica.metrics.conversions = delta(100, 103);
    const webmaster = webmasterImpact(5.2);
    webmaster.search.impressions = delta(1_000, 1_030);
    webmaster.search.clicks = delta(100, 102);
    webmaster.search.ctr = delta(10, 10.2);
    webmaster.indexingEvents.netChange = delta(0, 0);

    expect(combineChangeImpact(change, crawl, metrica, webmaster).status).toBe("neutral");
  });

  it("returns insufficient_data when fewer than two evidence domains are available", () => {
    const crawl: SeoChangeCrawlImpact = {
      status: "insufficient_data",
      change,
      crawlPair: { before: null, after: null },
      missing: ["crawl_before_change", "crawl_after_change"],
    };
    const result = combineChangeImpact(
      change,
      crawl,
      metricaImpact("insufficient_data"),
      webmasterImpact(),
    );

    expect(result).toMatchObject({
      status: "insufficient_data",
      confidence: "low",
      coverage: { availableDomainCount: 1, requiredDomainCount: 2 },
    });
    expect(result.limitations).toContain("FEWER_THAN_TWO_EVIDENCE_DOMAINS");
  });
});

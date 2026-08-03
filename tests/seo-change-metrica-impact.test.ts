import { describe, expect, it, vi } from "vitest";
import { measureMetricaImpact } from "../src/impact/metrica-impact.js";
import type { SeoChange } from "../src/storage/schema.js";

const scopedChange: SeoChange = {
  id: "11111111-1111-4111-8111-111111111111",
  target: "https://example.com/",
  timestamp: "2020-07-01T10:00:00.000Z",
  type: "content",
  urlScope: ["https://example.com/scoped"],
  description: "Content release",
  externalReference: "cms:release-1",
};

function report(scopedMetrics: number[], otherMetrics: number[]) {
  return {
    data: [
      { dimensions: [{ name: "https://example.com/scoped" }], metrics: scopedMetrics },
      { dimensions: [{ name: "https://example.com/other" }], metrics: otherMetrics },
    ],
    totals: scopedMetrics.map((value, index) => value + (otherMetrics[index] ?? 0)),
    total_rows: 2,
    sampled: false,
    sample_share: 1,
    data_lag: 0,
  };
}

describe("measureMetricaImpact", () => {
  it("compares equal whole-week periods and limits evidence to the change URL scope", async () => {
    const getReport = vi
      .fn()
      .mockResolvedValueOnce(report([200, 150, 10], [500, 400, 5]))
      .mockResolvedValueOnce(report([300, 220, 12], [100, 80, 4]));

    const result = await measureMetricaImpact({ getReport }, scopedChange, {
      counterId: 123,
      periodDays: 28,
      minVisits: 100,
      sourceLimit: 1_000,
      resultLimit: 25,
      timezone: "+00:00",
      goalId: 7,
      accuracy: "full",
    });

    expect(result).toMatchObject({
      status: "measured",
      periods: {
        before: { date1: "2020-06-03", date2: "2020-06-30" },
        after: { date1: "2020-07-02", date2: "2020-07-29" },
        daysEach: 28,
        wholeWeeks: 4,
        weekdayBalanced: true,
        excludedChangeDate: "2020-07-01",
      },
      scope: "explicit_urls",
      metrics: {
        visits: { before: 200, after: 300, absoluteDelta: 100, percentDelta: 50 },
        users: { before: 150, after: 220 },
        conversions: { before: 20, after: 36, absoluteDelta: 16, percentDelta: 80 },
      },
      landingPages: {
        totalCompared: 1,
        items: [{ url: "https://example.com/scoped" }],
      },
      quality: {
        confidence: "high",
        minimumObservedVisits: 200,
        causalClaim: false,
      },
    });
    expect(result.quality.limitations).toContain("OBSERVATIONAL_ASSOCIATION_NOT_CAUSAL");
    expect(getReport).toHaveBeenCalledTimes(2);
    expect(getReport.mock.calls[0]?.[0]).toMatchObject({
      dimensions: "ym:s:startURL",
      metrics: "ym:s:visits,ym:s:users,ym:s:goal7conversionRate",
      filters: "ym:s:lastSignTrafficSource=='organic'",
      date1: "2020-06-03",
      date2: "2020-06-30",
    });
  });

  it("marks low-volume evidence as insufficient without claiming causality", async () => {
    const getReport = vi
      .fn()
      .mockResolvedValueOnce(report([5, 4, 10], [0, 0, 0]))
      .mockResolvedValueOnce(report([7, 6, 20], [0, 0, 0]));

    const result = await measureMetricaImpact(
      { getReport },
      { ...scopedChange, urlScope: [] },
      {
        counterId: 123,
        periodDays: 7,
        minVisits: 10,
        sourceLimit: 1_000,
        resultLimit: 25,
        timezone: "+00:00",
      },
    );

    expect(result).toMatchObject({
      status: "insufficient_data",
      quality: { confidence: "low", minimumObservedVisits: 5, causalClaim: false },
    });
    expect(result.quality.limitations).toContain("LOW_TRAFFIC_VOLUME");
  });
});

import { describe, expect, it, vi } from "vitest";
import { measureWebmasterImpact } from "../src/impact/webmaster-impact.js";
import type { SeoChange } from "../src/storage/schema.js";

const scopedChange: SeoChange = {
  id: "11111111-1111-4111-8111-111111111111",
  target: "https://example.com/",
  timestamp: "2026-07-25T10:00:00.000Z",
  type: "metadata",
  urlScope: ["https://example.com/scoped"],
  description: "Metadata release",
  externalReference: "deploy:metadata-2",
};

const queryAnalytics = {
  count: 2,
  text_indicator_to_statistics: [
    {
      text_indicator: { type: "URL", value: "https://example.com/scoped" },
      statistics: [
        { date: "2026-07-23", field: "IMPRESSIONS", value: 100 },
        { date: "2026-07-23", field: "CLICKS", value: 10 },
        { date: "2026-07-23", field: "POSITION", value: 5 },
        { date: "2026-07-29", field: "IMPRESSIONS", value: 150 },
        { date: "2026-07-29", field: "CLICKS", value: 30 },
        { date: "2026-07-29", field: "CTR", value: 20 },
        { date: "2026-07-29", field: "POSITION", value: 4 },
      ],
    },
    {
      text_indicator: { type: "URL", value: "https://example.com/other" },
      statistics: [
        { date: "2026-07-23", field: "IMPRESSIONS", value: 1_000 },
        { date: "2026-07-29", field: "IMPRESSIONS", value: 10 },
      ],
    },
  ],
};

const indexingEvents = {
  indicators: {
    APPEARED_IN_SEARCH: [
      { date: "2026-07-23T00:00:00.000Z", value: 2 },
      { date: "2026-07-29T00:00:00.000Z", value: 5 },
    ],
    REMOVED_FROM_SEARCH: [
      { date: "2026-07-23T00:00:00.000Z", value: 1 },
      { date: "2026-07-29T00:00:00.000Z", value: 0 },
    ],
  },
};

describe("measureWebmasterImpact", () => {
  it("compares scoped visibility and target-level indexing events after the data delay", async () => {
    const getQueryAnalytics = vi.fn().mockResolvedValue(queryAnalytics);
    const getSearchEventsHistory = vi.fn().mockResolvedValue(indexingEvents);

    const result = await measureWebmasterImpact(
      { getQueryAnalytics, getSearchEventsHistory },
      scopedChange,
      {
        hostId: "https:example.com:443",
        periodDays: 3,
        dataDelayDays: 2,
        minImpressions: 50,
        sourceLimit: 500,
        resultLimit: 25,
        deviceType: "ALL",
        searchLocation: "WEB_LOCATION",
      },
      new Date("2026-08-03T12:00:00.000Z"),
    );

    expect(result).toMatchObject({
      status: "measured",
      periods: {
        before: { date1: "2026-07-22", date2: "2026-07-24" },
        after: { date1: "2026-07-28", date2: "2026-07-30" },
        daysEach: 3,
        postChangeDelayDays: 2,
      },
      dataAvailability: { latestExpectedDataDate: "2026-08-01", postPeriodReady: true },
      scope: "explicit_urls",
      search: {
        impressions: { before: 100, after: 150, absoluteDelta: 50, percentDelta: 50 },
        clicks: { before: 10, after: 30, absoluteDelta: 20, percentDelta: 200 },
        ctr: { before: 10, after: 20, absoluteDelta: 10, percentDelta: 100 },
        position: { before: 5, after: 4, absoluteDelta: -1, lowerIsBetter: true },
      },
      indexingEvents: {
        scope: "target",
        appeared: { before: 2, after: 5 },
        removed: { before: 1, after: 0 },
        netChange: { before: 1, after: 5 },
      },
      urls: { totalCompared: 1, items: [{ url: "https://example.com/scoped" }] },
      quality: { confidence: "medium", minimumObservedImpressions: 100, causalClaim: false },
    });
    expect(result.quality.limitations).toContain("INDEXING_EVENTS_ARE_TARGET_LEVEL");
    expect(getQueryAnalytics).toHaveBeenCalledWith("https:example.com:443", {
      offset: 0,
      limit: 500,
      device_type_indicator: "ALL",
      search_location: "WEB_LOCATION",
      text_indicator: "URL",
      sort_by_date: {
        date: "2026-07-30",
        statistic_field: "IMPRESSIONS",
        by: "DESC",
      },
    });
    expect(getSearchEventsHistory).toHaveBeenCalledWith("https:example.com:443", {
      date_from: "2026-07-22",
      date_to: "2026-07-30",
    });
  });

  it("returns insufficient_data when the post-change period is not expected yet", async () => {
    const result = await measureWebmasterImpact(
      {
        getQueryAnalytics: vi.fn().mockResolvedValue(queryAnalytics),
        getSearchEventsHistory: vi.fn().mockResolvedValue(indexingEvents),
      },
      { ...scopedChange, timestamp: "2026-07-29T10:00:00.000Z", urlScope: [] },
      {
        hostId: "https:example.com:443",
        periodDays: 3,
        dataDelayDays: 2,
        minImpressions: 0,
        sourceLimit: 500,
        resultLimit: 25,
        deviceType: "ALL",
        searchLocation: "WEB_LOCATION",
      },
      new Date("2026-08-03T12:00:00.000Z"),
    );

    expect(result).toMatchObject({
      status: "insufficient_data",
      dataAvailability: { latestExpectedDataDate: "2026-08-01", postPeriodReady: false },
      quality: { confidence: "low", causalClaim: false },
    });
    expect(result.quality.limitations).toContain("POST_CHANGE_PERIOD_NOT_YET_EXPECTED");
  });
});

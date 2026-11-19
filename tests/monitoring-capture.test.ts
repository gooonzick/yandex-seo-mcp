import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MetricaClient } from "../src/metrica/client.js";
import { MonitoringStore } from "../src/monitoring/store.js";
import { captureSnapshot } from "../src/monitoring/tools.js";
import { YandexApiError } from "../src/shared/errors.js";
import type { WebmasterClient } from "../src/webmaster/client.js";

describe("captureSnapshot", () => {
  it("captures search performance when Yandex has no data for today", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-monitor-capture-"));
    const store = new MonitoringStore(join(directory, "snapshots.json"), 90);
    // Yandex query analytics lags behind the calendar. It rejects a sort date
    // outside the window it currently serves with HTTP 400.
    const lastServedDate = "2026-10-06";
    const getQueryAnalytics = vi.fn((_hostId: string, body: unknown) => {
      const sortDate = (body as { sort_by_date?: { date?: string } }).sort_by_date?.date;
      if (sortDate !== undefined && sortDate > lastServedDate) {
        return Promise.reject(
          new YandexApiError("VALIDATION", "Yandex API returned HTTP 400", { status: 400 }),
        );
      }
      return Promise.resolve({
        count: 1,
        text_indicator_to_statistics: [
          {
            text_indicator: { type: "QUERY", value: "seo audit" },
            statistics: [
              { date: lastServedDate, field: "IMPRESSIONS", value: 40 },
              { date: lastServedDate, field: "CLICKS", value: 4 },
              { date: lastServedDate, field: "POSITION", value: 6 },
            ],
          },
        ],
      });
    });
    const webmaster = {
      getSummary: vi.fn().mockResolvedValue({ searchable_pages_count: 14 }),
      getDiagnostics: vi.fn().mockResolvedValue({ problems: {} }),
      listSitemaps: vi.fn().mockResolvedValue({ sitemaps: [] }),
      getQueryAnalytics,
    } as unknown as WebmasterClient;

    const snapshot = await captureSnapshot(
      { name: "production", hostId: "https:example.com:443" },
      store,
      {} as MetricaClient,
      webmaster,
    );

    expect(snapshot.search).toMatchObject({ impressions: 40, clicks: 4, ctr: 10, position: 6 });
    expect(getQueryAnalytics).toHaveBeenCalledTimes(1);
    expect(getQueryAnalytics.mock.calls[0]?.[1]).not.toHaveProperty("sort_by_date");
  });
});

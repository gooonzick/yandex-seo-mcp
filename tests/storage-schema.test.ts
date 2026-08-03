import { describe, expect, it } from "vitest";
import { migrateStorage } from "../src/storage/migrations.js";
import { pruneCrawlHistory } from "../src/storage/retention.js";
import { emptyStorage, normalizeCrawlUrl, storageSchema } from "../src/storage/schema.js";

const run = (id: string, target: string, startedAt: string, status = "completed" as const) => ({
  id,
  target,
  startedAt,
  finishedAt: status === "running" ? null : startedAt,
  status,
  parameters: {
    startUrl: target,
    maxPages: 100,
    maxDepth: 5,
    timeoutMs: 15_000,
    maxBodyBytes: 2_000_000,
    concurrency: 4,
    delayMs: 0,
    userAgent: "YandexSeoMcpBot/1.0",
  },
});

describe("crawl storage schema", () => {
  it("normalizes equivalent URLs deterministically", () => {
    expect(normalizeCrawlUrl("HTTPS://Example.COM:443/a/../b?z=2&a=1#section")).toBe(
      "https://example.com/b?a=1&z=2",
    );
  });

  it("rejects non-normalized persisted URLs", () => {
    const data = emptyStorage();
    data.crawl.runs.push(
      run(
        "22222222-2222-4222-8222-222222222222",
        "https://example.com",
        "2026-08-01T00:00:00.000Z",
      ),
    );
    expect(() => storageSchema.parse(data)).toThrow(/canonical crawl normalization/);
  });

  it("rejects unknown schema versions", () => {
    expect(() => migrateStorage({ version: 99 })).toThrow(/Unsupported storage schema version/);
  });

  it("applies age and per-target retention while preserving active runs", () => {
    const data = emptyStorage();
    data.crawl.runs.push(
      run(
        "11111111-1111-4111-8111-111111111111",
        "https://example.com/",
        "2026-07-01T00:00:00.000Z",
      ),
      run(
        "22222222-2222-4222-8222-222222222222",
        "https://example.com/",
        "2026-08-01T00:00:00.000Z",
      ),
      run(
        "33333333-3333-4333-8333-333333333333",
        "https://example.com/",
        "2026-08-02T00:00:00.000Z",
      ),
      run(
        "44444444-4444-4444-8444-444444444444",
        "https://example.com/",
        "2026-06-01T00:00:00.000Z",
        "running",
      ),
    );

    const pruned = pruneCrawlHistory(
      data,
      { maxAgeDays: 30, maxRunsPerTarget: 1 },
      new Date("2026-08-03T00:00:00.000Z"),
    );
    expect(pruned.crawl.runs.map(({ id }) => id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
  });
});

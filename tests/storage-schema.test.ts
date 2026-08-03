import { describe, expect, it } from "vitest";
import { migrateStorage } from "../src/storage/migrations.js";
import { planCrawlHistoryCleanup, pruneCrawlHistory } from "../src/storage/retention.js";
import { emptyStorage, normalizeCrawlUrl, storageSchema } from "../src/storage/schema.js";
import { createActionFingerprint, type ActionScope } from "../src/actions/model.js";

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

  it("continues to validate issues written with an older fingerprint version", () => {
    const data = emptyStorage();
    const runId = "11111111-1111-4111-8111-111111111111";
    data.crawl.runs.push(run(runId, "https://example.com/", "2026-08-01T00:00:00.000Z"));
    data.crawl.issues.push({
      id: "22222222-2222-4222-8222-222222222222",
      runId,
      pageUrl: "https://example.com/page",
      code: "SHORT_TITLE",
      category: "metadata",
      severity: "info",
      fingerprint: "legacy-fingerprint",
      fingerprintVersion: 1,
      details: {},
    });

    expect(storageSchema.parse(data).crawl.issues[0]?.fingerprintVersion).toBe(1);
  });

  it("persists strict action items in the current schema", () => {
    const data = emptyStorage();
    const affectedScope: ActionScope = {
      kind: "target",
      target: "https://example.com/",
      urls: [],
      queries: [],
    };
    const evidence = {
      sourceTool: "monitor_check_alerts",
      sourceResult: { type: "monitoring_snapshot" as const, id: "snapshot-1" },
      signal: "SEARCH_CTR_DROP",
      observedAt: "2026-08-03T10:00:00.000Z",
      summary: "Search CTR dropped materially.",
    };
    data.actions.push({
      id: "55555555-5555-4555-8555-555555555555",
      fingerprint: createActionFingerprint({
        source: "monitoring",
        category: "search_visibility",
        affectedScope,
        signal: evidence.signal,
      }),
      fingerprintVersion: 1,
      source: "monitoring",
      category: "search_visibility",
      affectedScope,
      severity: "warning",
      impact: "medium",
      confidence: "high",
      effort: "medium",
      status: "open",
      title: "Investigate CTR regression",
      description: "Review snippets and affected queries.",
      evidence: [evidence],
      createdAt: "2026-08-03T10:00:00.000Z",
      updatedAt: "2026-08-03T10:00:00.000Z",
    });

    expect(storageSchema.parse(data).actions).toHaveLength(1);
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
    const plan = planCrawlHistoryCleanup(
      data,
      { maxAgeDays: 30, maxRunsPerTarget: 1 },
      new Date("2026-08-03T00:00:00.000Z"),
    );
    expect(plan.deleted).toMatchObject({ runs: 2 });
    expect(plan.deletedRunIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(plan.activeRunCount).toBe(1);
  });
});

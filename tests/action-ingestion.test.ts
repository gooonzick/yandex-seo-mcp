import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeActionSignals } from "../src/actions/normalizers.js";
import { ActionStore } from "../src/actions/store.js";

describe("Action signal ingestion", () => {
  it("normalizes every ACT-002 source into bounded action items", () => {
    const base = {
      target: "https://example.com/?token=secret",
      resultId: "result-1",
      observedAt: "2026-08-08T10:00:00+00:00",
      sourceComplete: false,
    };
    const batches = [
      normalizeActionSignals({
        ...base,
        producer: "crawler_regressions",
        signals: [
          {
            kind: "crawler_regression",
            type: "NEW_HTTP_5XX",
            severity: "critical",
            confidence: 1,
            affectedUrlCount: 1,
            affectedUrls: ["https://example.com/broken?token=secret"],
            massChange: false,
          },
        ],
      }),
      normalizeActionSignals({
        ...base,
        producer: "webmaster_diagnostics",
        signals: [
          {
            kind: "webmaster_diagnostic",
            code: "INDEXING_ERROR",
            severity: "error",
            affectedUrls: [],
            affectedUrlCount: 3,
          },
        ],
      }),
      normalizeActionSignals({
        ...base,
        producer: "content_decay",
        signals: [
          {
            kind: "content_decay",
            url: "https://example.com/old",
            severity: "HIGH",
            previousVisits: 100,
            currentVisits: 40,
            dropPercent: 60,
          },
        ],
      }),
      normalizeActionSignals({
        ...base,
        producer: "cannibalization",
        signals: [
          {
            kind: "cannibalization",
            query: "seo audit",
            urls: ["https://example.com/a", "https://example.com/b"],
            impressions: 1_200,
          },
        ],
      }),
      normalizeActionSignals({
        ...base,
        producer: "content_gaps",
        signals: [
          {
            kind: "content_gap",
            query: "seo checklist",
            urls: [],
            gapTypes: ["MISSING_PAGE", "TECHNICAL_BLOCKER"],
            impressions: 500,
          },
        ],
      }),
      normalizeActionSignals({
        ...base,
        producer: "monitoring_alerts",
        signals: [{ kind: "monitoring_alert", code: "ORGANIC_TRAFFIC_DROP", severity: "critical" }],
      }),
    ];

    expect(batches.map((batch) => batch.candidates.length)).toEqual([1, 1, 1, 1, 2, 1]);
    expect(batches.flatMap((batch) => batch.candidates)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "crawler", category: "technical" }),
        expect.objectContaining({ source: "webmaster", category: "indexing" }),
        expect.objectContaining({ source: "metrica", category: "content" }),
        expect.objectContaining({ source: "seo_analysis", category: "search_visibility" }),
        expect.objectContaining({ source: "query_intelligence", category: "opportunity" }),
        expect.objectContaining({ source: "monitoring", category: "monitoring" }),
      ]),
    );
    expect(JSON.stringify(batches)).not.toContain("secret");
  });

  it("deduplicates repeated results and resolves only a confirmed complete absence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-actions-"));
    const filePath = join(directory, "storage.json");
    const store = new ActionStore(filePath);
    const input = {
      producer: "monitoring_alerts" as const,
      target: "https://example.com/",
      resultId: "snapshot-1",
      observedAt: "2026-08-08T10:00:00.000Z",
      sourceComplete: false,
      signals: [
        {
          kind: "monitoring_alert" as const,
          code: "SEARCH_CTR_DROP",
          severity: "warning" as const,
        },
      ],
    };

    expect(await store.sync(normalizeActionSignals(input))).toMatchObject({ created: 1 });
    expect(await store.sync(normalizeActionSignals(input))).toMatchObject({
      created: 0,
      unchanged: 1,
    });
    await store.sync(normalizeActionSignals({ ...input, resultId: "snapshot-2", signals: [] }));
    expect((await store.all())[0]).toMatchObject({ status: "open" });
    expect(
      await store.sync(
        normalizeActionSignals({
          ...input,
          resultId: "snapshot-3",
          sourceComplete: true,
          signals: [],
        }),
      ),
    ).toMatchObject({ resolved: 1 });
    expect((await store.all())[0]).toMatchObject({ status: "resolved" });

    const reopened = await store.sync(
      normalizeActionSignals({
        ...input,
        resultId: "snapshot-4",
        observedAt: "2026-08-08T12:00:00.000Z",
      }),
    );
    expect(reopened).toMatchObject({ updated: 1, reopened: 1 });
    expect((await store.all())[0]).toMatchObject({ status: "open", evidence: [{}, {}] });
    expect(await readFile(filePath, "utf8")).not.toContain("token");
  });
});

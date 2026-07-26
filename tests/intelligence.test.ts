import { describe, expect, it } from "vitest";
import {
  clusterQueries,
  detectIntent,
  normalizeQuery,
  querySimilarity,
  queryTokens,
  type QuerySignal,
} from "../src/intelligence/clustering.js";

const signals: QuerySignal[] = [
  {
    query: "купить SEO аудит",
    url: "https://example.com/audit",
    impressions: 500,
    clicks: 25,
    ctr: 5,
    position: 7,
    demand: 700,
  },
  {
    query: "SEO аудит цена",
    url: "https://example.com/seo-audit",
    impressions: 300,
    clicks: 9,
    ctr: 3,
    position: 10,
    demand: 450,
  },
  {
    query: "как настроить яндекс метрику",
    url: "https://example.com/metrica-guide",
    impressions: 200,
    clicks: 20,
    ctr: 10,
    position: 5,
    demand: 250,
  },
];

describe("query intelligence clustering", () => {
  it("normalizes queries and detects intent", () => {
    expect(normalizeQuery("  КАК настроить SEO-аудит?! ")).toBe("как настроить seo аудит");
    expect(queryTokens("Купить SEO-аудит по цене")).toEqual(
      expect.arrayContaining(["купить", "seo", "аудит", "цене"]),
    );
    expect(detectIntent("купить seo аудит цена")).toBe("transactional");
    expect(detectIntent("как настроить метрику")).toBe("informational");
  });

  it("scores related queries above unrelated ones", () => {
    expect(querySimilarity("seo аудит цена", "купить seo аудит")).toBeGreaterThan(
      querySimilarity("seo аудит цена", "как настроить метрику"),
    );
  });

  it("builds aggregate clusters and exposes competing pages", () => {
    const clusters = clusterQueries(signals, 0.4);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({
      intent: "transactional",
      metrics: { impressions: 800, clicks: 34 },
      pages: [{ url: "https://example.com/audit" }, { url: "https://example.com/seo-audit" }],
    });
  });
});

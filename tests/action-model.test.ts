import { describe, expect, it } from "vitest";
import {
  ACTION_FINGERPRINT_VERSION,
  actionItemSchema,
  actionStatusSchema,
  createActionFingerprint,
  type ActionScope,
} from "../src/actions/model.js";

const affectedScope: ActionScope = {
  kind: "urls",
  target: "https://example.com/",
  urls: ["https://example.com/a", "https://example.com/b"],
  queries: [],
};

function item() {
  const evidence = {
    sourceTool: "crawler_detect_regressions",
    sourceResult: {
      type: "crawl_run" as const,
      id: "11111111-1111-4111-8111-111111111111",
    },
    signal: "NEW_NOINDEX",
    observedAt: "2026-08-03T10:00:00.000Z",
    summary: "Two catalog URLs became non-indexable.",
  };
  return {
    id: "22222222-2222-4222-8222-222222222222",
    fingerprint: createActionFingerprint({
      source: "crawler",
      category: "indexing",
      affectedScope,
      signal: evidence.signal,
    }),
    fingerprintVersion: ACTION_FINGERPRINT_VERSION,
    source: "crawler" as const,
    category: "indexing" as const,
    affectedScope,
    severity: "error" as const,
    impact: "high" as const,
    confidence: "high" as const,
    effort: "medium" as const,
    status: "open" as const,
    title: "Restore catalog indexability",
    description: "Investigate and remove the unexpected noindex directive.",
    evidence: [evidence],
    createdAt: "2026-08-03T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
  };
}

describe("action item model", () => {
  it("validates the unified fields and traceable source evidence", () => {
    expect(actionItemSchema.parse(item())).toMatchObject({
      source: "crawler",
      category: "indexing",
      affectedScope: { kind: "urls" },
      severity: "error",
      impact: "high",
      confidence: "high",
      effort: "medium",
      status: "open",
      evidence: [
        {
          sourceTool: "crawler_detect_regressions",
          sourceResult: { type: "crawl_run" },
          signal: "NEW_NOINDEX",
        },
      ],
    });
  });

  it("supports every lifecycle state", () => {
    expect(actionStatusSchema.options).toEqual([
      "open",
      "acknowledged",
      "in_progress",
      "resolved",
      "ignored",
    ]);
  });

  it("creates stable fingerprints and changes identity inputs deterministically", () => {
    const first = item().fingerprint;
    expect(first).toMatch(/^act:v1:[a-f0-9]{64}$/);
    expect(item().fingerprint).toBe(first);
    expect(
      createActionFingerprint({
        source: "crawler",
        category: "indexing",
        affectedScope,
        signal: "CANONICAL_MISMATCH",
      }),
    ).not.toBe(first);
  });

  it("rejects untraceable payloads, invalid scopes and mismatched fingerprints", () => {
    expect(() =>
      actionItemSchema.parse({
        ...item(),
        evidence: [{ ...item().evidence[0], arbitraryPayload: { secret: true } }],
      }),
    ).toThrow();
    expect(() =>
      actionItemSchema.parse({
        ...item(),
        affectedScope: {
          kind: "urls",
          target: "https://example.com/",
          urls: ["https://other.test/a"],
          queries: [],
        },
      }),
    ).toThrow(/target origin/);
    expect(() =>
      actionItemSchema.parse({ ...item(), fingerprint: `act:v1:${"0".repeat(64)}` }),
    ).toThrow(/primary evidence identity/);
  });
});

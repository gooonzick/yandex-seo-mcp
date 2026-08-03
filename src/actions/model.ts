import { createHash } from "node:crypto";
import { z } from "zod";

export const ACTION_FINGERPRINT_VERSION = 1 as const;

const isoTimestamp = z.string().datetime({ offset: true });
const normalizedActionUrl = z.url().refine((value) => normalizeActionUrl(value) === value, {
  message: "URL must use the canonical action normalization",
});

export const actionSourceSchema = z.enum([
  "crawler",
  "webmaster",
  "metrica",
  "monitoring",
  "query_intelligence",
  "seo_analysis",
  "manual",
]);

export const actionCategorySchema = z.enum([
  "technical",
  "indexing",
  "metadata",
  "content",
  "internal_links",
  "search_visibility",
  "traffic",
  "opportunity",
  "monitoring",
]);

export const actionStatusSchema = z.enum([
  "open",
  "acknowledged",
  "in_progress",
  "resolved",
  "ignored",
]);

export const actionScopeSchema = z
  .object({
    kind: z.enum(["target", "urls", "queries", "mixed"]),
    target: normalizedActionUrl,
    urls: z.array(normalizedActionUrl).max(500),
    queries: z.array(z.string().trim().min(1).max(500)).max(500),
  })
  .strict()
  .superRefine((scope, context) => {
    const urlSet = new Set(scope.urls);
    const querySet = new Set(scope.queries);
    if (
      urlSet.size !== scope.urls.length ||
      [...urlSet].sort().join("\0") !== scope.urls.join("\0")
    )
      context.addIssue({
        code: "custom",
        path: ["urls"],
        message: "URLs must be unique and sorted",
      });
    if (
      querySet.size !== scope.queries.length ||
      [...querySet].sort().join("\0") !== scope.queries.join("\0")
    )
      context.addIssue({
        code: "custom",
        path: ["queries"],
        message: "Queries must be unique and sorted",
      });
    const origin = new URL(scope.target).origin;
    if (scope.urls.some((url) => new URL(url).origin !== origin))
      context.addIssue({
        code: "custom",
        path: ["urls"],
        message: "URLs must use the target origin",
      });
    const validKind =
      (scope.kind === "target" && scope.urls.length === 0 && scope.queries.length === 0) ||
      (scope.kind === "urls" && scope.urls.length > 0 && scope.queries.length === 0) ||
      (scope.kind === "queries" && scope.urls.length === 0 && scope.queries.length > 0) ||
      (scope.kind === "mixed" && scope.urls.length > 0 && scope.queries.length > 0);
    if (!validKind)
      context.addIssue({
        code: "custom",
        path: ["kind"],
        message: "Scope kind must match its URL and query members",
      });
  });

export const actionEvidenceSchema = z
  .object({
    sourceTool: z.string().regex(/^[a-z][a-z0-9_]{2,100}$/),
    sourceResult: z
      .object({
        type: z.enum([
          "crawl_run",
          "monitoring_snapshot",
          "webmaster_response",
          "metrica_report",
          "analysis_result",
          "manual_reference",
        ]),
        id: z.string().trim().min(1).max(500),
      })
      .strict(),
    signal: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    observedAt: isoTimestamp,
    summary: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const actionFingerprintSchema = z
  .string()
  .regex(/^act:v1:[a-f0-9]{64}$/, "Invalid action fingerprint");

export const actionItemSchema = z
  .object({
    id: z.uuid(),
    fingerprint: actionFingerprintSchema,
    fingerprintVersion: z.literal(ACTION_FINGERPRINT_VERSION),
    source: actionSourceSchema,
    category: actionCategorySchema,
    affectedScope: actionScopeSchema,
    severity: z.enum(["info", "warning", "error", "critical"]),
    impact: z.enum(["low", "medium", "high", "critical"]),
    confidence: z.enum(["low", "medium", "high"]),
    effort: z.enum(["low", "medium", "high"]),
    status: actionStatusSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000),
    evidence: z.array(actionEvidenceSchema).min(1).max(100),
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
  })
  .strict()
  .superRefine((item, context) => {
    if (item.updatedAt < item.createdAt)
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must not be earlier than createdAt",
      });
    const expected = createActionFingerprint({
      source: item.source,
      category: item.category,
      affectedScope: item.affectedScope,
      signal: item.evidence[0]!.signal,
    });
    if (item.fingerprint !== expected)
      context.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "Fingerprint must match the primary evidence identity",
      });
  });

export type ActionSource = z.infer<typeof actionSourceSchema>;
export type ActionCategory = z.infer<typeof actionCategorySchema>;
export type ActionStatus = z.infer<typeof actionStatusSchema>;
export type ActionScope = z.infer<typeof actionScopeSchema>;
export type ActionEvidence = z.infer<typeof actionEvidenceSchema>;
export type ActionItem = z.infer<typeof actionItemSchema>;

export interface ActionFingerprintInput {
  source: ActionSource;
  category: ActionCategory;
  affectedScope: ActionScope;
  signal: string;
}

export function createActionFingerprint(input: ActionFingerprintInput): string {
  const identity = {
    version: ACTION_FINGERPRINT_VERSION,
    source: input.source,
    category: input.category,
    target: input.affectedScope.target,
    kind: input.affectedScope.kind,
    urls: input.affectedScope.urls,
    queries: input.affectedScope.queries,
    signal: input.signal,
  };
  return `act:v1:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function normalizeActionUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.username = "";
  url.password = "";
  url.searchParams.sort();
  return url.href;
}

import { z } from "zod";
import { YandexApiError } from "../shared/errors.js";
import { DEFAULT_SECRET_QUERY_KEYS, sanitizeStoredUrl } from "../shared/stored-url.js";
import {
  createActionFingerprint,
  normalizeActionUrl,
  type ActionCategory,
  type ActionEvidence,
  type ActionItem,
  type ActionScope,
  type ActionSource,
} from "./model.js";

const severitySchema = z.enum(["info", "warning", "error", "critical"]);
const urlListSchema = z.array(z.url()).max(500);

export const actionSignalProducerSchema = z.enum([
  "crawler_regressions",
  "webmaster_diagnostics",
  "content_decay",
  "cannibalization",
  "content_gaps",
  "monitoring_alerts",
]);

const actionSignalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("crawler_regression"),
      type: z.enum([
        "NEW_HTTP_4XX",
        "NEW_HTTP_5XX",
        "NEW_NOINDEX",
        "CANONICAL_DRIFT",
        "NEW_REDIRECT_CHAIN",
        "NEW_ORPHAN_PAGE",
        "INTERNAL_LINK_LOSS",
      ]),
      severity: z.enum(["low", "medium", "high", "critical"]),
      confidence: z.number().min(0).max(1),
      affectedUrlCount: z.number().int().positive(),
      affectedUrls: urlListSchema,
      massChange: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("webmaster_diagnostic"),
      code: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),
      severity: severitySchema,
      affectedUrls: urlListSchema.default([]),
      affectedUrlCount: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("content_decay"),
      url: z.url(),
      severity: z.enum(["MODERATE", "HIGH", "SEVERE"]),
      previousVisits: z.number().nonnegative(),
      currentVisits: z.number().nonnegative(),
      dropPercent: z.number().min(0).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cannibalization"),
      query: z.string().trim().min(1).max(500),
      urls: urlListSchema.min(2),
      impressions: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("content_gap"),
      query: z.string().trim().min(1).max(500),
      urls: urlListSchema,
      gapTypes: z
        .array(
          z.enum([
            "MISSING_PAGE",
            "MAPPED_PAGE_NOT_CRAWLED",
            "WEAK_PAGE_RELEVANCE",
            "CANNIBALIZATION",
            "TECHNICAL_BLOCKER",
          ]),
        )
        .min(1)
        .max(5),
      impressions: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("monitoring_alert"),
      code: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),
      severity: z.enum(["info", "warning", "critical"]),
    })
    .strict(),
]);

const producerKinds = {
  crawler_regressions: "crawler_regression",
  webmaster_diagnostics: "webmaster_diagnostic",
  content_decay: "content_decay",
  cannibalization: "cannibalization",
  content_gaps: "content_gap",
  monitoring_alerts: "monitoring_alert",
} as const;

export const ingestActionSignalsSchema = z
  .object({
    producer: actionSignalProducerSchema,
    target: z.url(),
    resultId: z.string().trim().min(1).max(500),
    observedAt: z.string().datetime({ offset: true }),
    sourceComplete: z.boolean().default(false),
    signals: z.array(actionSignalSchema).max(500),
  })
  .strict()
  .superRefine((input, context) => {
    const expected = producerKinds[input.producer];
    input.signals.forEach((signal, index) => {
      if (signal.kind !== expected)
        context.addIssue({
          code: "custom",
          path: ["signals", index, "kind"],
          message: `Expected ${expected} for producer ${input.producer}`,
        });
    });
  });

export type IngestActionSignalsInput = z.infer<typeof ingestActionSignalsSchema>;
export type ActionSignalProducer = z.infer<typeof actionSignalProducerSchema>;

export interface NormalizedActionCandidate {
  fingerprint: string;
  source: ActionSource;
  category: ActionCategory;
  affectedScope: ActionScope;
  severity: ActionItem["severity"];
  impact: ActionItem["impact"];
  confidence: ActionItem["confidence"];
  effort: ActionItem["effort"];
  title: string;
  description: string;
  evidence: ActionEvidence;
}

export interface NormalizedActionBatch {
  target: string;
  sourceTool: string;
  sourceComplete: boolean;
  candidates: NormalizedActionCandidate[];
}

const producerMetadata: Record<
  ActionSignalProducer,
  { source: ActionSource; sourceTool: string; resultType: ActionEvidence["sourceResult"]["type"] }
> = {
  crawler_regressions: {
    source: "crawler",
    sourceTool: "crawler_detect_regressions",
    resultType: "crawl_run",
  },
  webmaster_diagnostics: {
    source: "webmaster",
    sourceTool: "webmaster_get_diagnostics",
    resultType: "webmaster_response",
  },
  content_decay: {
    source: "metrica",
    sourceTool: "seo_detect_content_decay",
    resultType: "analysis_result",
  },
  cannibalization: {
    source: "seo_analysis",
    sourceTool: "seo_detect_cannibalization",
    resultType: "analysis_result",
  },
  content_gaps: {
    source: "query_intelligence",
    sourceTool: "query_intelligence_find_content_gaps",
    resultType: "analysis_result",
  },
  monitoring_alerts: {
    source: "monitoring",
    sourceTool: "monitor_check_alerts",
    resultType: "monitoring_snapshot",
  },
};

function level(
  severity: "info" | "warning" | "error" | "critical",
): Pick<NormalizedActionCandidate, "severity" | "impact"> {
  const impacts: Record<typeof severity, ActionItem["impact"]> = {
    info: "low",
    warning: "medium",
    error: "high",
    critical: "critical",
  };
  return {
    severity,
    impact: impacts[severity],
  };
}

function confidence(value: number): ActionItem["confidence"] {
  return value >= 0.85 ? "high" : value >= 0.6 ? "medium" : "low";
}

function cleanTarget(value: string, denylist: readonly string[]): string {
  return normalizeActionUrl(sanitizeStoredUrl(value, denylist));
}

function scope(
  target: string,
  urls: readonly string[],
  queries: readonly string[],
  denylist: readonly string[],
): ActionScope {
  const origin = new URL(target).origin;
  const normalizedUrls = [...new Set(urls.map((url) => cleanTarget(url, denylist)))].sort();
  if (normalizedUrls.some((url) => new URL(url).origin !== origin))
    throw new YandexApiError("VALIDATION", "Action signal URLs must use the target origin");
  const normalizedQueries = [...new Set(queries.map((query) => query.trim()))].sort();
  return {
    kind:
      normalizedUrls.length > 0 && normalizedQueries.length > 0
        ? "mixed"
        : normalizedUrls.length > 0
          ? "urls"
          : normalizedQueries.length > 0
            ? "queries"
            : "target",
    target,
    urls: normalizedUrls,
    queries: normalizedQueries,
  };
}

function candidate(
  base: Omit<NormalizedActionCandidate, "fingerprint" | "evidence"> & {
    signal: string;
    summary: string;
  },
  metadata: (typeof producerMetadata)[ActionSignalProducer],
  input: IngestActionSignalsInput,
): NormalizedActionCandidate {
  const { signal, summary, ...action } = base;
  const evidence: ActionEvidence = {
    sourceTool: metadata.sourceTool,
    sourceResult: { type: metadata.resultType, id: input.resultId },
    signal,
    observedAt: new Date(input.observedAt).toISOString(),
    summary,
  };
  return {
    ...action,
    fingerprint: createActionFingerprint({
      source: metadata.source,
      category: base.category,
      affectedScope: base.affectedScope,
      signal,
    }),
    source: metadata.source,
    evidence,
  };
}

export function normalizeActionSignals(
  rawInput: IngestActionSignalsInput,
  denylist: readonly string[] = DEFAULT_SECRET_QUERY_KEYS,
): NormalizedActionBatch {
  const input = ingestActionSignalsSchema.parse(rawInput);
  const target = cleanTarget(input.target, denylist);
  const metadata = producerMetadata[input.producer];
  const candidates = input.signals.flatMap((signal): NormalizedActionCandidate[] => {
    if (signal.kind === "monitoring_alert" && signal.code === "STABLE") return [];
    if (signal.kind === "crawler_regression") {
      const severity =
        signal.severity === "low"
          ? "info"
          : signal.severity === "medium"
            ? "warning"
            : signal.severity === "high"
              ? "error"
              : "critical";
      const affectedScope = scope(target, signal.affectedUrls, [], denylist);
      return [
        candidate(
          {
            source: metadata.source,
            category:
              signal.type === "NEW_NOINDEX" || signal.type === "CANONICAL_DRIFT"
                ? "indexing"
                : signal.type === "INTERNAL_LINK_LOSS" || signal.type === "NEW_ORPHAN_PAGE"
                  ? "internal_links"
                  : "technical",
            affectedScope,
            ...level(severity),
            confidence: confidence(signal.confidence),
            effort: signal.massChange ? "high" : "medium",
            title: `Crawl regression: ${signal.type}`,
            description: `${signal.affectedUrlCount} URL(s) are affected by ${signal.type}.`,
            signal: signal.type,
            summary: `${signal.type}: ${signal.affectedUrlCount} affected URL(s).`,
          },
          metadata,
          input,
        ),
      ];
    }
    if (signal.kind === "webmaster_diagnostic") {
      const affectedScope = scope(target, signal.affectedUrls, [], denylist);
      return [
        candidate(
          {
            source: metadata.source,
            category: "indexing",
            affectedScope,
            ...level(signal.severity),
            confidence: "high",
            effort: "medium",
            title: `Webmaster diagnostic: ${signal.code}`,
            description: `${signal.affectedUrlCount} URL(s) are associated with this diagnostic.`,
            signal: signal.code,
            summary: `${signal.code}: ${signal.affectedUrlCount} affected URL(s).`,
          },
          metadata,
          input,
        ),
      ];
    }
    if (signal.kind === "content_decay") {
      const severity =
        signal.severity === "SEVERE"
          ? "critical"
          : signal.severity === "HIGH"
            ? "error"
            : "warning";
      return [
        candidate(
          {
            source: metadata.source,
            category: "content",
            affectedScope: scope(target, [signal.url], [], denylist),
            ...level(severity),
            confidence: "medium",
            effort: "medium",
            title: "Organic content decay",
            description: `Organic visits fell by ${signal.dropPercent}% (${signal.previousVisits} to ${signal.currentVisits}).`,
            signal: "CONTENT_DECAY",
            summary: `Organic visits fell by ${signal.dropPercent}%.`,
          },
          metadata,
          input,
        ),
      ];
    }
    if (signal.kind === "cannibalization") {
      return [
        candidate(
          {
            source: metadata.source,
            category: "search_visibility",
            affectedScope: scope(target, signal.urls, [signal.query], denylist),
            ...level(signal.impressions >= 1_000 ? "error" : "warning"),
            confidence: "medium",
            effort: "medium",
            title: "Search-query cannibalization",
            description: `${signal.urls.length} pages compete for a query with ${signal.impressions} impressions.`,
            signal: "CANNIBALIZATION",
            summary: `${signal.urls.length} competing pages; ${signal.impressions} impressions.`,
          },
          metadata,
          input,
        ),
      ];
    }
    if (signal.kind === "content_gap") {
      return [...new Set(signal.gapTypes)].sort().map((gapType) =>
        candidate(
          {
            source: metadata.source,
            category: gapType === "TECHNICAL_BLOCKER" ? "technical" : "opportunity",
            affectedScope: scope(target, signal.urls, [signal.query], denylist),
            ...level(gapType === "TECHNICAL_BLOCKER" ? "error" : "warning"),
            confidence: "medium",
            effort: gapType === "MISSING_PAGE" ? "high" : "medium",
            title: `Content gap: ${gapType}`,
            description: `Coverage gap for a query with ${signal.impressions} impressions.`,
            signal: gapType,
            summary: `${gapType}: ${signal.impressions} impressions.`,
          },
          metadata,
          input,
        ),
      );
    }
    return [
      candidate(
        {
          source: metadata.source,
          category: "monitoring",
          affectedScope: scope(target, [], [], denylist),
          ...level(signal.severity),
          confidence: "medium",
          effort: "medium",
          title: `Monitoring alert: ${signal.code}`,
          description: `Monitoring threshold ${signal.code} was crossed.`,
          signal: signal.code,
          summary: `Monitoring alert ${signal.code}.`,
        },
        metadata,
        input,
      ),
    ];
  });
  return {
    target,
    sourceTool: metadata.sourceTool,
    sourceComplete: input.sourceComplete,
    candidates,
  };
}

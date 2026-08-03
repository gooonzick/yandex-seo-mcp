import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { CrawlSnapshotStore } from "../crawler/snapshot-store.js";
import type { MetricaClient } from "../metrica/client.js";
import type { WebmasterClient } from "../webmaster/client.js";
import { YandexApiError } from "../shared/errors.js";
import { createPaginationInputSchema } from "../shared/pagination.js";
import { handleTool } from "../shared/result.js";
import { telemetry } from "../shared/telemetry.js";
import { seoChangeTypeSchema } from "../storage/schema.js";
import type { SeoChangeStore } from "./change-store.js";
import { isTimezoneOffset, measureMetricaImpact } from "./metrica-impact.js";
import { measureWebmasterImpact } from "./webmaster-impact.js";

const recordChangeSchema = z.object({
  target: z.url(),
  timestamp: z.string().datetime({ offset: true }),
  type: seoChangeTypeSchema,
  urlScope: z.array(z.url()).max(500).default([]),
  description: z.string().trim().min(1).max(2_000),
  externalReference: z.string().trim().min(1).max(500),
  confirm: z.literal(true),
});

const listChangesSchema = createPaginationInputSchema(200, 50).extend({
  target: z.url().optional(),
  type: seoChangeTypeSchema.optional(),
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo: z.string().datetime({ offset: true }).optional(),
});

const compareChangeCrawlSchema = z.object({
  changeId: z.uuid(),
  exampleLimit: z.number().int().min(1).max(100).default(20),
});

const measureChangeMetricaSchema = z.object({
  changeId: z.uuid(),
  counterId: z.number().int().positive(),
  periodDays: z
    .number()
    .int()
    .min(7)
    .max(84)
    .refine((value) => value % 7 === 0, {
      message: "periodDays must be a whole number of weeks",
    })
    .default(28),
  minVisits: z.number().int().nonnegative().default(100),
  sourceLimit: z.number().int().min(1).max(10_000).default(1_000),
  resultLimit: z.number().int().min(1).max(100).default(25),
  timezone: z
    .string()
    .refine(isTimezoneOffset, { message: "Expected timezone offset ±HH:MM" })
    .default("+00:00"),
  goalId: z.number().int().positive().optional(),
  accuracy: z.union([z.literal("full"), z.number().min(0).max(1)]).optional(),
});

const measureChangeWebmasterSchema = z.object({
  changeId: z.uuid(),
  hostId: z.string().min(1).max(2_000),
  periodDays: z.number().int().min(1).max(7).default(3),
  dataDelayDays: z.number().int().min(0).max(14).default(2),
  minImpressions: z.number().int().nonnegative().default(100),
  sourceLimit: z.number().int().min(1).max(500).default(500),
  resultLimit: z.number().int().min(1).max(100).default(25),
  deviceType: z.enum(["ALL", "DESKTOP", "MOBILE_AND_TABLET", "MOBILE", "TABLET"]).default("ALL"),
  searchLocation: z
    .enum([
      "ALL_LOCATIONS",
      "ALL_LOCATIONS_ORGANIC",
      "WEB_LOCATION",
      "DYNAMIC_LOCATION_ALL",
      "DYNAMIC_LOCATION_BASIC",
      "DYNAMIC_LOCATION_ADDITIONAL",
    ])
    .default("WEB_LOCATION"),
  regionIds: z.array(z.number().int().positive()).max(100).optional(),
});

export function registerSeoImpactTools(
  server: McpServer,
  store: SeoChangeStore,
  crawlSnapshots: CrawlSnapshotStore,
  metrica: MetricaClient,
  webmaster: WebmasterClient,
  config: AppConfig,
): void {
  const limits = { maxRows: config.maxResultRows, maxBytes: config.maxResultBytes };
  server.registerTool(
    "seo_record_change",
    {
      title: "Record an SEO change",
      description:
        "Idempotently append one bounded SEO change journal entry. Requires explicit confirmation and accepts no arbitrary payload.",
      inputSchema: recordChangeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      handleTool(async () => {
        const result = await store.record(input);
        telemetry.event(result.created ? "seo_change_recorded" : "seo_change_idempotent");
        return result;
      }, limits),
  );
  server.registerTool(
    "seo_list_changes",
    {
      title: "List SEO changes",
      description:
        "List bounded journal entries filtered by normalized target, type and inclusive timestamp range.",
      inputSchema: listChangesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) =>
      handleTool(async () => {
        const page = await store.list(input);
        telemetry.event("seo_changes_listed");
        return { changes: page.items, pageInfo: page.pageInfo };
      }, limits),
  );
  server.registerTool(
    "seo_compare_change_crawl",
    {
      title: "Compare crawls around an SEO change",
      description:
        "Compare the nearest saved crawls before and after a journaled SEO change, filtered to its URL scope and relevant technical fields.",
      inputSchema: compareChangeCrawlSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (input) =>
      handleTool(async () => {
        const change = await store.get(input.changeId);
        if (!change) throw new YandexApiError("NOT_FOUND", "SEO change was not found");
        const result = await crawlSnapshots.compareForChange(change, input.exampleLimit);
        telemetry.event(
          result.status === "compared"
            ? "seo_change_crawl_compared"
            : "seo_change_crawl_insufficient_data",
        );
        return result;
      }, limits),
  );
  server.registerTool(
    "seo_measure_change_metrica",
    {
      title: "Measure an SEO change in Metrica",
      description:
        "Compare equal whole-week organic periods around a journaled change and report observational traffic, conversion and landing-page evidence without claiming causality.",
      inputSchema: measureChangeMetricaSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const change = await store.get(input.changeId);
        if (!change) throw new YandexApiError("NOT_FOUND", "SEO change was not found");
        const result = await measureMetricaImpact(metrica, change, input);
        telemetry.event(
          result.status === "measured"
            ? "seo_change_metrica_measured"
            : "seo_change_metrica_insufficient_data",
        );
        return result;
      }, limits),
  );
  server.registerTool(
    "seo_measure_change_webmaster",
    {
      title: "Measure an SEO change in Webmaster",
      description:
        "Compare URL-scoped Yandex search visibility and target-level indexing events around a journaled change, with explicit data-delay and confidence limits.",
      inputSchema: measureChangeWebmasterSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input) =>
      handleTool(async () => {
        const change = await store.get(input.changeId);
        if (!change) throw new YandexApiError("NOT_FOUND", "SEO change was not found");
        const result = await measureWebmasterImpact(webmaster, change, input);
        telemetry.event(
          result.status === "measured"
            ? "seo_change_webmaster_measured"
            : "seo_change_webmaster_insufficient_data",
        );
        return result;
      }, limits),
  );
}

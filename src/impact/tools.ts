import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { CrawlSnapshotStore } from "../crawler/snapshot-store.js";
import { YandexApiError } from "../shared/errors.js";
import { createPaginationInputSchema } from "../shared/pagination.js";
import { handleTool } from "../shared/result.js";
import { telemetry } from "../shared/telemetry.js";
import { seoChangeTypeSchema } from "../storage/schema.js";
import type { SeoChangeStore } from "./change-store.js";

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

export function registerSeoImpactTools(
  server: McpServer,
  store: SeoChangeStore,
  crawlSnapshots: CrawlSnapshotStore,
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
}

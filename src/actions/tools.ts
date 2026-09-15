import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import { handleTool, type ResultLimits } from "../shared/result.js";
import { normalizeActionSignals, ingestActionSignalsSchema } from "./normalizers.js";
import { ActionStore } from "./store.js";

export function registerActionTools(
  server: McpServer,
  store: ActionStore,
  config: AppConfig,
): void {
  const limits: ResultLimits = {
    maxRows: config.maxResultRows,
    maxBytes: config.maxResultBytes,
  };
  server.registerTool(
    "seo_ingest_action_signals",
    {
      title: "Normalize and ingest SEO action signals",
      description:
        "Persist bounded signals from crawler regressions, Webmaster diagnostics, content decay, cannibalization, content gaps or monitoring alerts. sourceComplete confirms that absent signals may be resolved.",
      inputSchema: ingestActionSignalsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      handleTool(async () => {
        const result = await store.sync(
          normalizeActionSignals(input, config.crawlerSnapshotQueryDenylist),
        );
        return {
          summary: {
            created: result.created,
            updated: result.updated,
            unchanged: result.unchanged,
            reopened: result.reopened,
            resolved: result.resolved,
          },
          actions: result.actions.map((action) => ({
            id: action.id,
            fingerprint: action.fingerprint,
            status: action.status,
          })),
        };
      }, limits),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YandexApiError } from "../shared/errors.js";
import { handleTool, type ResultLimits } from "../shared/result.js";
import type { WordstatClient } from "./client.js";

const filters = {
  phrase: z.string().trim().min(1).max(400),
  regions: z
    .array(z.string().regex(/^\d+$/))
    .max(100)
    .optional()
    .describe("Yandex region IDs, e.g. ['213'] for Moscow. Omit for all regions."),
  devices: z
    .array(z.enum(["DEVICE_ALL", "DEVICE_DESKTOP", "DEVICE_PHONE", "DEVICE_TABLET"]))
    .max(3)
    .optional(),
};
const availability = "Yandex currently reports statistics only through 2026-10-07.";
const annotations = { readOnlyHint: true, openWorldHint: true };

export function registerWordstatTools(
  server: McpServer,
  client: WordstatClient,
  limits: ResultLimits,
) {
  server.registerTool(
    "wordstat_expand_queries",
    {
      title: "Expand queries with Yandex Wordstat",
      description: `Get matching and related phrases with their search counts from Wordstat's 30-day report. ${availability}`,
      annotations,
      inputSchema: z.object({
        ...filters,
        numPhrases: z.number().int().min(1).max(2000).default(50),
      }),
    },
    ({ numPhrases, ...params }) =>
      handleTool(
        () =>
          client.request("topRequests", {
            ...params,
            numPhrases: String(Math.min(numPhrases, limits.maxRows)),
          }),
        limits,
      ),
  );

  server.registerTool(
    "wordstat_get_demand",
    {
      title: "Get Yandex Wordstat demand over time",
      description: `Get search counts and shares by day, week or month. Weekly and monthly reports require complete calendar periods. ${availability}`,
      annotations,
      inputSchema: z.object({
        ...filters,
        period: z.enum(["PERIOD_DAILY", "PERIOD_WEEKLY", "PERIOD_MONTHLY"]),
        fromDate: z.iso.date().describe("Inclusive start date, YYYY-MM-DD."),
        toDate: z.iso.date().describe("Inclusive end date, YYYY-MM-DD."),
      }),
    },
    ({ fromDate, toDate, ...params }) =>
      handleTool(() => {
        if (fromDate > toDate)
          throw new YandexApiError("VALIDATION", "fromDate must be on or before toDate.");
        const start = new Date(fromDate);
        const end = new Date(toDate);
        if (
          params.period === "PERIOD_WEEKLY" &&
          (start.getUTCDay() !== 1 || end.getUTCDay() !== 0)
        ) {
          throw new YandexApiError(
            "VALIDATION",
            "Weekly periods start on Monday and end on Sunday.",
          );
        }
        if (params.period === "PERIOD_MONTHLY") {
          end.setUTCDate(end.getUTCDate() + 1);
          if (start.getUTCDate() !== 1 || end.getUTCDate() !== 1)
            throw new YandexApiError(
              "VALIDATION",
              "Monthly periods must start on the first and end on the last day of a month.",
            );
        }
        return client.request("dynamics", {
          ...params,
          fromDate: `${fromDate}T00:00:00Z`,
          toDate: `${toDate}T00:00:00Z`,
        });
      }, limits),
  );
}

import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { YandexApiError } from "../shared/errors.js";
import { errorResult } from "../shared/result.js";
import type { DirectClient } from "./client.js";
import { stringifyDirectJson } from "./json.js";

const object = z.record(z.string(), z.unknown());
const id = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n, "ID exceeds int64"),
]);
const ids = z.array(id).min(1).max(1000);
const fields = z.array(z.string().min(1)).min(1).max(100);
const writeOptions = { dryRun: z.boolean().default(true), confirm: z.boolean().default(false) };
const services = [
  "campaigns",
  "adgroups",
  "ads",
  "keywords",
  "keywordbids",
  "bidmodifiers",
  "sitelinks",
  "adextensions",
  "adimages",
  "creatives",
  "vcards",
  "negativekeywordsharedsets",
  "retargetinglists",
  "audiencetargets",
  "feeds",
  "clients",
  "agencyclients",
  "dictionaries",
] as const;

export function registerDirectTools(
  server: McpServer,
  client: DirectClient,
  config: AppConfig,
): void {
  const limits = { maxRows: config.maxResultRows, maxBytes: config.maxResultBytes };
  const run = async (operation: () => Promise<unknown>) => {
    try {
      const data = await operation();
      // The shared result formatter limits text only. Bound structured Direct data too.
      const text = JSON.stringify(data, null, 2);
      if (Buffer.byteLength(text, "utf8") > limits.maxBytes) {
        throw new YandexApiError(
          "YANDEX_API",
          "Direct result exceeds output limit; narrow fields, page size or date range. If this was a write, inspect the affected objects before retrying.",
        );
      }
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: data as Record<string, unknown>,
        ...(data && typeof data === "object" && "partialFailure" in data && data.partialFailure
          ? { isError: true }
          : {}),
      };
    } catch (error) {
      return errorResult(error);
    }
  };
  const read = <T extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: T,
    operation: (input: z.output<z.ZodObject<T>>) => Promise<unknown>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.object(shape) as z.ZodObject<z.ZodRawShape>,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      (input) => run(() => operation(input as z.output<z.ZodObject<T>>)),
    );
  };
  const mutate = async (
    service: string,
    method: string,
    params: Record<string, unknown>,
    options: { dryRun: boolean; confirm: boolean },
    version: "v5" | "v501" = "v501",
  ) => {
    stringifyDirectJson(params);
    if (options.dryRun)
      return {
        dryRun: true,
        service,
        method,
        version,
        params,
        sandbox: config.directSandbox ?? false,
        clientLogin: config.directClientLogin ?? null,
      };
    if (!options.confirm)
      throw new YandexApiError(
        "VALIDATION",
        "Set confirm=true and dryRun=false to execute this Direct change",
      );
    return client.rpc(service, method, params, version);
  };
  const write = <T extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: T,
    service: string,
    method: string,
    params: (input: z.output<z.ZodObject<T>>) => Record<string, unknown>,
  ) => {
    server.registerTool(
      name,
      {
        description: `${description} Defaults to dryRun; execution requires dryRun=false and confirm=true. Money in native API payloads is in millionths of the account currency.`,
        inputSchema: z.object({ ...shape, ...writeOptions }) as z.ZodObject<z.ZodRawShape>,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      (input) =>
        run(() =>
          mutate(
            service,
            method,
            params(z.object(shape).parse(input)),
            input as { dryRun: boolean; confirm: boolean },
          ),
        ),
    );
  };

  read("direct_ping", "Check Direct authorization with one minimal campaigns request.", {}, () =>
    client.rpc("campaigns", "get", {
      SelectionCriteria: {},
      FieldNames: ["Id"],
      Page: { Limit: 1, Offset: 0 },
    }),
  );
  read(
    "direct_get_client",
    "Get account currency, restrictions and client settings.",
    { fieldNames: fields.default(["ClientId", "Login", "Currency", "Restrictions"]) },
    ({ fieldNames }) => client.rpc("clients", "get", { FieldNames: fieldNames }),
  );

  const listShape = {
    selectionCriteria: object.default({}),
    fieldNames: fields.optional(),
    additionalFields: z.record(z.string().regex(/^[A-Za-z]+FieldNames$/), fields).default({}),
    limit: z
      .number()
      .int()
      .min(1)
      .max(Math.min(config.maxResultRows, 1000))
      .default(Math.min(config.maxResultRows, 100)),
    offset: z.number().int().nonnegative().default(0),
  };
  for (const [service, defaults] of [
    ["campaigns", ["Id", "Name", "Type", "State", "Status", "DailyBudget"]],
    ["adgroups", ["Id", "Name", "CampaignId", "Status", "RegionIds"]],
    ["ads", ["Id", "AdGroupId", "CampaignId", "State", "Status", "Type"]],
    ["keywords", ["Id", "Keyword", "AdGroupId", "CampaignId", "State", "Status"]],
    ["bidmodifiers", ["Id", "CampaignId", "AdGroupId", "Level", "Type"]],
  ] as const) {
    read(
      `direct_list_${service}`,
      `List ${service} using native SelectionCriteria keys (Ids, CampaignIds, AdGroupIds, States). Supply an explicit selection for child objects. Use additionalFields for TextAdFieldNames, UnifiedCampaignFieldNames, etc. result.LimitedBy is the next offset; stop when absent. Large IDs are returned as strings.`,
      listShape,
      ({ selectionCriteria, fieldNames, additionalFields, limit, offset }) => {
        if (service !== "campaigns" && Object.keys(selectionCriteria).length === 0)
          throw new YandexApiError("VALIDATION", "Select explicit IDs, campaigns or ad groups");
        return client.rpc(service, "get", {
          ...additionalFields,
          SelectionCriteria: selectionCriteria,
          FieldNames: fieldNames ?? defaults,
          Page: { Limit: limit, Offset: offset },
        });
      },
    );
  }

  read(
    "direct_get_campaign",
    "Get a campaign with strategy, funds, negatives and excluded sites (including unified campaigns).",
    { campaignId: id },
    ({ campaignId }) =>
      client.rpc("campaigns", "get", {
        SelectionCriteria: { Ids: [campaignId] },
        FieldNames: [
          "Id",
          "Name",
          "Type",
          "State",
          "Status",
          "DailyBudget",
          "Currency",
          "NegativeKeywords",
          "ExcludedSites",
          "Funds",
        ],
        TextCampaignFieldNames: ["BiddingStrategy", "CounterIds", "Settings"],
        UnifiedCampaignFieldNames: ["BiddingStrategy", "CounterIds", "Settings"],
      }),
  );
  for (const [name, field] of [
    ["negatives", "NegativeKeywords"],
    ["excluded_sites", "ExcludedSites"],
    ["funds", "Funds"],
  ] as const) {
    read(
      `direct_get_${name}`,
      `Get campaign ${field}. Funds are campaign/account amounts as supplied by Direct in micros.`,
      { campaignIds: ids },
      ({ campaignIds }) =>
        client.rpc("campaigns", "get", {
          SelectionCriteria: { Ids: campaignIds },
          FieldNames: ["Id", "Name", field],
        }),
    );
  }
  for (const service of [
    "keywordbids",
    "sitelinks",
    "adextensions",
    "adimages",
    "creatives",
    "vcards",
    "negativekeywordsharedsets",
    "retargetinglists",
    "audiencetargets",
    "feeds",
    "agencyclients",
    "dictionaries",
  ] as const) {
    read(
      `direct_get_${service}`,
      `Call ${service}.get with native API params. Specify FieldNames/SelectionCriteria (DictionaryNames for dictionaries). Preserves API pagination and item fields.`,
      { params: object },
      ({ params }) => client.rpc(service, "get", params),
    );
  }

  for (const [service, collection, methods] of [
    ["campaigns", "Campaigns", ["add", "update"]],
    ["adgroups", "AdGroups", ["add", "update"]],
    ["ads", "Ads", ["add", "update"]],
    ["keywords", "Keywords", ["add", "update"]],
    ["bidmodifiers", "BidModifiers", ["add", "set"]],
    ["sitelinks", "SitelinksSets", ["add"]],
    ["adextensions", "AdExtensions", ["add"]],
    ["adimages", "AdImages", ["add"]],
    ["vcards", "VCards", ["add"]],
    ["negativekeywordsharedsets", "NegativeKeywordSharedSets", ["add", "update"]],
    ["retargetinglists", "RetargetingLists", ["add", "update"]],
    ["audiencetargets", "AudienceTargets", ["add"]],
    ["audiencetargets", "Bids", ["setBids"]],
    ["feeds", "Feeds", ["add", "update"]],
    ["keywordbids", "KeywordBids", ["set"]],
  ] as const) {
    for (const method of methods) {
      write(
        `direct_${method === "setBids" ? "set_bids" : method}_${service}`,
        `Call ${service}.${method}. items contains native ${collection} objects; fields depend on campaign/ad type. For update/set supply each object's Id (KeywordId for keywordbids). Inspect partial errors before retrying.`,
        { items: z.array(object).min(1).max(Math.min(1000, config.maxResultRows)) },
        service,
        method,
        ({ items }) => ({ [collection]: items }),
      );
    }
  }
  for (const [service, methods] of [
    ["campaigns", ["suspend", "resume", "archive", "unarchive", "delete"]],
    ["adgroups", ["delete"]],
    ["ads", ["suspend", "resume", "archive", "unarchive", "moderate", "delete"]],
    ["keywords", ["suspend", "resume", "delete"]],
    ["bidmodifiers", ["delete"]],
    ["sitelinks", ["delete"]],
    ["adextensions", ["delete"]],
    ["vcards", ["delete"]],
    ["negativekeywordsharedsets", ["delete"]],
    ["retargetinglists", ["delete"]],
    ["audiencetargets", ["delete"]],
    ["feeds", ["delete"]],
  ] as const) {
    for (const method of methods)
      write(
        `direct_${method}_${service}`,
        `${method} explicit ${service} IDs.`,
        { ids },
        service,
        method,
        (input) => ({ SelectionCriteria: { Ids: input.ids } }),
      );
  }

  write(
    "direct_set_daily_budget",
    "Replace a campaign daily budget. amount is in account currency units (not micros).",
    {
      campaignId: id,
      amount: z
        .number()
        .positive()
        .max(Number.MAX_SAFE_INTEGER / 1_000_000),
      mode: z.enum(["STANDARD", "DISTRIBUTED"]).default("STANDARD"),
    },
    "campaigns",
    "update",
    ({ campaignId, amount, mode }) => ({
      Campaigns: [
        { Id: campaignId, DailyBudget: { Amount: Math.round(amount * 1_000_000), Mode: mode } },
      ],
    }),
  );
  for (const [name, service, collection, field] of [
    ["negatives", "campaigns", "Campaigns", "NegativeKeywords"],
    ["excluded_sites", "campaigns", "Campaigns", "ExcludedSites"],
    ["group_negatives", "adgroups", "AdGroups", "NegativeKeywords"],
  ] as const) {
    write(
      `direct_set_${name}`,
      `Replace the entire ${field} list. Empty items clears it. Read the current list before changing it.`,
      { id, items: z.array(z.string().min(1)).max(1000) },
      service,
      "update",
      (input) => ({
        [collection]: [
          { Id: input.id, [field]: input.items.length ? { Items: input.items } : null },
        ],
      }),
    );
  }
  write(
    "direct_set_regions",
    "Replace ad group RegionIds. Negative IDs exclude regions.",
    {
      adGroupId: id,
      regionIds: z
        .array(z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER))
        .min(1)
        .max(1000),
    },
    "adgroups",
    "update",
    ({ adGroupId, regionIds }) => ({ AdGroups: [{ Id: adGroupId, RegionIds: regionIds }] }),
  );
  write(
    "direct_set_strategy",
    "Replace Search/Network bidding strategy for a TEXT_CAMPAIGN or UNIFIED_CAMPAIGN. strategy uses the native BiddingStrategy object; budgets and bids are micros. Fetch the existing strategy first.",
    {
      campaignId: id,
      campaignType: z.enum(["TEXT_CAMPAIGN", "UNIFIED_CAMPAIGN"]),
      strategy: object,
    },
    "campaigns",
    "update",
    ({ campaignId, campaignType, strategy }) => ({
      Campaigns: [
        {
          Id: campaignId,
          [campaignType === "UNIFIED_CAMPAIGN" ? "UnifiedCampaign" : "TextCampaign"]: {
            BiddingStrategy: strategy,
          },
        },
      ],
    }),
  );

  // A fixed service list prevents URL/header injection. Unknown methods remain writes.
  server.registerTool(
    "direct_rpc",
    {
      description:
        "Advanced Direct v5/v501 call with native params. Only method=get is read-only. Every other method defaults to a dry-run plan and requires confirm=true, dryRun=false. Reports use direct_report_raw. No automatic retry for writes.",
      inputSchema: z.object({
        service: z.enum(services),
        method: z.string().regex(/^[a-zA-Z]+$/),
        params: object,
        version: z.enum(["v5", "v501"]).default("v501"),
        ...writeOptions,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ service, method, params, version, dryRun, confirm }) =>
      run(() =>
        method === "get"
          ? client.rpc(service, method, params, version)
          : mutate(service, method, params, { dryRun, confirm }, version),
      ),
  );

  const date = z.iso.date();
  const reportShape = {
    dateFrom: date,
    dateTo: date,
    campaignIds: ids.optional(),
    includeVat: z.boolean().default(true),
    fieldNames: fields.optional(),
  };
  for (const [name, type, defaultFields] of [
    [
      "direct_report",
      "CAMPAIGN_PERFORMANCE_REPORT",
      [
        "Date",
        "CampaignId",
        "CampaignName",
        "Impressions",
        "Clicks",
        "Cost",
        "Ctr",
        "AvgCpc",
        "Conversions",
      ],
    ],
    [
      "direct_report_search_queries",
      "SEARCH_QUERY_PERFORMANCE_REPORT",
      ["Query", "CampaignId", "AdGroupId", "Impressions", "Clicks", "Cost"],
    ],
    [
      "direct_report_breakdown",
      "CUSTOM_REPORT",
      ["Date", "CampaignId", "AdNetworkType", "Device", "Impressions", "Clicks", "Cost"],
    ],
  ] as const) {
    read(
      name,
      "Direct statistics for an explicit date range. fieldNames can customize dimensions/metrics. Money is in account currency; rows remain strings. If status=pending, repeat identical arguments after retryAfterSeconds. Conversions reflect configured goals, not necessarily sales.",
      reportShape,
      ({ dateFrom, dateTo, campaignIds, includeVat, fieldNames }) => {
        if (dateFrom > dateTo)
          throw new YandexApiError("VALIDATION", "dateFrom must not be after dateTo");
        const spec: Record<string, unknown> = {
          SelectionCriteria: {
            DateFrom: dateFrom,
            DateTo: dateTo,
            ...(campaignIds
              ? {
                  Filter: [
                    { Field: "CampaignId", Operator: "IN", Values: campaignIds.map(String) },
                  ],
                }
              : {}),
          },
          FieldNames: fieldNames ?? defaultFields,
          ReportType: type,
          DateRangeType: "CUSTOM_DATE",
          Format: "TSV",
          IncludeVAT: includeVat ? "YES" : "NO",
          IncludeDiscount: "NO",
        };
        spec.ReportName = `mcp_${createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 24)}`;
        return client.report(spec, config.maxResultRows);
      },
    );
  }
  read(
    "direct_report_raw",
    "Submit or resume an exact native Reports specification. Reuse the same spec/ReportName on pending responses. Use FieldNames, SelectionCriteria.Filter, Goals, AttributionModels and OrderBy as documented by Direct.",
    {
      spec: z
        .object({
          ReportName: z.string().min(1).max(255),
          ReportType: z.enum([
            "ACCOUNT_PERFORMANCE_REPORT",
            "CAMPAIGN_PERFORMANCE_REPORT",
            "ADGROUP_PERFORMANCE_REPORT",
            "AD_PERFORMANCE_REPORT",
            "CRITERIA_PERFORMANCE_REPORT",
            "CUSTOM_REPORT",
            "SEARCH_QUERY_PERFORMANCE_REPORT",
            "REACH_AND_FREQUENCY_PERFORMANCE_REPORT",
          ]),
          DateRangeType: z.string().min(1),
          SelectionCriteria: object,
          FieldNames: fields,
          Format: z.literal("TSV").default("TSV"),
          IncludeVAT: z.enum(["YES", "NO"]).default("YES"),
          IncludeDiscount: z.enum(["YES", "NO"]).default("NO"),
        })
        .catchall(z.unknown()),
    },
    ({ spec }) => client.report(spec, config.maxResultRows),
  );
}

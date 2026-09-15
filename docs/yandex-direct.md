# Yandex Direct

Direct runs in the same MCP server as Metrica and Webmaster, over stdio or HTTP.
The feature scope was inspired by [gmen1057/yandex-direct-mcp](https://github.com/gmen1057/yandex-direct-mcp).
This is an independent TypeScript implementation using this project's configuration,
MCP responses and confirmation conventions; tool arguments are not a drop-in copy.

## Setup

Configure a user OAuth token with access to the Yandex Direct API and an application
approved for Direct API access:

```text
YANDEX_DIRECT_TOKEN=your-token
# Optional: for an agency acting on behalf of an advertiser
YANDEX_DIRECT_CLIENT_LOGIN=advertiser-login
YANDEX_DIRECT_SANDBOX=false
```

`YANDEX_OAUTH_TOKEN` is the fallback if the Direct-specific token is absent. A shared
token must have Direct permissions in addition to the permissions for other services.
Omit `YANDEX_DIRECT_CLIENT_LOGIN` when unused. Restart the MCP process after changing
its environment. Use `direct_ping` or `yandex_connection_check` to check access;
`yandex_capabilities` reports whether a token is configured without making API calls.

Set `YANDEX_DIRECT_SANDBOX=true` to use the Direct sandbox. The normal endpoint is
`https://api.direct.yandex.com/json/v501/`; Reports use `/json/v5/reports`.
`direct_rpc` also accepts `version: "v5"` for explicit compatibility calls.

HTTP OAuth profile sessions use the profile's access token. They do not inherit the
server operator's Direct token or agency client login. Agency client selection through
per-profile configuration is not currently supported; use a separately configured server.

## Tools

| Area                   | Tools                                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connectivity/account   | `direct_ping`, `direct_get_client`                                                                                                                                                                                                                                     |
| Campaigns              | `direct_list_campaigns`, `direct_get_campaign`, `direct_add_campaigns`, `direct_update_campaigns`, `direct_suspend_campaigns`, `direct_resume_campaigns`, `direct_archive_campaigns`, `direct_unarchive_campaigns`, `direct_delete_campaigns`                          |
| Budget/strategy        | `direct_get_funds`, `direct_set_daily_budget`, `direct_set_strategy`                                                                                                                                                                                                   |
| Groups                 | `direct_list_adgroups`, `direct_add_adgroups`, `direct_update_adgroups`, `direct_delete_adgroups`, `direct_set_regions`                                                                                                                                                |
| Ads                    | `direct_list_ads`, `direct_add_ads`, `direct_update_ads`, `direct_suspend_ads`, `direct_resume_ads`, `direct_archive_ads`, `direct_unarchive_ads`, `direct_moderate_ads`, `direct_delete_ads`                                                                          |
| Keywords/autotargeting | `direct_list_keywords`, `direct_add_keywords`, `direct_update_keywords`, `direct_suspend_keywords`, `direct_resume_keywords`, `direct_delete_keywords`                                                                                                                 |
| Bids                   | `direct_get_keywordbids`, `direct_set_keywordbids`, `direct_list_bidmodifiers`, `direct_add_bidmodifiers`, `direct_set_bidmodifiers`, `direct_delete_bidmodifiers`                                                                                                     |
| Negatives/placements   | `direct_get_negatives`, `direct_set_negatives`, `direct_get_excluded_sites`, `direct_set_excluded_sites`, `direct_set_group_negatives`                                                                                                                                 |
| Extensions/images      | `direct_get_sitelinks`, `direct_add_sitelinks`, `direct_delete_sitelinks`, `direct_get_adextensions`, `direct_add_adextensions`, `direct_delete_adextensions`, `direct_get_adimages`, `direct_add_adimages`, `direct_get_creatives`                                    |
| Other native services  | `direct_get_*`, `direct_add_*`, `direct_update_*` and `direct_delete_*` where supported for shared negative keyword sets, retargeting lists, feeds and vCards; audience targets support get/add/delete/set_bids; `direct_get_agencyclients`, `direct_get_dictionaries` |
| Statistics             | `direct_report`, `direct_report_breakdown`, `direct_report_search_queries`, `direct_report_raw`                                                                                                                                                                        |
| Advanced API           | `direct_rpc` for explicit service/method/params calls                                                                                                                                                                                                                  |

Complex inputs use the native Direct field names, allowing campaign/ad-specific
settings without flattening or dropping fields. For example, `direct_update_keywords`
accepts native `AutotargetingCategories`, and `direct_update_ads` accepts native
creative fields. The upstream API validates these type-specific payloads; a local
dry-run is a preview, not proof that Direct will accept a change.

There is no automatic multi-step launch pack or local campaign-to-project map.
Create a campaign, groups, keywords and ads through separate calls, inspecting each
result before continuing. Select explicit campaign/group/object IDs for changes.

## Examples

List campaigns, including unified campaign strategies:

```json
{
  "name": "direct_list_campaigns",
  "arguments": {
    "selectionCriteria": {},
    "additionalFields": { "UnifiedCampaignFieldNames": ["BiddingStrategy"] },
    "limit": 100,
    "offset": 0
  }
}
```

List ads in one campaign:

```json
{
  "name": "direct_list_ads",
  "arguments": {
    "selectionCriteria": { "CampaignIds": [123456] },
    "additionalFields": { "TextAdFieldNames": ["Title", "Text", "Href"] },
    "limit": 100
  }
}
```

When `result.LimitedBy` is present, use it as `offset` for the next call. List tools
cap their page size at `YANDEX_MAX_RESULT_ROWS` (at most 1000). Advanced `get`/RPC
calls accept native pagination parameters; supply `Page` when the service supports it.
Nested settings arrays and partial mutation results are preserved intact.

Preview a daily budget change:

```json
{
  "name": "direct_set_daily_budget",
  "arguments": { "campaignId": 123456, "amount": 1500 }
}
```

Execute the reviewed change by adding `"dryRun": false, "confirm": true` to the
same arguments. All mutation tools, including raw RPC methods other than `get`,
follow this rule. MCP annotations identify those tools as potentially destructive.
`confirm` is an application-level guard; callers must still obtain user authorization.

`direct_set_daily_budget.amount` is in account currency units. Monetary values in
native `items`/`params` (budgets, bids, strategy spend limits) are **micros**:
1 currency unit = 1,000,000. This is not necessarily RUB. Report money is returned
in account currency units. IDs larger than JavaScript's safe integer range must be
passed as decimal strings; the HTTP serializer sends exact numeric int64 values.

`direct_set_negatives`, `direct_set_group_negatives`, `direct_set_excluded_sites`
and `direct_set_regions` replace their entire lists; read existing values first.
Empty `items` clears negatives or excluded sites.

Get search-query statistics:

```json
{
  "name": "direct_report_search_queries",
  "arguments": {
    "dateFrom": "2026-09-01",
    "dateTo": "2026-09-14",
    "campaignIds": [123456]
  }
}
```

Reports may return `status: "pending"` and `retryAfterSeconds`. Repeat the exact
same arguments after that delay. Preset tools derive a stable report name; raw
reports require you to reuse the identical `spec`, including `ReportName`.
Ready reports preserve TSV values as strings, expose `totalRows` and `truncated`,
and return at most `YANDEX_MAX_RESULT_ROWS` rows. Use narrower periods/filters
when truncated. Conversion metrics reflect configured attribution and goals.

## Errors and limits

- Requests use the shared timeout/retry configuration and at most two concurrent
  Direct connections. Direct reads have no local cache.
- Transient HTTP/network failures are retried only for reads. Mutations are never
  automatically retried, because the server might already have applied them.
- API errors inside HTTP 200 responses are treated as failures. Error codes and
  `RequestId` are returned without echoing upstream error text.
- Per-item `Errors` make the MCP response `isError: true`, with `partialFailure: true`.
  Successful IDs, warnings and failed item details remain available. Retry only the
  failed items after inspecting the result, never the entire batch blindly.
- Responses are bounded to 10 MB before parsing, and both MCP text and structured
  results are bounded by `YANDEX_MAX_RESULT_BYTES`. Oversized results produce an
  explicit error. A write may already have succeeded if its response is too large;
  inspect affected objects before retrying.
- `Units` and `RequestId` are returned per request for quota tracking and support.

## API references

- [Authorization and headers](https://yandex.com/dev/direct/doc/en/concepts/headers)
- [Campaigns and unified campaigns](https://yandex.com/dev/direct/doc/en/objects/campaign)
- [Pagination](https://yandex.com/dev/direct/doc/en/get)
- [Report generation](https://yandex.com/dev/direct/doc/en/how-to)
- [Report headers and monetary values](https://yandex.com/dev/direct/doc/en/headers)

Automated tests mock Direct responses; live authorization, moderation and account-specific
restrictions require a configured Direct account and are not asserted by those tests.

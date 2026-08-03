# Cursor pagination contract

Status: implemented by `ENG-002` on 2026-08-03.

## MCP shape

All new pageable MCP tools use the same input fields:

```json
{ "limit": 50, "cursor": "optional-opaque-value" }
```

The collection keeps its domain name and is accompanied by common metadata:

```json
{
  "snapshots": [],
  "pageInfo": { "limit": 50, "hasMore": false, "nextCursor": null }
}
```

`limit` is a positive integer with a tool-specific default and a hard contract
maximum no greater than 500. `cursor` is optional, opaque to clients and bounded
to 2,048 characters. `nextCursor` is non-null only when `hasMore` is true.

## Cursor identity and validation

Cursor payload version `v1` stores only the resource/filter scope hash, ordering
direction and last stable key. The scope is a SHA-256 digest of the resource name
and recursively canonicalized filters, so filter values are not exposed in the
cursor. Ordering is part of the payload. A malformed cursor or one reused with
different filters/order returns normalized `VALIDATION` and instructs the caller
to restart without a cursor.

Cursors contain no credentials or authorization state and do not grant access.
Every page request must apply the same authentication and target-level access
checks as its first page.

## Stable ordering

Pagination is keyset-based rather than offset-based. Every collection must define
an immutable, unique lexical key and an explicit ascending or descending order.
Timestamp collections use `timestamp + NUL + stable ID`, preventing collisions
when records share a timestamp. New records inserted before the cursor do not
shift or duplicate records on later pages; deleted records are naturally skipped.

`monitor_list_snapshots` orders monitoring snapshots by `capturedAt + ID`
descending and binds cursors to the optional target filter.
`crawler_list_snapshots` uses finished timestamp + run ID descending and binds
target/date filters; detailed crawl sections use section-specific ascending keys.
Future actions, jobs and bounded API selections must use the same helpers and
response metadata.

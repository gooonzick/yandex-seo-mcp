# Crawl snapshot storage

Status: storage model and snapshot persistence implemented by `CRWL-001` and
`CRWL-002` on 2026-08-03.

## Container and migrations

The local snapshot file is a versioned JSON container. Schema `v2` keeps legacy
monitoring snapshots and crawl history together:

```text
StorageData
├── version: 2
├── monitoringSnapshots[]
└── crawl
    ├── runs[]
    ├── pages[]
    ├── issues[]
    ├── links[]
    └── aggregates[]
```

`migrateStorage` is the only read entry point. It validates `v2`, migrates the
legacy `{ version: 1, snapshots: [...] }` format in memory, and rejects unknown
versions instead of silently discarding data. The shared `StorageFile` writes
migrated data atomically with file mode `0600`, preserving both monitoring and
crawl collections. Future schema changes must add an explicit sequential
migration and a fixture test.

## Crawl records

- `run` owns a stable UUID, normalized target, start/finish timestamps, lifecycle
  status and the exact crawl parameters used for the run.
- `page` stores normalized requested/final URLs, response facts, indexability,
  canonical and bounded metadata required for comparisons.
- `issue` points to a run and optional page, and reserves a versioned stable
  fingerprint. The fingerprint algorithm itself belongs to `CRWL-004`.
- `link` is a directed edge with source, target, internal/external kind, follow
  state and observed target status.
- `aggregate` stores deterministic counters for compact list responses.

Large response bodies, arbitrary request payloads, credentials and page content
are intentionally absent from the model. Only bounded comparison metadata is
stored: title, description and H1 values. Fetch error text is also omitted because
it can contain upstream details.

## Snapshot write lifecycle

`crawler_audit_site` creates a UUID `runId` and reports `completed` or `partial`.
Partial runs include machine-readable reasons such as page/discovery limits or
fetch failures. `crawler_save_snapshot` accepts only the most recent in-process
`runId`; dry-run is the default, while persistence requires `confirm=true`.

The write converts the result into normalized run, page, issue, link and aggregate
records in one atomic file replacement. A repeated save of the same `runId` does
not add or replace records and returns `created: false`. Monitoring and crawl
writes share a path-level serialization lock, so both collections are preserved
when operations overlap.

## URL identity

All URL keys pass through `normalizeCrawlUrl` before write and comparison. The
normalizer uses the platform URL parser, removes credentials and fragments,
normalizes scheme/host/default ports and path segments, and sorts query
parameters. Before persistence it also removes URL credentials, fragments and
case-insensitive keys configured in `CRAWLER_SNAPSHOT_QUERY_DENYLIST`. The storage
schema rejects a URL that is not already normalized.

## Retention

`pruneCrawlHistory` applies both limits configured by
`CRAWLER_SNAPSHOT_RETENTION_DAYS` (default 90) and
`CRAWLER_SNAPSHOT_MAX_RUNS` (default 100 per target). It removes dependent page,
issue, link and aggregate records together with an expired run. Active `running`
runs are never removed. Every successful snapshot write invokes this policy;
`CRWL-007` will expose cleanup/dry-run operations.

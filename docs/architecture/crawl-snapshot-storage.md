# Crawl snapshot storage

Status: crawl history, comparison, regression detection and retention cleanup
implemented by `CRWL-001` through `CRWL-007` on 2026-08-03.

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

Before replacing an existing valid primary file, `StorageFile` atomically stores
its previous generation at `<storage-path>.bak`. Corrupted or unsupported input
fails closed and is never overwritten or promoted to a backup. Operational
recovery is documented in
[storage-backup-and-recovery.md](storage-backup-and-recovery.md).

## Crawl records

- `run` owns a stable UUID, normalized target, start/finish timestamps, lifecycle
  status and the exact crawl parameters used for the run.
- `page` stores normalized requested/final URLs, response facts, indexability,
  canonical and bounded metadata required for comparisons.
- `issue` points to a run and optional page and stores a versioned stable
  fingerprint.
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

## Snapshot reads

`crawler_list_snapshots` is intentionally compact: each item contains the run,
aggregate and page/issue/link counts, never the detailed arrays. It supports an
exact normalized target filter and an inclusive `dateFrom`/`dateTo` range over
`finishedAt` (falling back to `startedAt`). The target filter applies the same
query denylist as persistence. Results use descending `timestamp + runId` keyset
pagination.

`crawler_get_snapshot` returns only run/aggregate/counts for its default `summary`
section. Callers request `pages`, `issues` or `links` explicitly; every detailed
section has its own ascending stable cursor and bounded limit. Unknown run IDs
return normalized `NOT_FOUND`. This sectioned contract prevents an accidental
full-history response from bypassing result limits.

## Snapshot comparison

`crawler_compare_snapshots` accepts explicit `beforeRunId` and `afterRunId` for
the same normalized target. It rejects identical run IDs, missing snapshots and
cross-target comparisons. The result separates crawl parameter changes from site
changes so a different depth, concurrency or other crawl setting is visible but
does not masquerade as a technical regression.

Pages are matched by normalized requested URL. URL appearance/disappearance maps
to `new`/`resolved`; retained pages are `worsened`, `improved` or `unchanged`
according to a deterministic health penalty based on HTTP status, indexability,
canonical drift, missing title/description/H1 and broken outgoing internal links.
The field diff independently reports status, indexability, canonical, title,
description, headings and sorted outgoing link-edge changes. Consequently a
neutral metadata change can remain health-state `unchanged` while still appearing
in `pageFieldChanges` and the detailed example.

Issues are matched by `fingerprintVersion + fingerprint`. Appearance,
disappearance and severity movement produce the same five lifecycle states.
Summary counts cover every page and issue; only deterministic, change-first
examples are returned, bounded by `exampleLimit` (default 50, maximum 200 per
collection).

## Regression detection

`crawler_detect_regressions` converts two same-target snapshots into grouped
technical incidents. It detects newly entered 4xx/5xx states, new stable
`NOINDEX`, `REDIRECT_CHAIN` and `ORPHAN_PAGE` issues, canonical changes whose new
value is not self-referential, and retained URLs that lost incoming internal-link
edges. All affected URLs of one regression type form one incident rather than
one response item per URL.

Severity and confidence are deterministic. New 5xx incidents are critical;
new 4xx, noindex and canonical drift are high; redirect chains, orphan pages and
link loss are medium. A mass change (at least five URLs and at least 20% of the
current snapshot) raises severity by one level. Confidence starts from a
type-specific constant and is reduced for partial snapshots or changed crawl
parameters. The report exposes those conditions and the computed mass threshold.

False-positive policies are loaded from `CRAWLER_REGRESSION_EXCLUSIONS_JSON`.
Each policy has a normalized `target`, optional `types`, and optional
`urlPrefixes`. Empty types match every regression type; empty prefixes match the
whole target. Exclusions are applied before grouping, counted in the report and
never mutate stored snapshots. Returned `sampleUrls` are sorted and bounded by
`sampleLimit` (default 50, maximum 200), while affected counts cover the full
incident.

## Issue identity

New issues use fingerprint algorithm `v2`. Its SHA-256 input contains the
algorithm version, category, normalized uppercase code and normalized page URL
(or target URL for target-wide issues). Link issues additionally include the
normalized related URL so two broken links from one page remain distinct.

Human-readable messages, severity, HTTP status, metadata values and other
observed details do not participate in identity. Consequently an issue remains
stable while its evidence changes. Stored `fingerprintVersion` values from `v1`
through the current version remain schema-valid, allowing future comparison code
to select the correct compatibility behavior.

Snapshot persistence derives `ORPHAN_PAGE` and `BROKEN_INTERNAL_LINK` issues from
link analysis. Their sanitized related URL and observed target status remain in
traceable details, while only the related URL contributes to link identity.

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
reads apply the same policy in memory so expired records are never returned.

`crawler_cleanup_history` persists that pruning plan atomically. The tool is not
registered unless `CRAWLER_HISTORY_WRITE_TOOLS_ENABLED=true`. Dry-run is the
default and reports deletion counts for runs, pages, issues, links and aggregates,
the configured/effective policy, protected active-run count and at most 50 sample
run IDs. An actual cleanup additionally requires `dryRun=false` and `confirm=true`.
Optional `maxAgeDays` and `maxRunsPerTarget` inputs override configured limits for
that invocation without changing configuration. Storage serialization prevents a
cleanup from racing another monitoring or crawl write, and the standard rolling
backup preserves the previous valid generation.

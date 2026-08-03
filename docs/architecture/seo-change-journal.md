# SEO change journal

Status: journal and crawl correlation implemented by `IMP-001`/`IMP-002` on
2026-08-03.

## Storage contract

Storage schema `v3` adds `seoChanges[]` beside monitoring and crawl collections.
The sequential `v2 → v3` migration initializes the journal without modifying
existing records. Every entry contains only bounded structured fields:

- stable UUID `id`;
- normalized `target` and ISO `timestamp`;
- type: `deploy`, `content`, `metadata`, `redirect`, `internal_links`, `robots`,
  `sitemap` or `manual`;
- at most 500 normalized same-origin URLs in `urlScope`; an empty array means the
  whole target;
- description up to 2,000 characters;
- external reference up to 500 characters.

There is no arbitrary metadata/payload field. URL credentials, fragments and
configured secret query keys are removed before persistence.

## Writes and idempotency

`seo_record_change` requires `confirm=true` and writes through the shared atomic
storage lock. Identity is `normalized target + externalReference`. Repeating the
same complete entry returns `created: false` and the original UUID. Reusing that
identity with a different timestamp, type, scope or description returns a
normalized validation error instead of silently replacing audit history.

## Reads

`seo_list_changes` filters by normalized target, type and inclusive ISO date
range. Results are ordered newest first by `timestamp + id` and use the shared
opaque keyset cursor contract. Limits are bounded to 200 entries per page.

## Crawl correlation

`seo_compare_change_crawl` accepts a journal `changeId` and a bounded
`exampleLimit`. For the same normalized target it selects the nearest completed
or partial crawl whose capture finished strictly before the change timestamp and
the nearest one strictly after it. Strict boundaries prevent one run from being
used on both sides.

An explicit `urlScope` limits page and issue evidence to exact normalized URLs;
an empty scope covers the target. Evidence is also filtered by change type:
content uses title/description/headings, internal-link changes use link evidence,
robots and Sitemap changes use indexability/crawl evidence, and the remaining
types use their corresponding status, canonical, metadata or broad deploy/manual
field sets. Unchanged or unrelated evidence is excluded before summaries and
bounded examples are calculated.

The successful result has status `compared`, exposes the selected run IDs and
capture timestamps, relevance filters and the filtered crawl comparison. If a
before or after crawl is unavailable, the tool succeeds with status
`insufficient_data` and names `crawl_before_change` and/or
`crawl_after_change` in `missing`.

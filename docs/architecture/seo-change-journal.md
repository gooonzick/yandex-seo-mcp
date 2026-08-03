# SEO change journal

Status: journal and complete unified impact pipeline implemented by
`IMP-001`–`IMP-005` on 2026-08-03.

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

## Metrica impact

`seo_measure_change_metrica` resolves the journal entry by `changeId` and builds
equal periods immediately before and after its timestamp. The change date is
excluded. `periodDays` is limited to 7–84 and must be divisible by seven, giving
both periods the same weekday distribution. A validated UTC offset aligns the
date boundary with the counter timezone.

Both Reports API calls use `ym:s:startURL`, the organic source filter and
visits/users plus any-goal or selected-goal conversion rate. Converted visits are
derived as `visits × conversion rate`; this methodology is always disclosed.
An explicit change scope is matched against normalized landing-page URLs, while
an empty scope uses report totals for the target. Landing-page evidence is
ordered by absolute visit delta and bounded by `resultLimit`.

The result is `measured` only when both periods meet `minVisits` and the complete
post-change interval is available. Otherwise it is `insufficient_data`, while
still returning observed values. Confidence accounts for minimum volume,
sampling, `data_lag` and source truncation. Limitations always state that the
association is observational; `causalClaim` is fixed to `false`.

## Webmaster impact

`seo_measure_change_webmaster` builds equal 1–7-day periods around the journal
timestamp. The change date is excluded and `dataDelayDays` inserts a gap before
the post-change period. The same delay determines the latest date on which data
is expected; an immature post-period returns `insufficient_data` while retaining
the available evidence.

Query Analytics is requested with URL as the primary indicator. Dated rows are
split between periods and filtered locally against normalized `urlScope` values.
Impressions and clicks are summed, CTR is derived from those totals, and position
is weighted by impressions. URL evidence is ranked by absolute impression delta
and bounded by `resultLimit`.

Search URL events are fetched once for the combined timeline and split into
appeared, removed and net-change counts. The public event history is target-level,
so scoped changes expose `INDEXING_EVENTS_ARE_TARGET_LEVEL`. Confidence also
accounts for minimum impression volume, post-period readiness, the two-week Query
Analytics window and source truncation. Results remain observational and always
set `causalClaim=false`.

The combined timeline, classification and recalculation contract is documented
in [`seo-change-impact.md`](seo-change-impact.md).

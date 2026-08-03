# Unified SEO change impact

Status: implemented by `IMP-005` on 2026-08-03.

## Tool contract

`seo_measure_change_impact` resolves one journal entry and recalculates all three
bounded components on every call:

1. nearest relevant crawl pair from `seo_compare_change_crawl`;
2. equal-period organic evidence from `seo_measure_change_metrica`;
3. delayed URL visibility and indexing evidence from
   `seo_measure_change_webmaster`.

The operation is read-only and stateless. `calculation.calculatedAt` identifies
the observation time; `recalculatesOnEveryCall=true` means rerunning the same
`changeId` incorporates newly available crawl and external data.

## Timeline and evidence

The response orders evidence as change → crawl → indexing → search → traffic.
Each directional item names its source, signal, before/after values, delta and
unit. The full bounded component results remain available for URL-level detail
and data-quality auditing.

Technical direction uses issue lifecycle and page-health changes. Metrica visits,
users and converted visits, plus Webmaster impressions, clicks and CTR, become
directional at an absolute 5% delta. A position change becomes material at 0.5;
lower is better. Indexing net change is directional when non-zero.

## Outcome and confidence

At least two independent domains are required: technical crawl, Metrica traffic
and Webmaster search. With lower coverage the outcome is `insufficient_data`.
Otherwise positive-only evidence yields `positive`, negative-only evidence yields
`negative`, both yield `mixed`, and no material direction yields `neutral`.

Confidence is `high` only when all three domains are available and both external
components are high-confidence. Other sufficient combinations are `medium`;
insufficient coverage is `low`. Component sampling, delay, retention, source
limits and missing crawl sides are preserved in the unified limitations.

## Interpretation safeguards

Every response includes temporal association, unobserved external factors and
overlapping releases as alternative explanations. Changed crawl configuration is
added when applicable. This is an observational comparison rather than an
attribution model, so `causalClaim` is always `false`.

# Unified action item model

Status: implemented by `ACT-001` on 2026-08-03.

## Storage contract

Storage schema `v4` adds `actions[]`. Migration `v3 → v4` initializes the
collection without changing monitoring, crawl or change-journal records. Action
records are strict and contain no arbitrary source payload.

Each item contains:

- UUID, fingerprint and fingerprint version;
- primary source and category;
- canonical affected scope;
- severity, impact, confidence and effort as separate bounded dimensions;
- lifecycle status, title and description;
- one to 100 traceable evidence references;
- creation and update timestamps.

## Scope

`affectedScope.kind` is `target`, `urls`, `queries` or `mixed`. Target URLs use
the canonical URL normalization. URL members must be unique, sorted and
same-origin with the target; query members must be trimmed, unique and sorted.
The kind must match the populated members. URL and query arrays are each limited
to 500 entries.

## Lifecycle

The only states are `open`, `acknowledged`, `in_progress`, `resolved` and
`ignored`. The model defines valid persisted states; transition rules and audit
events belong to `ACT-005`. `updatedAt` cannot precede `createdAt`.

## Evidence traceability

Every evidence record contains `sourceTool`, a typed `sourceResult { type, id }`,
signal code, observation timestamp and bounded human-readable summary. Result
types cover crawl runs, monitoring snapshots, Webmaster responses, Metrica
reports, analysis results and manual references. The strict schema rejects extra
payload fields, so credentials and unbounded upstream responses cannot enter the
action store.

## Identity

Fingerprint version 1 is `act:v1:<sha256>`. The hash input is canonical JSON with
version, source, category, target, scope kind, sorted URLs, sorted queries and the
primary evidence signal. Volatile severity, scores, lifecycle and summaries are
excluded, allowing later ingest to update an existing action instead of creating
duplicates. The storage schema recomputes and validates the fingerprint on every
read.

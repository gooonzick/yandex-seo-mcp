# Storage backup and recovery

Status: implemented by `ENG-005` on 2026-08-03.

## Write and backup guarantees

`StorageFile` validates and migrates the current document in memory before any
write. It then writes the next generation to a mode `0600` temporary file, copies
the current primary file to an atomic `<storage-path>.bak`, and only then replaces
the primary file. The backup is a rolling single previous generation; the first
write to a new path has no backup.

When a legacy v1 file is first changed, `.bak` preserves its original bytes and
the primary becomes the validated current schema after all sequential migrations.
Subsequent successful writes replace `.bak`
with the immediately previous valid primary. Monitoring and crawl writers share
the same path-level lock, so their backups cannot race inside one process.

## Forward migrations

`migrateStorage` applies an explicit sequential registry from the stored version
to the current version. Every migration must advance the numeric version; missing,
backward or non-advancing steps fail. The final document always passes the strict
current Zod schema. Each future version must add input/output fixtures and tests
covering every intermediate step, not only the oldest-to-current shortcut.

## Corruption behavior

Malformed JSON, invalid current-schema data and unsupported versions produce
`StorageCorruptionError`. Reads and writes fail closed: the primary bytes remain
untouched and no new backup is created from unvalidated content. The server does
not automatically restore `.bak`, because silent recovery could hide data loss or
an incompatible deployment.

## Rollback procedure

1. Stop every server process using the storage path.
2. Preserve copies of both the primary file and `<storage-path>.bak` for diagnosis.
3. Validate that the backup is JSON with a supported schema version.
4. Replace the primary with a copy of `.bak`, retaining mode `0600`.
5. Start one server instance and perform a read-only snapshot listing first.
6. After validation, resume writers; a legacy backup will migrate on its next
   successful write and will itself be backed up before replacement.

Rollback is intentionally an operator procedure rather than an MCP write tool.
It must be performed with the service stopped so another process cannot overwrite
the restored generation.

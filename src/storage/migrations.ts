import { z } from "zod";
import {
  CURRENT_STORAGE_VERSION,
  crawlAggregateSchema,
  crawlIssueSchema,
  crawlLinkSchema,
  crawlPageSchema,
  crawlRunSchema,
  monitoringSnapshotSchema,
  storageSchema,
  type StorageData,
} from "./schema.js";

const legacyStorageSchema = z
  .object({
    version: z.literal(1),
    snapshots: z.array(monitoringSnapshotSchema),
  })
  .passthrough();

const storageV2Schema = z
  .object({
    version: z.literal(2),
    monitoringSnapshots: z.array(monitoringSnapshotSchema),
    crawl: z
      .object({
        runs: z.array(crawlRunSchema),
        pages: z.array(crawlPageSchema),
        issues: z.array(crawlIssueSchema),
        links: z.array(crawlLinkSchema),
        aggregates: z.array(crawlAggregateSchema),
      })
      .strict(),
  })
  .strict();

type Migration = (input: unknown) => unknown;

const migrations: ReadonlyMap<number, Migration> = new Map<number, Migration>([
  [
    1,
    (input) => {
      const legacy = legacyStorageSchema.parse(input);
      return {
        version: 2,
        monitoringSnapshots: legacy.snapshots,
        crawl: { runs: [], pages: [], issues: [], links: [], aggregates: [] },
      };
    },
  ],
  [
    2,
    (input) => {
      const legacy = storageV2Schema.parse(input);
      return { ...legacy, version: CURRENT_STORAGE_VERSION, seoChanges: [] };
    },
  ],
]);

export function migrateStorage(input: unknown): StorageData {
  if (input === null || typeof input !== "object") {
    throw new Error("Storage data must be a JSON object");
  }

  let current: unknown = input;
  let version = Reflect.get(input, "version");
  while (version !== CURRENT_STORAGE_VERSION) {
    if (typeof version !== "number" || !Number.isInteger(version))
      throw new Error(`Unsupported storage schema version: ${String(version)}`);
    const migration = migrations.get(version);
    if (!migration) throw new Error(`Unsupported storage schema version: ${String(version)}`);
    current = migration(current);
    if (!current || typeof current !== "object")
      throw new Error(`Storage migration from version ${version} returned invalid data`);
    const nextVersion = Reflect.get(current, "version");
    if (typeof nextVersion !== "number" || nextVersion <= version)
      throw new Error(`Storage migration from version ${version} did not advance the schema`);
    version = nextVersion;
  }
  return storageSchema.parse(current);
}

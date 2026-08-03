import { z } from "zod";
import {
  CURRENT_STORAGE_VERSION,
  emptyStorage,
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

export function migrateStorage(input: unknown): StorageData {
  if (input === null || typeof input !== "object") {
    throw new Error("Storage data must be a JSON object");
  }

  const version = Reflect.get(input, "version");
  if (version === CURRENT_STORAGE_VERSION) return storageSchema.parse(input);
  if (version === 1) {
    const legacy = legacyStorageSchema.parse(input);
    return {
      ...emptyStorage(),
      monitoringSnapshots: legacy.snapshots,
    };
  }
  throw new Error(`Unsupported storage schema version: ${String(version)}`);
}

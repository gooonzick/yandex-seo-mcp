import { randomUUID } from "node:crypto";
import { StorageFile } from "../storage/file-store.js";
import type { MonitoringSnapshot, StorageData } from "../storage/schema.js";
import { createPaginationScope, paginateByKey, type CursorPage } from "../shared/pagination.js";

export type { MonitoringSnapshot } from "../storage/schema.js";

export class MonitoringStore {
  private readonly storage: StorageFile;
  private readonly retentionMs: number;

  public constructor(filePath: string, retentionDays: number) {
    this.storage = new StorageFile(filePath);
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1_000;
  }

  public async add(
    snapshot: Omit<MonitoringSnapshot, "id" | "capturedAt">,
  ): Promise<MonitoringSnapshot> {
    const created: MonitoringSnapshot = {
      ...snapshot,
      id: randomUUID(),
      capturedAt: new Date().toISOString(),
    };
    await this.storage.update((data) => {
      data.monitoringSnapshots.push(created);
      return this.prune(data);
    });
    return created;
  }

  public async list(target?: string, limit = 50): Promise<MonitoringSnapshot[]> {
    const data = this.prune(await this.storage.read());
    return data.monitoringSnapshots
      .filter((snapshot) => !target || snapshot.target === target)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, limit);
  }

  public async listPage(
    target: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<MonitoringSnapshot>> {
    const data = this.prune(await this.storage.read());
    return paginateByKey(
      data.monitoringSnapshots.filter((snapshot) => !target || snapshot.target === target),
      {
        scope: createPaginationScope("monitoring-snapshots", { target }),
        cursor,
        limit,
        order: "desc",
        getKey: (snapshot) => `${snapshot.capturedAt}\0${snapshot.id}`,
      },
    );
  }

  private prune(data: StorageData): StorageData {
    const cutoff = Date.now() - this.retentionMs;
    return {
      ...data,
      monitoringSnapshots: data.monitoringSnapshots.filter(
        (snapshot) => Date.parse(snapshot.capturedAt) >= cutoff,
      ),
    };
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface MonitoringSnapshot {
  id: string;
  target: string;
  hostId: string;
  counterId?: number;
  capturedAt: string;
  summary: unknown;
  diagnostics: unknown;
  sitemaps: unknown;
  organic?: {
    visits: number;
    users: number;
    conversionRate: number;
  };
  search?: {
    impressions: number;
    clicks: number;
    ctr: number;
    position: number | null;
  };
}

interface StoreData {
  version: 1;
  snapshots: MonitoringSnapshot[];
}

export class MonitoringStore {
  private readonly filePath: string;
  private readonly retentionMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(filePath: string, retentionDays: number) {
    this.filePath = resolve(filePath);
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
    await this.serialized(async () => {
      const data = await this.read();
      data.snapshots.push(created);
      await this.write(this.prune(data));
    });
    return created;
  }

  public async list(target?: string, limit = 50): Promise<MonitoringSnapshot[]> {
    const data = this.prune(await this.read());
    return data.snapshots
      .filter((snapshot) => !target || snapshot.target === target)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, limit);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<StoreData> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as StoreData;
      return parsed.version === 1 && Array.isArray(parsed.snapshots)
        ? parsed
        : { version: 1, snapshots: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, snapshots: [] };
      throw error;
    }
  }

  private async write(data: StoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }

  private prune(data: StoreData): StoreData {
    const cutoff = Date.now() - this.retentionMs;
    return {
      version: 1,
      snapshots: data.snapshots.filter((snapshot) => Date.parse(snapshot.capturedAt) >= cutoff),
    };
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { migrateStorage } from "./migrations.js";
import { emptyStorage, storageSchema, type StorageData } from "./schema.js";

const writesByPath = new Map<string, Promise<void>>();

export class StorageFile {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  public async read(): Promise<StorageData> {
    try {
      return migrateStorage(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStorage();
      throw error;
    }
  }

  public async update(mutator: (data: StorageData) => StorageData): Promise<StorageData> {
    let updated = emptyStorage();
    await this.serialized(async () => {
      updated = storageSchema.parse(mutator(await this.read()));
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
    });
    return structuredClone(updated);
  }

  private async serialized(operation: () => Promise<void>): Promise<void> {
    const previous = writesByPath.get(this.filePath) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    writesByPath.set(this.filePath, current);
    try {
      await current;
    } finally {
      if (writesByPath.get(this.filePath) === current) writesByPath.delete(this.filePath);
    }
  }
}

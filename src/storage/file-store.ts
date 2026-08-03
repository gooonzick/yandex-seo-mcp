import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { migrateStorage } from "./migrations.js";
import { emptyStorage, storageSchema, type StorageData } from "./schema.js";

const writesByPath = new Map<string, Promise<void>>();

export class StorageCorruptionError extends Error {
  public constructor(options: { cause: unknown }) {
    super(
      "Storage file is corrupted or uses an unsupported schema; restore its .bak file",
      options,
    );
    this.name = "StorageCorruptionError";
  }
}

export class StorageFile {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  public async read(): Promise<StorageData> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStorage();
      throw error;
    }
    try {
      return migrateStorage(JSON.parse(serialized) as unknown);
    } catch (error) {
      throw new StorageCorruptionError({ cause: error });
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
      try {
        await this.backupCurrent();
        await rename(temporary, this.filePath);
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    });
    return structuredClone(updated);
  }

  private async backupCurrent(): Promise<void> {
    const backupPath = `${this.filePath}.bak`;
    const temporary = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
    let copied = false;
    try {
      await copyFile(this.filePath, temporary);
      copied = true;
      await chmod(temporary, 0o600);
      await rename(temporary, backupPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (!copied && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
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

import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MonitoringStore } from "../src/monitoring/store.js";
import { StorageCorruptionError, StorageFile } from "../src/storage/file-store.js";
import { migrateStorage } from "../src/storage/migrations.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function fixture(name: string): Promise<string> {
  return readFile(join(fixtures, name), "utf8");
}

describe("storage backup and migrations", () => {
  it("migrates the v1 fixture forward and accepts the current fixture", async () => {
    const legacy = JSON.parse(await fixture("storage-v1.json")) as unknown;
    const current = JSON.parse(await fixture("storage-v2.json")) as unknown;

    expect(migrateStorage(legacy)).toMatchObject({
      version: 2,
      monitoringSnapshots: [{ id: "legacy-fixture" }],
      crawl: { runs: [] },
    });
    expect(migrateStorage(current)).toEqual(current);
  });

  it("backs up v1 before the first migrated write and supports rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-migration-"));
    const filePath = join(directory, "snapshots.json");
    const legacyFixture = await fixture("storage-v1.json");
    await writeFile(filePath, legacyFixture, { encoding: "utf8", mode: 0o600 });

    const store = new MonitoringStore(filePath, 90);
    await store.add({
      target: "staging",
      hostId: "https:staging.example.com:443",
      summary: {},
      diagnostics: {},
      sitemaps: {},
    });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 2 });
    expect(await readFile(`${filePath}.bak`, "utf8")).toBe(legacyFixture);
    expect((await stat(`${filePath}.bak`)).mode & 0o777).toBe(0o600);

    await copyFile(`${filePath}.bak`, filePath);
    const rolledBack = await new StorageFile(filePath).read();
    expect(rolledBack).toMatchObject({
      version: 2,
      monitoringSnapshots: [{ id: "legacy-fixture" }],
    });
  });

  it("fails closed without overwriting or backing up corrupted storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-corrupt-"));
    const filePath = join(directory, "snapshots.json");
    const corrupted = await fixture("storage-corrupt.json");
    await writeFile(filePath, corrupted, { encoding: "utf8", mode: 0o600 });
    const storage = new StorageFile(filePath);

    await expect(storage.update((data) => data)).rejects.toBeInstanceOf(StorageCorruptionError);
    expect(await readFile(filePath, "utf8")).toBe(corrupted);
    await expect(stat(`${filePath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MonitoringStore } from "../src/monitoring/store.js";

describe("MonitoringStore", () => {
  it("persists snapshots without exposing broad file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-monitor-"));
    const filePath = join(directory, "snapshots.json");
    const store = new MonitoringStore(filePath, 90);

    const snapshot = await store.add({
      target: "production",
      hostId: "https:example.com:443",
      summary: { searchable_pages_count: 10 },
      diagnostics: { problems: [] },
      sitemaps: { sitemaps: [] },
      organic: { visits: 100, users: 80, conversionRate: 2 },
    });

    expect((await store.list("production", 10))[0]).toMatchObject({
      id: snapshot.id,
      target: "production",
      organic: { visits: 100 },
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 1 });
  });
});

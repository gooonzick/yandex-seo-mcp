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
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 2,
      monitoringSnapshots: [{ id: snapshot.id }],
      crawl: { runs: [] },
    });
  });

  it("reads legacy v1 snapshots and migrates them without data loss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-monitor-legacy-"));
    const filePath = join(directory, "snapshots.json");
    const legacy = {
      version: 1,
      snapshots: [
        {
          id: "legacy-snapshot",
          target: "production",
          hostId: "https:example.com:443",
          capturedAt: new Date().toISOString(),
          summary: {},
          diagnostics: {},
          sitemaps: {},
        },
      ],
    };
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(filePath, JSON.stringify(legacy), "utf8"),
    );

    const store = new MonitoringStore(filePath, 90);
    expect(await store.list()).toMatchObject([{ id: "legacy-snapshot" }]);
    await store.add({
      target: "staging",
      hostId: "https:staging.example.com:443",
      summary: {},
      diagnostics: {},
      sitemaps: {},
    });

    const migrated = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      monitoringSnapshots: Array<{ id: string }>;
    };
    expect(migrated.version).toBe(2);
    expect(migrated.monitoringSnapshots.map(({ id }) => id)).toContain("legacy-snapshot");
  });

  it("paginates snapshots with a cursor bound to target filters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-monitor-pages-"));
    const store = new MonitoringStore(join(directory, "snapshots.json"), 90);
    const added = await Promise.all(
      ["first", "second", "third"].map((target) =>
        store.add({
          target,
          hostId: `https:${target}.example.com:443`,
          summary: {},
          diagnostics: {},
          sitemaps: {},
        }),
      ),
    );
    await store.add({
      target: "first",
      hostId: "https:first.example.com:443",
      summary: {},
      diagnostics: {},
      sitemaps: {},
    });

    const firstPage = await store.listPage("first", undefined, 1);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.pageInfo).toMatchObject({ hasMore: true, limit: 1 });
    const secondPage = await store.listPage("first", firstPage.pageInfo.nextCursor!, 1);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.pageInfo).toMatchObject({ hasMore: false, nextCursor: null });
    expect(added.map(({ id }) => id)).toContain(secondPage.items[0]?.id);

    await expect(store.listPage("second", firstPage.pageInfo.nextCursor!, 1)).rejects.toThrow(
      /Invalid or incompatible pagination cursor/,
    );
  });
});

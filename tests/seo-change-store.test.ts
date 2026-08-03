import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SeoChangeStore } from "../src/impact/change-store.js";

describe("SeoChangeStore", () => {
  it("records bounded changes idempotently and lists them with filters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yandex-seo-changes-"));
    const filePath = join(directory, "snapshots.json");
    const store = new SeoChangeStore(filePath);
    const input = {
      target: "https://example.com/?token=target-secret",
      timestamp: "2026-08-03T10:00:00+00:00",
      type: "deploy" as const,
      urlScope: [
        "https://example.com/page?token=scope-secret&variant=b",
        "https://example.com/page?variant=b&token=scope-secret",
      ],
      description: "Release SEO metadata templates",
      externalReference: "deploy:abc123",
    };

    const created = await store.record(input);
    const repeated = await store.record(input);
    expect(created).toMatchObject({
      created: true,
      change: {
        target: "https://example.com/",
        timestamp: "2026-08-03T10:00:00.000Z",
        type: "deploy",
        urlScope: ["https://example.com/page?variant=b"],
        externalReference: "deploy:abc123",
      },
    });
    expect(repeated).toEqual({ change: created.change, created: false });
    await expect(store.record({ ...input, description: "Conflicting content" })).rejects.toThrow(
      /different change/,
    );
    await expect(
      store.record({
        ...input,
        externalReference: "deploy:other",
        urlScope: ["https://other.test/"],
      }),
    ).rejects.toThrow(/target origin/);

    await store.record({
      ...input,
      timestamp: "2026-08-03T11:00:00.000Z",
      type: "content",
      externalReference: "cms:456",
    });
    const first = await store.list({ target: "https://example.com/?token=filter", limit: 1 });
    expect(first.items).toMatchObject([{ type: "content", externalReference: "cms:456" }]);
    expect(first.pageInfo.hasMore).toBe(true);
    const second = await store.list({
      target: "https://example.com/",
      cursor: first.pageInfo.nextCursor ?? undefined,
      limit: 1,
    });
    expect(second.items).toMatchObject([{ type: "deploy", externalReference: "deploy:abc123" }]);
    expect(
      (
        await store.list({
          type: "deploy",
          dateFrom: "2026-08-03T09:00:00.000Z",
          dateTo: "2026-08-03T10:30:00.000Z",
          limit: 10,
        })
      ).items,
    ).toHaveLength(1);
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toMatch(/target-secret|scope-secret/);
  });
});

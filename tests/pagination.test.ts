import { describe, expect, it } from "vitest";
import { createPaginationScope, paginateByKey } from "../src/shared/pagination.js";

describe("cursor pagination", () => {
  it("uses stable keyset ordering when earlier items are inserted", () => {
    const scope = createPaginationScope("test-items", { target: "production" });
    const first = paginateByKey([{ id: "001" }, { id: "003" }, { id: "002" }], {
      scope,
      limit: 2,
      order: "desc",
      getKey: (item) => item.id,
    });
    expect(first.items.map(({ id }) => id)).toEqual(["003", "002"]);
    expect(first.pageInfo).toMatchObject({ limit: 2, hasMore: true });

    const second = paginateByKey([{ id: "004" }, { id: "003" }, { id: "002" }, { id: "001" }], {
      scope,
      cursor: first.pageInfo.nextCursor ?? undefined,
      limit: 2,
      order: "desc",
      getKey: (item) => item.id,
    });
    expect(second.items.map(({ id }) => id)).toEqual(["001"]);
    expect(second.pageInfo).toEqual({ limit: 2, hasMore: false, nextCursor: null });
  });

  it("binds opaque cursors to filters and ordering", () => {
    const productionScope = createPaginationScope("test-items", { target: "production" });
    const stagingScope = createPaginationScope("test-items", { target: "staging" });
    const first = paginateByKey([{ id: "002" }, { id: "001" }], {
      scope: productionScope,
      limit: 1,
      order: "desc",
      getKey: (item) => item.id,
    });
    const cursor = first.pageInfo.nextCursor!;

    expect(() =>
      paginateByKey([{ id: "001" }], {
        scope: stagingScope,
        cursor,
        limit: 1,
        order: "desc",
        getKey: (item) => item.id,
      }),
    ).toThrow(/Invalid or incompatible pagination cursor/);
    expect(() =>
      paginateByKey([{ id: "001" }], {
        scope: productionScope,
        cursor,
        limit: 1,
        order: "asc",
        getKey: (item) => item.id,
      }),
    ).toThrow(/Invalid or incompatible pagination cursor/);
  });

  it("rejects malformed cursors and non-unique keys", () => {
    const scope = createPaginationScope("test-items");
    expect(() =>
      paginateByKey([{ id: "001" }], {
        scope,
        cursor: "not-a-valid-payload",
        limit: 1,
        order: "asc",
        getKey: (item) => item.id,
      }),
    ).toThrow(/Invalid or incompatible pagination cursor/);
    expect(() =>
      paginateByKey([{ id: "same" }, { id: "same" }], {
        scope,
        limit: 1,
        order: "asc",
        getKey: (item) => item.id,
      }),
    ).toThrow(/keys must be unique/);
  });

  it("creates the same scope for semantically identical filter objects", () => {
    expect(createPaginationScope("items", { b: 2, a: { z: 1, y: 0 } })).toBe(
      createPaginationScope("items", { a: { y: 0, z: 1 }, b: 2 }),
    );
  });
});

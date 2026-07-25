import { describe, expect, it } from "vitest";
import { successResult } from "../src/shared/result.js";

describe("successResult", () => {
  it("limits arrays and marks structured output", () => {
    const result = successResult({ rows: [1, 2, 3, 4] }, { maxRows: 2, maxBytes: 10_000 });

    expect(result.structuredContent).toMatchObject({
      rows: [1, 2],
      _meta: { truncated: false, maxRows: 2 },
    });
  });

  it("limits text output by bytes", () => {
    const result = successResult({ value: "x".repeat(500) }, { maxRows: 10, maxBytes: 100 });

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.structuredContent?._meta).toMatchObject({ truncated: true });
  });
});

import { describe, expect, it, vi } from "vitest";
import { YandexApiError } from "../src/shared/errors.js";
import { YandexHttpClient } from "../src/shared/http-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("YandexHttpClient", () => {
  it("adds OAuth and repeated query parameters", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new YandexHttpClient({
      baseUrl: "https://example.test/v1/",
      token: "secret",
      timeoutMs: 1000,
      maxRetries: 0,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.request("items", {
      query: { indicator: ["shows", "clicks"], limit: 10 },
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/items");
    expect(url.searchParams.getAll("indicator")).toEqual(["shows", "clicks"]);
    expect(url.searchParams.get("limit")).toBe("10");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "OAuth secret",
    });
  });

  it("retries a temporary server error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "temporary" }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new YandexHttpClient({
      baseUrl: "https://example.test/",
      token: "secret",
      timeoutMs: 1000,
      maxRetries: 1,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.request("items")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps authorization failures", async () => {
    const client = new YandexHttpClient({
      baseUrl: "https://example.test/",
      token: "secret",
      timeoutMs: 1000,
      maxRetries: 0,
      fetch: (async () => jsonResponse({ message: "invalid token" }, 401)) as typeof fetch,
    });

    await expect(client.request("items")).rejects.toMatchObject<Partial<YandexApiError>>({
      code: "AUTH",
      status: 401,
      message: "invalid token",
    });
  });

  it("fails safely when a token is missing", async () => {
    const client = new YandexHttpClient({
      baseUrl: "https://example.test/",
      timeoutMs: 1000,
      maxRetries: 0,
    });

    await expect(client.request("items")).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
  });

  it("caches successful GET responses for the configured TTL", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: 1 }));
    const client = new YandexHttpClient({
      baseUrl: "https://example.test/",
      token: "secret",
      timeoutMs: 1000,
      maxRetries: 0,
      cacheTtlMs: 60_000,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const first = await client.request("items", { query: { limit: 10 } });
    const second = await client.request("items", { query: { limit: 10 } });

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds concurrent upstream requests", async () => {
    let active = 0;
    let maximum = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return jsonResponse({ ok: true });
    });
    const client = new YandexHttpClient({
      baseUrl: "https://example.test/",
      token: "secret",
      timeoutMs: 1000,
      maxRetries: 0,
      maxConcurrency: 2,
      cacheTtlMs: 0,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await Promise.all([
      client.request("items/1"),
      client.request("items/2"),
      client.request("items/3"),
      client.request("items/4"),
    ]);

    expect(maximum).toBe(2);
  });
});

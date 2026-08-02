import { describe, expect, it, vi } from "vitest";
import { MetricaClient } from "../src/metrica/client.js";
import { WebmasterClient } from "../src/webmaster/client.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const commonOptions = {
  token: "test-token",
  timeoutMs: 1_000,
  maxRetries: 0,
  cacheTtlMs: 0,
};

describe("MetricaClient endpoint coverage", () => {
  it("covers counter and grant management endpoints", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }));
    const client = new MetricaClient({
      ...commonOptions,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createCounter({ name: "Example" });
    await client.updateCounter(123, { name: "Updated" });
    await client.deleteCounter(123);
    await client.listGrants(123);
    await client.getGrant(123, "user@example");
    await client.createGrant(123, { user_login: "user@example", perm: "view" });
    await client.updateGrant(123, "user@example", { perm: "edit" });
    await client.deleteGrant(123, "user@example");

    expect(
      fetchMock.mock.calls.map(([request, init]) => {
        const url = new URL(String(request));
        return [init?.method, url.pathname, url.searchParams.get("user_login")];
      }),
    ).toEqual([
      ["POST", "/management/v1/counters", null],
      ["PUT", "/management/v1/counter/123", null],
      ["DELETE", "/management/v1/counter/123", null],
      ["GET", "/management/v1/counter/123/grants", null],
      ["GET", "/management/v1/counter/123/grant", "user@example"],
      ["POST", "/management/v1/counter/123/grants", null],
      ["PUT", "/management/v1/counter/123/grant", "user@example"],
      ["DELETE", "/management/v1/counter/123/grant", "user@example"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      counter: { name: "Example" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]![1]?.body))).toEqual({
      grant: { user_login: "user@example", perm: "view" },
    });
  });

  it("gets one goal", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ goal: { id: 7 } }));
    const client = new MetricaClient({
      ...commonOptions,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.getGoal(123, 7);

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api-metrika.yandex.net/management/v1/counter/123/goal/7",
    );
  });

  it("lists Logs API requests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ requests: [] }));
    const client = new MetricaClient({
      ...commonOptions,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.listLogRequests(123);

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api-metrika.yandex.net/management/v1/counter/123/logrequests",
    );
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("GET");
  });

  it("cancels a Logs API request without automatic retries", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ log_request: { request_id: 9 } }));
    const client = new MetricaClient({
      ...commonOptions,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.cancelLogRequest(123, 9);

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api-metrika.yandex.net/management/v1/counter/123/logrequest/9/cancel",
    );
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
  });
});

describe("WebmasterClient v4.1 endpoint coverage", () => {
  it("covers host, verification and user Sitemap management endpoints", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/v4/user") return jsonResponse({ user_id: 42 });
      return jsonResponse({ success: true });
    });
    const client = new WebmasterClient({
      ...commonOptions,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.addHost("https://example.com");
    await client.deleteHost("https:example.com:443");
    await client.getVerification("https:example.com:443");
    await client.requestVerification("https:example.com:443", "DNS");
    await client.getUserSitemap("https:example.com:443", "sitemap/main.xml");
    await client.addUserSitemap("https:example.com:443", "https://example.com/sitemap.xml");
    await client.deleteUserSitemap("https:example.com:443", "sitemap/main.xml");

    expect(
      fetchMock.mock.calls.slice(1).map(([request, init]) => {
        const url = new URL(String(request));
        return [init?.method, url.pathname, url.searchParams.get("verification_type")];
      }),
    ).toEqual([
      ["POST", "/v4/user/42/hosts", null],
      ["DELETE", "/v4/user/42/hosts/https%3Aexample.com%3A443", null],
      ["GET", "/v4/user/42/hosts/https%3Aexample.com%3A443/verification", null],
      ["POST", "/v4/user/42/hosts/https%3Aexample.com%3A443/verification", "DNS"],
      [
        "GET",
        "/v4/user/42/hosts/https%3Aexample.com%3A443/user-added-sitemaps/sitemap%2Fmain.xml",
        null,
      ],
      ["POST", "/v4/user/42/hosts/https%3Aexample.com%3A443/user-added-sitemaps", null],
      [
        "DELETE",
        "/v4/user/42/hosts/https%3Aexample.com%3A443/user-added-sitemaps/sitemap%2Fmain.xml",
        null,
      ],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      host_url: "https://example.com",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[6]![1]?.body))).toEqual({
      url: "https://example.com/sitemap.xml",
    });
  });

  it("gets Sitemap priority recrawl status from v4.1", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/v4/user") return jsonResponse({ user_id: 42 });
      return jsonResponse({ sitemapRecrawlInfo: { isAllowed: true } });
    });
    const client = new WebmasterClient({
      ...commonOptions,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.getSitemapRecrawlStatus("https:example.com:443");

    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://api.webmaster.yandex.net/v4.1/user/42/hosts/https%3Aexample.com%3A443/sitemaps/recrawl",
    );
    expect(fetchMock.mock.calls[1]![1]?.method).toBe("GET");
  });

  it("requests a priority Sitemap recrawl from v4.1", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/v4/user") return jsonResponse({ user_id: 42 });
      return jsonResponse({ accepted: true });
    });
    const client = new WebmasterClient({
      ...commonOptions,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.requestSitemapRecrawl("https:example.com:443", "sitemap/main.xml");

    expect(String(fetchMock.mock.calls[1]![0])).toBe(
      "https://api.webmaster.yandex.net/v4.1/user/42/hosts/https%3Aexample.com%3A443/sitemaps/sitemap%2Fmain.xml/recrawl",
    );
    expect(fetchMock.mock.calls[1]![1]?.method).toBe("POST");
  });
});

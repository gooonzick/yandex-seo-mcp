import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { DirectClient } from "../src/direct/client.js";
import { parseDirectJson, stringifyDirectJson } from "../src/direct/json.js";
import { createServer } from "../src/server.js";

const options = { token: "direct-secret", timeoutMs: 1000, maxRetries: 0 };

describe("Direct API client", () => {
  it("preserves large integers in nested objects and arrays without modifying text", () => {
    expect(
      parseDirectJson(
        '{"Id":9007199254740993,"Ids":[9223372036854775807],"Text":"Id: 9007199254740993"}',
      ),
    ).toEqual({
      Id: "9007199254740993",
      Ids: ["9223372036854775807"],
      Text: "Id: 9007199254740993",
    });
    expect(
      stringifyDirectJson({
        SelectionCriteria: { Ids: ["9007199254740993"] },
        Text: "9007199254740993",
      }),
    ).toBe('{"SelectionCriteria":{"Ids":[9007199254740993]},"Text":"9007199254740993"}');
    expect(() => stringifyDirectJson({ Id: 9007199254740992 })).toThrow("Unsafe numeric");
    expect(() => stringifyDirectJson({ Id: "9223372036854775808" })).toThrow("int64");
  });

  it("uses Bearer auth, Client-Login, sandbox and response metadata", async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{"result":{"Campaigns":[],"LimitedBy":100}}', {
          headers: { RequestId: "req-1", Units: "1/99/100" },
        }),
    );
    const client = new DirectClient({ ...options, clientLogin: "customer", sandbox: true, fetch });
    expect(await client.rpc("campaigns", "get", { FieldNames: ["Id"] })).toMatchObject({
      result: { LimitedBy: 100 },
      requestId: "req-1",
      units: "1/99/100",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api-sandbox.direct.yandex.com/json/v501/campaigns",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer direct-secret",
          "Client-Login": "customer",
        }),
      }),
    );
  });

  it("returns missing configuration without contacting the API", async () => {
    const fetch = vi.fn();
    await expect(
      new DirectClient({ timeoutMs: 100, maxRetries: 0, fetch }).rpc("clients", "get", {}),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([200, 403])(
    "handles a Direct error inside HTTP %s without exposing upstream secrets",
    async (status) => {
      const client = new DirectClient({
        ...options,
        fetch: async () =>
          new Response(
            JSON.stringify({ error: { error_code: 54, error_string: "direct-secret" } }),
            { status, headers: { RequestId: "req-error" } },
          ),
      });
      await expect(client.rpc("campaigns", "get", {})).rejects.toMatchObject({
        code: "PERMISSION",
        requestId: "req-error",
        message: "Direct API error 54",
      });
    },
  );

  it("retries read requests after transient HTTP failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"result":{}}'));
    await new DirectClient({ ...options, maxRetries: 1, fetch }).rpc("campaigns", "get", {});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["network", "http"])("never retries writes after %s failures", async (failure) => {
    const fetch =
      failure === "network"
        ? vi.fn().mockRejectedValue(new Error("disconnected"))
        : vi.fn().mockResolvedValue(new Response("{}", { status: 503 }));
    await expect(
      new DirectClient({ ...options, maxRetries: 3, fetch }).rpc("campaigns", "add", {}),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized and invalid JSON responses", async () => {
    const client = new DirectClient({
      ...options,
      maxResponseBytes: 10,
      fetch: async () => new Response("x".repeat(11)),
    });
    await expect(client.rpc("ads", "get", {})).rejects.toThrow("size limit");
    const malformed = new DirectClient({ ...options, fetch: async () => new Response("not json") });
    await expect(malformed.rpc("ads", "get", {})).rejects.toThrow("Invalid Direct JSON");
  });

  it("aborts timed-out requests", async () => {
    const fetch = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    await expect(
      new DirectClient({ ...options, timeoutMs: 10, fetch }).rpc("ads", "get", {}),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("bounds concurrency and releases slots after errors", async () => {
    let active = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response('{"result":{}}');
    });
    const client = new DirectClient({ ...options, maxConcurrency: 2, fetch });
    await Promise.all(Array.from({ length: 7 }, () => client.rpc("ads", "get", {})));
    expect(peak).toBe(2);
  });
});

describe("Direct MCP tools", () => {
  let client: Client;
  let server: ReturnType<typeof createServer>["server"];
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    fetchMock = vi.fn(async () => new Response('{"result":{"UpdateResults":[{"Id":42}]}}'));
    const created = createServer({
      config: loadConfig({
        YANDEX_DIRECT_TOKEN: "direct-secret",
        YANDEX_DIRECT_CLIENT_LOGIN: "customer",
        YANDEX_HTTP_MAX_RETRIES: "0",
      }),
      fetch: fetchMock,
    });
    server = created.server;
    client = new Client({ name: "direct-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("registers tools and advertises Direct configuration", async () => {
    const tools = (await client.listTools()).tools.filter((tool) =>
      tool.name.startsWith("direct_"),
    );
    expect(tools.length).toBeGreaterThan(60);
    expect(tools.find((tool) => tool.name === "direct_rpc")?.annotations?.readOnlyHint).toBe(false);
    expect(
      tools.find((tool) => tool.name === "direct_list_campaigns")?.annotations?.readOnlyHint,
    ).toBe(true);
    const capabilities = await client.callTool({ name: "yandex_capabilities", arguments: {} });
    expect(capabilities.structuredContent).toMatchObject({
      services: { direct: { configured: true, sandbox: false } },
    });
  });

  it("provides a dry-run budget plan and requires explicit execution confirmation", async () => {
    const arguments_ = { campaignId: 42, amount: 1250.25 };
    const planned = await client.callTool({
      name: "direct_set_daily_budget",
      arguments: arguments_,
    });
    expect(planned.structuredContent).toMatchObject({
      dryRun: true,
      clientLogin: "customer",
      params: { Campaigns: [{ Id: 42, DailyBudget: { Amount: 1250250000, Mode: "STANDARD" } }] },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const denied = await client.callTool({
      name: "direct_set_daily_budget",
      arguments: { ...arguments_, dryRun: false },
    });
    expect(denied.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const executed = await client.callTool({
      name: "direct_set_daily_budget",
      arguments: { ...arguments_, dryRun: false, confirm: true },
    });
    expect(executed.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not bypass confirmation through raw RPC", async () => {
    const result = await client.callTool({
      name: "direct_rpc",
      arguments: {
        service: "campaigns",
        method: "delete",
        params: { SelectionCriteria: { Ids: [42] } },
        dryRun: false,
      },
    });
    expect(result.isError).toBe(true);
    const invalid = await client.callTool({
      name: "direct_rpc",
      arguments: { service: "../clients", method: "get", params: {} },
    });
    expect(invalid.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("paginates explicit selections and preserves large ad IDs", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"result":{"Ads":[{"Id":9007199254740993}],"LimitedBy":21}}'),
    );
    const result = await client.callTool({
      name: "direct_list_ads",
      arguments: {
        selectionCriteria: { CampaignIds: [42] },
        limit: 1,
        offset: 20,
        additionalFields: { TextAdFieldNames: ["Title"] },
      },
    });
    expect(result.structuredContent).toMatchObject({
      result: { Ads: [{ Id: "9007199254740993" }], LimitedBy: 21 },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
      method: "get",
      params: { Page: { Limit: 1, Offset: 20 }, TextAdFieldNames: ["Title"] },
    });
    await client.callTool({
      name: "direct_suspend_ads",
      arguments: { ids: ["9007199254740993"], dryRun: false, confirm: true },
    });
    expect(fetchMock.mock.calls[1]![1].body).toContain('"Ids":[9007199254740993]');
  });

  it("rejects unsafe numeric IDs and missing child selections before requests", async () => {
    expect(
      (
        await client.callTool({
          name: "direct_suspend_ads",
          arguments: { ids: [9007199254740992] },
        })
      ).isError,
    ).toBe(true);
    expect((await client.callTool({ name: "direct_list_keywords", arguments: {} })).isError).toBe(
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Bids for audience targets and KeywordBids for keyword bids", async () => {
    for (const [name, collection] of [
      ["direct_set_bids_audiencetargets", "Bids"],
      ["direct_set_keywordbids", "KeywordBids"],
    ]) {
      const result = await client.callTool({
        name: name!,
        arguments: { items: [{ Id: 42, ContextBid: 1000000 }] },
      });
      expect(result.structuredContent).toMatchObject({
        params: { [collection!]: [{ Id: 42, ContextBid: 1000000 }] },
      });
    }
  });

  it("marks partial write failures as errors and preserves successful IDs", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        '{"result":{"AddResults":[{"Id":42},{"Errors":[{"Code":4004,"Message":"Invalid ad"}]}]}}',
      ),
    );
    const result = await client.callTool({
      name: "direct_add_ads",
      arguments: { items: [{ AdGroupId: 2 }, { AdGroupId: 3 }], dryRun: false, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      partialFailure: true,
      result: { AddResults: [{ Id: 42 }, { Errors: [{ Code: 4004 }] }] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resumes pending reports with exactly the same specification and parses TSV strings", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 201, headers: { retryIn: "2" } }))
      .mockResolvedValueOnce(new Response("", { status: 202, headers: { retryIn: "1" } }))
      .mockResolvedValueOnce(new Response("CampaignId\tCost\r\n9007199254740993\t12.50\r\n"));
    const arguments_ = { dateFrom: "2026-09-01", dateTo: "2026-09-14", campaignIds: [42] };
    const pending = await client.callTool({ name: "direct_report", arguments: arguments_ });
    expect(pending.structuredContent).toMatchObject({ status: "pending", retryAfterSeconds: 2 });
    await client.callTool({ name: "direct_report", arguments: arguments_ });
    const ready = await client.callTool({ name: "direct_report", arguments: arguments_ });
    expect(ready.structuredContent).toMatchObject({
      status: "ready",
      rows: [{ CampaignId: "9007199254740993", Cost: "12.50" }],
    });
    expect(new Set(fetchMock.mock.calls.map((call) => call[1].body)).size).toBe(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.direct.yandex.com/json/v5/reports");
    expect(fetchMock.mock.calls[0]![1].headers.returnMoneyInMicros).toBe("false");
  });

  it("rejects reversed dates", async () => {
    const result = await client.callTool({
      name: "direct_report",
      arguments: { dateFrom: "2026-09-15", dateTo: "2026-09-01" },
    });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

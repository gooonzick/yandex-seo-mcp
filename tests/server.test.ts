import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const config: AppConfig = {
  metricaToken: "metrica-token",
  webmasterToken: "webmaster-token",
  httpTimeoutMs: 1000,
  httpMaxRetries: 0,
  maxResultRows: 100,
  maxResultBytes: 100_000,
  enableWriteTools: false,
  transport: "stdio",
  httpHost: "127.0.0.1",
  httpPort: 3000,
};

describe("Yandex SEO MCP server", () => {
  let client: Client;
  let server: ReturnType<typeof createServer>["server"];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/v4/user")) {
        return new Response(JSON.stringify({ user_id: 42 }), { status: 200 });
      }
      if (url.pathname.endsWith("/v4/user/42/hosts")) {
        return new Response(
          JSON.stringify({
            hosts: [
              {
                host_id: "https:example.com:443",
                ascii_host_url: "https://example.com",
                verified: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/stat/v1/data")) {
        return new Response(
          JSON.stringify({
            data: [{ dimensions: [], metrics: [10] }],
            total_rows: 1,
            sampled: false,
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/management/v1/counters")) {
        return new Response(JSON.stringify({ rows: 0, counters: [] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ message: "not mocked" }), {
        status: 404,
      });
    });

    const created = createServer({
      config,
      fetch: fetchMock as unknown as typeof fetch,
    });
    server = created.server;
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await Promise.allSettled([client.close(), server.close()]);
  });

  it("lists namespaced tools and hides write tools by default", async () => {
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);

    expect(names).toContain("yandex_capabilities");
    expect(names).toContain("metrica_get_report");
    expect(names).toContain("webmaster_list_hosts");
    expect(names).not.toContain("metrica_logs_clean");
    expect(names).not.toContain("webmaster_request_recrawl");
  });

  it("returns capabilities without making HTTP requests", async () => {
    const response = await client.callTool({
      name: "yandex_capabilities",
      arguments: {},
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      services: {
        metrica: { configured: true },
        webmaster: { configured: true },
      },
      writeToolsEnabled: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls a Metrica report with normalized query arguments", async () => {
    const response = await client.callTool({
      name: "metrica_get_report",
      arguments: {
        counterId: 123,
        date1: "2026-07-01",
        date2: "2026-07-20",
        metrics: ["ym:s:visits"],
      },
    });

    expect(response.isError).not.toBe(true);
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(requestedUrl.searchParams.get("ids")).toBe("123");
    expect(requestedUrl.searchParams.get("metrics")).toBe("ym:s:visits");
    expect(requestedUrl.searchParams.get("offset")).toBe("1");
  });

  it("resolves the Webmaster user before listing hosts", async () => {
    const response = await client.callTool({
      name: "webmaster_list_hosts",
      arguments: {},
    });

    expect(response.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/v4/user/42/hosts");
  });

  it("returns an MCP validation error for invalid arguments", async () => {
    const response = await client.callTool({
      name: "metrica_get_counter",
      arguments: { counterId: -1 },
    });

    expect(response.isError).toBe(true);
  });
});

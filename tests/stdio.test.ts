import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

describe("stdio process", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("starts as a child process and lists tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("src/index.ts")],
      env: {
        MCP_TRANSPORT: "stdio",
      },
      stderr: "pipe",
    });
    client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });
    await client.connect(transport);

    const response = await client.listTools();

    expect(response.tools.some((tool) => tool.name === "yandex_capabilities")).toBe(true);
  });
});

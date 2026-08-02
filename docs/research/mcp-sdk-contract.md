# MCP TypeScript SDK v1.x: implementation contract

Проверено 24 июля 2026 года по официальной документации и исходникам
`@modelcontextprotocol/sdk` v1.x. Целевая стабильная версия — `1.29.0`;
alpha-ветку v2 в этом проекте не использовать.

## Зафиксированные зависимости

Runtime:

```json
{
  "@modelcontextprotocol/sdk": "^1.29.0",
  "zod": "^3.25.76"
}
```

Development:

```json
{
  "@types/node": "^24.1.0",
  "typescript": "^5.8.3",
  "vitest": "^3.2.4"
}
```

Рекомендуемая среда — Node.js `>=20`, ESM и TypeScript `strict`.
Версии должны быть воспроизводимо закреплены в `pnpm-lock.yaml`. Zod следует
указывать как прямую зависимость приложения, поскольку схемы импортируются
самим сервером.

## Публичные imports

Использовать только публичные subpath exports пакета:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
```

Суффикс `.js` обязателен для ESM subpath imports. Не импортировать внутренние
файлы из `dist/esm`, `dist/cjs` или исходников SDK.

## Минимальный production stdio server

```ts
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "yandex-seo-mcp",
  version: "1.0.0",
});

// registerTool(...) calls belong here.

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("Fatal MCP server error", error);
  process.exitCode = 1;
});
```

`stdout` полностью зарезервирован под JSON-RPC stdio transport. Диагностика
пишется только в `stderr` либо отправляется клиенту через MCP logging
capability. Не использовать `console.log`.

Для корректного завершения процесса зарегистрировать `SIGINT` и `SIGTERM`,
защитить shutdown от повторного входа и вызвать `await server.close()`.
Фатальная ошибка устанавливает `process.exitCode = 1`; принудительный
`process.exit()` не нужен.

## Контракт `registerTool`

Предпочтителен актуальный `registerTool`, а не устаревающие перегрузки
`server.tool(...)`.

```ts
const InputSchema = z
  .object({
    counterId: z.number().int().positive(),
  })
  .strict();

const OutputSchema = z.object({
  counterId: z.number().int().positive(),
  status: z.enum(["available", "unavailable"]),
});

server.registerTool(
  "metrica_get_counter",
  {
    title: "Get Yandex Metrica counter",
    description: "Returns one counter visible to the configured OAuth token.",
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ counterId }) => {
    const structuredContent = OutputSchema.parse({
      counterId,
      status: "available",
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent),
        },
      ],
      structuredContent,
    };
  },
);
```

Правила проекта:

- вход и `structuredContent` описываются отдельными Zod object schemas;
- выход дополнительно проверяется локально через `OutputSchema.parse` до
  возврата, чтобы ошибка оставалась в контролируемой границе приложения;
- при наличии `outputSchema` успешный результат возвращает
  `structuredContent`;
- одновременно возвращается компактный текстовый `content` для клиентов,
  которые пока не отображают structured output;
- ожидаемые ошибки API нормализуются в `{ isError: true, content: [...] }`;
  `structuredContent` в error-result не добавляется;
- секреты, OAuth-токены и внутренние stack traces не включаются в результат.

Annotations являются подсказками клиенту, а не механизмом безопасности.
Для read-only запросов к Yandex использовать набор выше. `openWorldHint: true`
нужен, поскольку инструмент обращается к внешним Yandex API. Для будущих
write-tools значения должны отражать реальную семантику операции; отдельно
нужны строгая схема и подтверждение опасных действий.

## End-to-end тест через `InMemoryTransport`

Тестировать не прямой вызов handler, а полный MCP-контракт: discovery,
валидацию аргументов, вызов и форму результата.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it } from "vitest";

let client: Client;
let server: McpServer;

beforeEach(async () => {
  server = createServer(fakeDependencies);
  client = new Client({ name: "test-client", version: "1.0.0" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

it("discovers and calls a tool", async () => {
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toContain("metrica_get_counter");

  const result = await client.callTool({
    name: "metrica_get_counter",
    arguments: { counterId: 42 },
  });

  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    counterId: 42,
    status: "available",
  });
});
```

Минимальная матрица:

1. `listTools()` проверяет имя, description, JSON Schema и annotations.
2. Валидный `callTool()` проверяет text content и `structuredContent`.
3. Невалидные аргументы дают `isError: true` и не вызывают Yandex adapter.
4. Ошибки OAuth, rate limit и upstream 5xx не раскрывают токен.
5. Неожиданно невалидный output ловится тестом.
6. Отдельный smoke-test запускает собранный bin как stdio-процесс.

## Packaging contract

```json
{
  "type": "module",
  "bin": {
    "yandex-seo-mcp": "dist/index.js"
  },
  "main": "dist/index.js",
  "files": ["dist", "README.md", "LICENSE"],
  "engines": {
    "node": ">=20"
  }
}
```

Требования:

- первая строка CLI source — `#!/usr/bin/env node`; TypeScript должен
  сохранить shebang в `dist/index.js`;
- `bin` указывает только на собранный JavaScript, не на `.ts`;
- npm/pnpm при упаковке выставляет executable mode для файла из `bin`;
- пакет перед публикацией проверяется через `pnpm pack --dry-run`;
- smoke-test запускает `node dist/index.js` и выполняет MCP initialize,
  `tools/list` и один безопасный `tools/call`;
- публикация выполняется только после `typecheck`, unit/contract tests,
  build и проверки содержимого tarball.

Если библиотечный API не планируется, `exports` не обязателен. Если он будет
добавлен, экспортировать отдельный side-effect-free factory, например
`createServer`, а CLI entrypoint оставить отдельным, чтобы импорт пакета не
запускал stdio transport.

## Sources

- [MCP TypeScript SDK v1.29.0 server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md)
- [MCP TypeScript SDK v1.x repository](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)
- [Tool annotations schema](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/types.ts)
- [In-memory transport tests](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/inMemory.test.ts)

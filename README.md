# Yandex SEO MCP

MCP-сервер для Яндекс Метрики и Яндекс Вебмастера. Он предоставляет AI-клиентам типизированные инструменты для SEO-аналитики, отчетов Метрики, индексирования, поисковых запросов, Sitemap и Logs API.

## Возможности

- Метрика: счетчики, цели, произвольные отчеты, динамика, traffic/search presets.
- Logs API: evaluate, create, status и ограниченное по размеру скачивание TSV.
- Вебмастер: сайты, сводка, индексирование, страницы в поиске, запросы, диагностика, Sitemap и очередь переобхода.
- `stdio` для локальных MCP-клиентов.
- Streamable HTTP на Hono для серверного запуска.
- Write-tools отключены по умолчанию.
- OAuth-токены не передаются аргументами tools и не попадают в ответы.
- Retry для `429/5xx`, timeout, валидация Zod и ограничения объема результата.

## Требования

- Node.js 20 или новее.
- OAuth-приложение Яндекса.
- Для Метрики: разрешение на чтение данных Метрики (`metrika:read`); write-доступ запрашивайте отдельно только при необходимости.
- Для Вебмастера: `webmaster:hostinfo`; для изменяющих операций также может понадобиться `webmaster:verify`.

Создайте приложение в Яндекс OAuth, выдайте ему минимально необходимые права и получите пользовательский OAuth-токен. Не сохраняйте токены в Git.

## Установка

```bash
npm install
npm run build
```

Проверка:

```bash
npm run check
```

Live smoke tests выполняются только явно и требуют токенов:

```bash
YANDEX_METRICA_TOKEN=... \
YANDEX_WEBMASTER_TOKEN=... \
npm run test:live
```

## Локальная конфигурация MCP

Соберите проект и укажите абсолютный путь к `dist/index.js`:

```json
{
  "mcpServers": {
    "yandex-seo": {
      "command": "node",
      "args": ["/absolute/path/to/yandex-seo-mcp/dist/index.js"],
      "env": {
        "YANDEX_METRICA_TOKEN": "oauth-token",
        "YANDEX_WEBMASTER_TOKEN": "oauth-token"
      }
    }
  }
}
```

Можно использовать один `YANDEX_OAUTH_TOKEN` как fallback для обоих сервисов.

## HTTP-режим

По умолчанию сервер слушает только stdio. Для локального Streamable HTTP:

```bash
MCP_TRANSPORT=http npm start
```

Endpoint: `http://127.0.0.1:3000/mcp`. Health check: `/health`.

Для bind на любой адрес кроме loopback сервер требует `MCP_HTTP_BEARER_TOKEN` длиной не менее 16 символов:

```bash
MCP_TRANSPORT=http \
MCP_HTTP_HOST=0.0.0.0 \
MCP_HTTP_BEARER_TOKEN='replace-with-a-long-random-secret' \
npm start
```

Для публичного развертывания дополнительно используйте TLS, reverse proxy, полноценную OAuth-аутентификацию, encrypted token storage и ограничение доступа на уровне сети.

## Основные переменные

| Переменная                |  Default | Назначение                          |
| ------------------------- | -------: | ----------------------------------- |
| `YANDEX_OAUTH_TOKEN`      |        — | Общий fallback-токен                |
| `YANDEX_METRICA_TOKEN`    |        — | Отдельный токен Метрики             |
| `YANDEX_WEBMASTER_TOKEN`  |        — | Отдельный токен Вебмастера          |
| `YANDEX_HTTP_TIMEOUT_MS`  |  `30000` | Timeout запроса                     |
| `YANDEX_HTTP_MAX_RETRIES` |      `3` | Retry для временных ошибок          |
| `YANDEX_MAX_RESULT_ROWS`  |   `1000` | Максимум элементов каждого массива  |
| `YANDEX_MAX_RESULT_BYTES` | `500000` | Максимум текста MCP-ответа          |
| `ENABLE_WRITE_TOOLS`      |  `false` | Включить подтверждаемые write-tools |
| `MCP_TRANSPORT`           |  `stdio` | `stdio` или `http`                  |

Полный пример находится в [.env.example](.env.example).

## Безопасность

- Не существует универсального `raw_api_request`.
- Base URL обоих API фиксирован, поэтому аргументы tools не могут вызвать SSRF.
- Logs download всегда ограничен по размеру MCP-ответа.
- `metrica_logs_clean` и `webmaster_request_recrawl` появляются только при `ENABLE_WRITE_TOOLS=true` и требуют `confirm: true`.
- При ошибках возвращаются безопасные категории и request ID без Authorization headers.

## Разработка

```bash
npm run typecheck
npm test
npm run build
```

API-контракты и известные неопределенности:

- [Метрика](docs/research/metrica-api-contract.md)
- [Вебмастер](docs/research/webmaster-api-contract.md)
- [MCP SDK](docs/research/mcp-sdk-contract.md)
- [Исходный план](docs/plans/yandex-seo-mcp-implementation-plan.md)

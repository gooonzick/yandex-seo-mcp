# Yandex Webmaster API: контракт для MCP

Дата проверки: 2026-07-24. Источники: актуальная официальная документация Yandex Webmaster API 4.1, проиндексированная Context7 (`/websites/yandex_ru_dev_webmaster`), и конкретные страницы справочника API Яндекса.

## Общий протокол

- Base URL: `https://api.webmaster.yandex.net/`.
- Основной документированный набор методов использует префикс `/v4`; новые методы приоритетного переобхода Sitemap — `/v4.1`.
- HTTPS, UTF-8, JSON по умолчанию. Для XML: `Accept: application/xml`. Для MCP следует фиксировать `Accept: application/json`.
- Авторизация: `Authorization: OAuth <token>`. Без токена документирован `401 Unauthorized`.
- OAuth scopes при регистрации приложения: `webmaster:hostinfo` для чтения информации и `webmaster:verify` для операций подтверждения/изменения. Для read-only MVP достаточно запрашивать `webmaster:hostinfo`; write-инструменты нужно проверять live с обоими scopes.
- `user-id` — `int64`, получается через `/v4/user`. `host-id` — непрозрачная строка вида `https:example.com:443`; ее необходимо URL-кодировать как path segment, не конструировать из URL вручную.
- Общая форма старых ошибок: `{ error_code, error_message, ...context }`. В новых v4.1/PRO методах встречается несовместимая форма `{ code, message, ...context }`; клиент должен поддерживать обе.
- Общие важные коды: `401`; `403 INVALID_OAUTH_TOKEN | ACCESS_FORBIDDEN | INVALID_USER_ID`; `404 HOST_NOT_FOUND | HOST_NOT_VERIFIED | HOST_NOT_INDEXED | HOST_NOT_LOADED | RESOURCE_NOT_FOUND`; `429 QUOTA_EXCEEDED | TOO_MANY_REQUESTS_ERROR`.

Источники: [введение](https://yandex.ru/dev/webmaster/doc/ru/), [авторизация](https://yandex.ru/dev/webmaster/doc/ru/tasks/how-to-get-oauth), [ошибки](https://yandex.ru/dev/webmaster/doc/ru/reference/errors).

## User, hosts и summary

### `GET /v4/user`

Без параметров. Ответ:

```json
{ "user_id": 1 }
```

Источник: [получение идентификатора пользователя](https://yandex.ru/dev/webmaster/doc/ru/reference/user).

### `GET /v4/user/{user-id}/hosts`

Query-параметров и пагинации нет. Ответ `{ hosts: Host[] }`, где:

- `host_id: string` — обязателен;
- `ascii_host_url: string` — обязателен;
- `unicode_host_url?: string`;
- `verified: boolean` — обязателен;
- `main_mirror` — документирован как обязательный, но семантически «если есть», поэтому в схеме MCP должен быть nullable/optional; внутри те же `host_id`, `ascii_host_url`, `unicode_host_url?`, `verified`.

Страница также описывает `ApiVerificationState` и `ApiVerificationFailReason`, хотя в показанном JSON списка hosts присутствует только `verified`. Не следует добавлять эти поля в строгий ответ без live-подтверждения.

Источник: [список сайтов](https://yandex.ru/dev/webmaster/doc/ru/reference/hosts).

### `GET /v4/user/{user-id}/hosts/{host-id}`

Ответ:

- `host_id: string`;
- `ascii_host_url: string`;
- `unicode_host_url: string`;
- `verified: boolean`;
- `main_mirror?: HostMirror`;
- `host_data_status?: "NOT_INDEXED" | "NOT_LOADED" | "OK"`;
- `host_display_name?: string`.

Источник: [информация о сайте](https://yandex.ru/dev/webmaster/doc/ru/reference/hosts-id).

### `GET /v4/user/{user-id}/hosts/{host-id}/summary`

Ответ:

- `sqi: int32` — ИКС;
- `excluded_pages_count: int64`;
- `searchable_pages_count: int64`;
- `site_problems: Record<SiteProblemSeverity, int32>`.

`SiteProblemSeverity = FATAL | CRITICAL | POSSIBLE_PROBLEM | RECOMMENDATION`. Ошибки: кроме общих, `404 HOST_NOT_FOUND | HOST_NOT_LOADED | HOST_NOT_VERIFIED`.

Источник: [статистика сайта](https://yandex.ru/dev/webmaster/doc/ru/reference/host-id-summary).

## Индексирование и страницы в поиске

### `GET /v4/user/{user-id}/hosts/{host-id}/indexing/history`

Query: `date_from?: datetime`, `date_to?: datetime`; без них — текущий день. Ответ:

```ts
{
  indicators: Partial<Record<IndexingStatus, Array<{ date: string; value: number }>>>;
}
```

`IndexingStatus = HTTP_2XX | HTTP_3XX | HTTP_4XX | HTTP_5XX | OTHER`; `value` — `int64`.

### `GET /v4/user/{user-id}/hosts/{host-id}/indexing/samples`

Query: `offset?: int32 >= 0`; `limit?: int32` в диапазоне `1..100`, default `50`. Возвращает не более 50 000 URL всего:

```ts
{
  count: number;
  samples: Array<{
    status: IndexingStatus;
    http_code?: number;
    url: string;
    access_date: string;
  }>;
}
```

### `GET /v4/user/{user-id}/hosts/{host-id}/search-urls/in-search/history`

Query: `date_from?: datetime`, `date_to?: datetime`; default — текущий день. Ответ `{ history: Array<{ date: datetime; value: int64 }> }`.

### `GET /v4/user/{user-id}/hosts/{host-id}/search-urls/events/history`

Query: `date_from?: datetime`, `date_to?: datetime`; default — текущий день. Ответ:

```ts
{
  indicators: Partial<
    Record<"APPEARED_IN_SEARCH" | "REMOVED_FROM_SEARCH", Array<{ date: string; value: number }>>
  >;
}
```

Источники: [история индексирования](https://yandex.ru/dev/webmaster/doc/ru/reference/hosts-indexing-history), [примеры загруженных страниц](https://yandex.ru/dev/webmaster/doc/ru/reference/hosts-indexing-samples), [страницы в поиске](https://yandex.ru/dev/webmaster/doc/ru/reference/hosts-indexing-insearch-history), [события поиска](https://yandex.ru/dev/webmaster/doc/ru/reference/hosts-search-events-history).

## Поисковые запросы

### `GET /v4/user/{user-id}/hosts/{host-id}/search-queries/popular`

Возвращает TOP-3000 запросов; за один вызов — максимум 500.

Query:

- `order_by: "TOTAL_SHOWS" | "TOTAL_CLICKS"` — обязателен;
- `query_indicator?: ApiQueryIndicator` — repeatable;
- `device_type_indicator?: ALL | DESKTOP | MOBILE_AND_TABLET | MOBILE | TABLET`, default `ALL`;
- `date_from?: datetime`, `date_to?: datetime`; default — последняя неделя;
- `offset?: int32 >= 0`, default `0`;
- `limit?: int32`, `1..500`, default `500`.

`ApiQueryIndicator = TOTAL_SHOWS | TOTAL_CLICKS | AVG_SHOW_POSITION | AVG_CLICK_POSITION`.

Ответ:

```ts
{
  queries: Array<{
    query_id: string;
    query_text: string;
    indicators: Partial<Record<ApiQueryIndicator, number>>;
  }>;
  date_from: string;
  date_to: string;
  count: number;
}
```

Фактические `date_from/date_to` могут быть уже запрошенного диапазона, если данных нет. Отдельные indicators могут отсутствовать.

### `GET /v4/user/{user-id}/hosts/{host-id}/search-queries/all/history`

Query: repeatable `query_indicator?`, `device_type_indicator?` (default `ALL`), `date_from?`, `date_to?` (default — неделя). Ответ:

```ts
{
  indicators: Partial<Record<ApiQueryIndicator, Array<{ date: string; value: number }>>>;
}
```

### `GET /v4/user/{user-id}/hosts/{host-id}/search-queries/{query-id}/history`

`query-id` берется из `popular`. Query аналогичен предыдущему методу. Ответ:

```ts
{
  queries: Array<{
    query_id: string;
    query_text: string;
    indicators: Partial<Record<ApiQueryIndicator, Array<{ date: string; value: number }>>>;
  }>;
}
```

Специальная ошибка: `404 QUERY_ID_NOT_FOUND`.

Источники: [популярные запросы](https://yandex.ru/dev/webmaster/doc/ru/reference/host-search-queries-popular), [история всех запросов](https://yandex.ru/dev/webmaster/doc/ru/reference/host-search-queries-history-all), [история запроса](https://yandex.ru/dev/webmaster/doc/ru/reference/host-search-queries-history).

### Не включать в первый стабильный MCP-контракт

- `POST /v4/user/{user-id}/hosts/{host-id}/query-analytics/list` — актуальный метод мониторинга запросов и URL за последние две недели; лимит 10 000 запросов в час, затем `429`. Контракт тела сложный (filters, sort, regions, device/search location/statistic enums) и должен быть реализован после отдельного live contract test. Источник: [мониторинг запросов](https://yandex.ru/dev/webmaster/doc/ru/reference/host-query-analytics).
- `/v4/user/{user-id}/hosts/{host-id}/pro/serp/...` — PRO/β выгрузка по URL, асинхронная и с отдельными лимитами/доступностью дат. Не считать общедоступным API. Источник: [расширенная выгрузка β](https://yandex.ru/dev/webmaster/doc/ru/reference/enhanced-export).

## Диагностика

### `GET /v4/user/{user-id}/hosts/{host-id}/diagnostics`

Без query. Ответ:

```ts
{
  problems: Record<
    string,
    {
      severity: "FATAL" | "CRITICAL" | "POSSIBLE_PROBLEM" | "RECOMMENDATION";
      state: "PRESENT" | "ABSENT" | "UNDEFINED";
      last_state_update: string;
    }
  >;
}
```

Ключи `problems` — расширяемый `ApiSiteProblemTypeEnum`. Их нельзя валидировать закрытым enum: Яндекс добавляет новые типы. На 2026-07-24 среди документированных: `CONNECT_FAILED`, `DISALLOWED_IN_ROBOTS`, `DNS_ERROR`, `MAIN_PAGE_ERROR`, `THREATS`, `INSIGNIFICANT_CGI_PARAMETER`, `SLOW_AVG_RESPONSE_TIME`, `SSL_CERTIFICATE_ERROR`, `URL_ALERT_4XX`, `URL_ALERT_5XX`, `DISALLOWED_URLS_ALERT`, `DOCUMENTS_MISSING_DESCRIPTION`, `DOCUMENTS_MISSING_TITLE`, `DUPLICATE_CONTENT_ATTRS`, `DUPLICATE_PAGES`, `ERROR_IN_ROBOTS_TXT`, `ERRORS_IN_SITEMAPS`, `FAVICON_ERROR`, `MAIN_MIRROR_IS_NOT_HTTPS`, `MAIN_PAGE_REDIRECTS`, `NO_METRIKA_COUNTER_BINDING`, `NO_METRIKA_COUNTER_CRAWL_ENABLED`, `NO_ROBOTS_TXT`, `NO_SITEMAPS`, `NO_SITEMAP_MODIFICATIONS`, `NON_WORKING_VIDEO`, `SOFT_404`, `TOO_MANY_DOMAINS_ON_SEARCH`, `VIDEOHOST_OFFER_FAILED`, `VIDEOHOST_OFFER_IS_NEEDED`, `VIDEOHOST_OFFER_NEED_PAPER`, `BIG_FAVICON_ABSENT`, `FAVICON_PROBLEM`, `NO_METRIKA_COUNTER`, `NO_REGIONS`, `NOT_IN_SPRAV`, `NOT_MOBILE_FRIENDLY`, `VYGODA_POSSIBLE_ACTIVATION`.

Источник: [диагностика сайта](https://yandex.ru/dev/webmaster/doc/ru/reference/host-diagnostics-get).

## Sitemap

### `GET /v4/user/{user-id}/hosts/{host-id}/sitemaps`

Query:

- `parent_id?: string`;
- `limit?: int32`, `1..100`, default `10`;
- `from?: sitemap-id` — cursor, результат начинается после него.

Ответ `{ sitemaps: Sitemap[] }`, где:

- `sitemap_id: string`;
- `sitemap_url: string`;
- `last_access_date?: datetime`;
- `errors_count: int32`;
- `urls_count: int64`;
- `children_count: int32`;
- `sources: Array<"ROBOTS_TXT" | "WEBMASTER" | "INDEX_SITEMAP">`;
- `sitemap_type: "SITEMAP" | "INDEX_SITEMAP"`.

Документация в таблице ошибочно называет тип `sitemap_type` как `ApiExplicitVerificationType`; корректный enum по соседнему разделу — `ApiSitemapType`.

### `GET /v4/user/{user-id}/hosts/{host-id}/sitemaps/{sitemap-id}`

Параметры только path. Возвращает один объект той же формы. Специальная ошибка: `404 SITEMAP_NOT_FOUND`.

### `GET /v4/user/{user-id}/hosts/{host-id}/user-added-sitemaps`

Query: `offset?: sitemap-id` (cursor, не числовой offset), `limit?: int32`, `1..100`, документирован default `100`. Ответ:

```ts
{
  sitemaps: Array<{ sitemap_id: string; sitemap_url: string; added_date: string }>;
  count: number;
}
```

Внизу страницы есть противоречивый текст «limit default 10»; пример формата запроса указывает default 100. Для MCP default лучше задавать явно.

Источники: [список Sitemap](https://yandex.ru/dev/webmaster/doc/ru/reference/host-sitemaps-get), [Sitemap по ID](https://yandex.ru/dev/webmaster/doc/ru/reference/host-sitemaps-sitemap-id-get), [добавленные пользователем Sitemap](https://yandex.ru/dev/webmaster/doc/ru/reference/host-user-added-sitemaps-get).

## Переобход URL

### `GET /v4/user/{user-id}/hosts/{host-id}/recrawl/quota`

Ответ `{ daily_quota: int32, quota_remainder: int32 }`.

### `GET /v4/user/{user-id}/hosts/{host-id}/recrawl/queue`

Query: `offset?: int32` default `0`; `limit?: int32 >= 1` default `50` (верхняя граница не документирована); `date_from?: datetime`; `date_to?: datetime`.

Ответ `{ tasks: RecrawlTask[] }`, где `RecrawlTask = { task_id: string, url: string, added_time?: datetime, state: "IN_PROGRESS" | "DONE" | "FAILED" }`.

### `POST /v4/user/{user-id}/hosts/{host-id}/recrawl/queue`

Write-tool. `Content-Type: application/json`, тело `{ "url": "https://example.com/page" }`. Успех: `202 Accepted`, ответ `{ task_id: UUID, quota_remainder: int32 }`.

Ошибки: `400 INVALID_URL`; `409 URL_ALREADY_ADDED`; `429 QUOTA_EXCEEDED` с `daily_quota`, `exceeded_until`, `error_message`.

### `GET /v4/user/{user-id}/hosts/{host-id}/recrawl/queue/{task-id}`

Ответ — один `RecrawlTask`. Специальная ошибка `404 TASK_NOT_FOUND`.

Источники: [квота](https://yandex.ru/dev/webmaster/doc/ru/reference/host-recrawl-quota-get), [список задач](https://yandex.ru/dev/webmaster/doc/ru/reference/host-recrawl-get), [отправка URL](https://yandex.ru/dev/webmaster/doc/ru/reference/host-recrawl-post), [статус задачи](https://yandex.ru/dev/webmaster/doc/ru/reference/host-recrawl-task-get).

## Приоритетный переобход Sitemap (v4.1)

- `GET /v4.1/user/{user-id}/hosts/{host-id}/sitemaps/recrawl` — состояние/лимит.
- `POST /v4.1/user/{user-id}/hosts/{host-id}/sitemaps/{sitemap_id}/recrawl` — запускает переобход.
- Ограничение: не более 10 запусков в месяц на host.

Новые ответы/ошибки используют camelCase и `{ code, message }`. Документированные структуры:

```ts
type SitemapRecrawlInfo = {
  isAllowed: boolean;
  isPending: boolean;
  lastRequestTime: string;
};

type QuotaInfo = {
  monthlyQuota: number;
  quotaUsed: number;
  nearestAllowedDay: string;
};
```

Ошибки: `409 RECRAWL_IN_PROCESS` с `sitemapRecrawlInfo`; `429 HOST_RECRAWLS_QUOTA_EXCEEDED` с `quotaInfo`. Точные success status/body отдельных страниц плохо индексируются; перед включением write-tool обязателен live contract test. В MVP допустим только GET limit/status, а POST — за feature flag и явным подтверждением.

Источник: [приоритетный переобход Sitemap](https://yandex.ru/dev/webmaster/doc/ru/reference/host-priority-re-crawl-sitemap), [migration 4.1](https://yandex.ru/dev/webmaster/doc/ru/concepts/migration-guide).

## Устаревшее, недоступное или неоднозначное

- API 3.2 и ниже больше не поддерживаются со второй половины 2020 года. Не реализовывать старые `/api/me`, `/api/v3/...` и примеры из старого «Клуба API».
- Документация открыта как API 4.1, но большинство стабильных endpoint URL намеренно остаются `/v4`; нельзя механически заменить все на `/v4.1`.
- В migration guide встречается путь `search-queries/{query-id}/` без `/history`, тогда как актуальная reference-страница и resource overview указывают `/search-queries/{query-id}/history`. Использовать `/history`.
- В англоязычном resource overview встречается `sqi_history`, в русской актуальной документации — `sqi-history`; этот метод вне текущего scope, перед реализацией проверить live.
- PRO/β `pro/serp` не гарантирован обычному OAuth-клиенту; без PRO-доступа считать недоступным.
- `query-analytics/list` актуален, но не следует смешивать с legacy `search-queries/*`: у него другой POST-контракт, статистические поля (`IMPRESSIONS`, `CLICKS`, `POSITION`, `CTR`, `DEMAND`) и лимит 10 000 запросов/час.

## Рекомендуемые MCP tools

Read-only baseline:

1. `webmaster_get_user`
2. `webmaster_list_hosts`
3. `webmaster_get_host`
4. `webmaster_get_host_summary`
5. `webmaster_get_indexing_history`
6. `webmaster_list_indexed_urls`
7. `webmaster_get_search_pages_history`
8. `webmaster_get_search_events_history`
9. `webmaster_list_popular_queries`
10. `webmaster_get_queries_history`
11. `webmaster_get_query_history`
12. `webmaster_get_diagnostics`
13. `webmaster_list_sitemaps`
14. `webmaster_get_sitemap`
15. `webmaster_list_user_sitemaps`
16. `webmaster_get_recrawl_quota`
17. `webmaster_list_recrawl_tasks`
18. `webmaster_get_recrawl_task`

Write, disabled by default:

19. `webmaster_submit_url_for_recrawl`
20. `webmaster_submit_sitemap_for_recrawl` (после live-spike v4.1)

Для всех list-tools MCP должен ограничивать фактический output, возвращать `count`, `offset/cursor` и `has_more` как нормализованные метаданные, не скрывая upstream pagination.

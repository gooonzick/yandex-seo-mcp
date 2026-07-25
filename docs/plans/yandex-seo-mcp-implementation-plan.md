# План реализации Yandex SEO MCP

## 1. Цель

Создать MCP-сервер, через который AI-клиенты смогут безопасно получать и анализировать данные:

- Яндекс Метрики: счетчики, цели, агрегированные отчеты и сырые данные Logs API;
- Яндекс Вебмастера: сайты, индексирование, поисковые запросы, диагностика и Sitemap;
- позднее — выполнять явно подтвержденные изменяющие операции.

Первый релиз ориентирован на одного пользователя, локальный запуск через `stdio` и read-only сценарии. Удаленный HTTP-транспорт, многопользовательский OAuth и write-tools добавляются после стабилизации API-клиентов.

## 2. Принятые технические решения

- Runtime: актуальная LTS-версия Node.js.
- Язык: TypeScript в строгом режиме, ESM.
- Package manager: npm с lockfile; выбран единый воспроизводимый toolchain для установки, тестов и публикации.
- MCP SDK: `@modelcontextprotocol/sdk` v1.x; не использовать alpha-ветку v2 до стабилизации.
- Валидация входов и структурированных выходов: Zod.
- Тесты: Vitest и `InMemoryTransport` из MCP SDK.
- HTTP: стандартный `fetch` с общей оберткой для timeout, retry, pagination и нормализации ошибок.
- Логи: структурированные JSON-сообщения только в `stderr`; `stdout` зарезервирован под MCP/stdio.

## 3. Архитектура

```text
MCP client
    │
    ▼
MCP tools / schemas
    │
    ├── domain services
    │     ├── metrica
    │     └── webmaster
    │
    ├── safety policy
    ├── pagination / output limits
    └── error mapper
          │
          ▼
Yandex HTTP clients
    ├── OAuth token provider
    ├── retry + rate-limit handling
    └── response validation
```

Предлагаемая структура:

```text
src/
  index.ts
  server.ts
  config.ts
  transports/
  auth/
  shared/
    http-client.ts
    errors.ts
    pagination.ts
    dates.ts
    output-limits.ts
  metrica/
    client.ts
    schemas.ts
    service.ts
    tools/
  webmaster/
    client.ts
    schemas.ts
    service.ts
    tools/
tests/
  unit/
  contract/
  integration/
```

MCP-слой не должен знать URL Яндекса. Он валидирует аргументы, вызывает сервис и возвращает компактный `structuredContent`. HTTP-клиенты отвечают только за протокол Яндекса.

## 4. Аутентификация и конфигурация

### MVP

- OAuth-токен передается через переменную окружения или путь к локальному secret-файлу.
- Токен никогда не принимается аргументом MCP tool, не выводится в логах и ошибках.
- На старте выполняется проверка конфигурации без печати секрета.
- Для Метрики и Вебмастера допускаются отдельные токены, плюс общий fallback-токен.

Пример логической конфигурации:

- `YANDEX_METRICA_TOKEN`
- `YANDEX_WEBMASTER_TOKEN`
- `YANDEX_OAUTH_TOKEN` как fallback
- timeout, максимальное число retry и предельный размер результата

### После MVP

- Authorization Code + PKCE для удаленного сервера;
- зашифрованное хранилище refresh/access tokens;
- разделение токенов по пользователям и tenant/session;
- отзыв токенов и аудит изменяющих операций.

Точные OAuth scopes нужно зафиксировать отдельным результатом API-spike по официальной OAuth-документации: минимальный read-only набор и отдельный write-набор.

## 5. Каталог инструментов MVP

Имена стабильны и имеют namespace-префикс. Каждый list/report tool поддерживает ограничение объема и по возможности курсор.

### Общие

| Tool                      | Назначение                                                      |
| ------------------------- | --------------------------------------------------------------- |
| `yandex_connection_check` | Проверить токены и доступность обоих API без раскрытия секретов |
| `yandex_capabilities`     | Показать включенные API и доступные read/write-возможности      |

### Яндекс Метрика

| Tool                          | Назначение                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `metrica_list_counters`       | Список доступных счетчиков                                                    |
| `metrica_get_counter`         | Основные сведения о счетчике                                                  |
| `metrica_list_goals`          | Цели счетчика                                                                 |
| `metrica_get_report`          | Универсальный отчет `/stat/v1/data` с dimensions, metrics, filters и периодом |
| `metrica_get_timeseries`      | Динамика выбранных метрик по времени                                          |
| `metrica_get_traffic_summary` | Упрощенный SEO/traffic summary с безопасными предустановками                  |
| `metrica_get_search_traffic`  | Поисковые системы, визиты, пользователи, конверсии                            |

`metrica_get_report` должен иметь allowlist/валидацию параметров, предел строк и явный признак sampling/чувствительных данных, если он присутствует в ответе.

### Logs API — второй шаг MVP

| Tool                         | Назначение                                                    |
| ---------------------------- | ------------------------------------------------------------- |
| `metrica_logs_evaluate`      | Оценить возможность и размер выгрузки                         |
| `metrica_logs_create`        | Создать выгрузку                                              |
| `metrica_logs_status`        | Проверить готовность и список частей                          |
| `metrica_logs_download_part` | Получить одну часть с жестким лимитом размера                 |
| `metrica_logs_cancel`        | Отменить/очистить созданную выгрузку, только с подтверждением |

Большие выгрузки нельзя возвращать целиком в контекст модели. Предпочтение: агрегирование, выбор полей, ограничение строк или сохранение в локальный файл с возвратом метаданных.

### Яндекс Вебмастер

| Tool                           | Назначение                                             |
| ------------------------------ | ------------------------------------------------------ |
| `webmaster_get_user`           | Получить идентификатор текущего API-пользователя       |
| `webmaster_list_hosts`         | Список сайтов и статус прав                            |
| `webmaster_get_host`           | Сведения об одном сайте                                |
| `webmaster_get_summary`        | Сводка по индексированию и поисковым показателям       |
| `webmaster_get_indexing_stats` | Динамика проиндексированных/исключенных страниц        |
| `webmaster_get_search_queries` | Популярные запросы с показами, кликами, CTR и позицией |
| `webmaster_get_query_history`  | История показателей по запросу/группе                  |
| `webmaster_get_diagnostics`    | Диагностические проблемы сайта                         |
| `webmaster_list_sitemaps`      | Sitemap и их статусы                                   |
| `webmaster_get_sitemap`        | Детали обработки Sitemap                               |

Точные соответствия tools ↔ endpoints и доступные фильтры фиксируются contract-тестами во время API-spike, поскольку разделы API имеют разные формы пагинации и квоты.

## 6. Write-tools после MVP

Изменяющие операции выключены по умолчанию:

- добавление сайта;
- добавление/удаление Sitemap;
- отправка URL на переобход;
- управление счетчиками, целями и доступами;
- очистка Logs API request.

Для каждой операции нужны:

1. отдельная настройка `ENABLE_WRITE_TOOLS`;
2. read-before-write и показ текущего состояния;
3. точная схема входа без произвольного JSON;
4. аннотация destructive/idempotent;
5. явное подтверждение для удаления и массовых действий;
6. audit log без секретов и персональных данных.

## 7. Ошибки, лимиты и надежность

- Нормализовать ошибки в категории: `AUTH`, `PERMISSION`, `NOT_FOUND`, `VALIDATION`, `RATE_LIMIT`, `YANDEX_API`, `NETWORK`, `TIMEOUT`.
- Возвращать безопасное сообщение, HTTP status, request ID и retry hint; не возвращать токен или полный заголовок запроса.
- Retry только для сетевых сбоев, `429` и временных `5xx`; exponential backoff + jitter, с учетом `Retry-After`.
- Не повторять автоматически неидемпотентные POST-запросы без idempotency-стратегии.
- Ограничить период отчетов, число dimensions/metrics, размер страницы, суммарные строки и байты ответа.
- Реальные квоты и заголовки rate limit измерить в API-spike; не зашивать непроверенные числа.
- Даты принимать в ISO `YYYY-MM-DD`; timezone счетчика показывать в результате.

## 8. Безопасность и приватность

- Минимальные OAuth scopes и read-only режим по умолчанию.
- Редакция токенов, cookies, authorization headers и чувствительных query-параметров.
- Защита от SSRF: base URL фиксирован, произвольный URL пользователь передать не может.
- Никаких универсальных tools вида `raw_api_request`.
- Фильтры Метрики передаются как данные, а не интерпретируются как код.
- Предупреждение о статистической приватности и скрытии малых аудиторий.
- В integration fixtures не хранить реальные токены, домены, user IDs и выгрузки.

## 9. Стратегия тестирования

### Unit

- Zod-схемы и граничные значения;
- OAuth headers и redaction;
- pagination, backoff, даты, лимиты ответа;
- mapping ошибок Яндекса в MCP errors.

### Contract

- записанные обезличенные fixtures официальных ответов;
- успешные ответы и типовые `400/401/403/404/429/5xx`;
- обнаружение несовместимых изменений схем без чрезмерно строгой валидации дополнительных полей.

### MCP end-to-end

- `InMemoryTransport`: list tools, valid call, invalid args, structured output, error path;
- отдельный smoke-test собранного `stdio` процесса;
- проверка, что в `stdout` нет логов.

### Live integration

- запускается только при наличии test tokens;
- read-only тесты на отдельном тестовом счетчике/сайте;
- write-тесты отключены по умолчанию и никогда не запускаются в обычном CI.

## 10. Этапы реализации

### Этап 0 — API-spike

- зарегистрировать OAuth-приложение и тестовые ресурсы;
- подтвердить scopes, endpoint paths, пагинацию, квоты и форматы ошибок;
- выполнить по одному минимальному запросу к каждому разделу;
- сохранить обезличенные fixtures и таблицу endpoint coverage.

**Результат:** подтвержденный API-контракт и отсутствие критических неизвестных.

### Этап 1 — каркас MCP

- TypeScript, lint, format, build, test;
- config/token provider, HTTP client, error mapper;
- `stdio` transport, health/capabilities tools;
- unit и MCP e2e tests.

**Результат:** устанавливаемый сервер, корректно подключаемый MCP-клиентом.

### Этап 2 — read-only Метрика

- counters, goals, generic report и SEO presets;
- лимиты, sampling/privacy metadata;
- contract и live smoke tests.

**Результат:** полезный аналитический MVP без Logs API.

### Этап 3 — read-only Вебмастер

- hosts, summary, indexing, queries, diagnostics, Sitemap;
- унификация домена/host ID и pagination.

**Результат:** единый read-only MCP для SEO-аналитики.

### Этап 4 — Logs API

- evaluate → create → poll → bounded download;
- локальные артефакты и агрегация больших выгрузок;
- cancellation с подтверждением.

**Результат:** контролируемая работа с сырыми данными без переполнения контекста.

### Этап 5 — production hardening

- Streamable HTTP как отдельная точка входа;
- OAuth PKCE и multi-user token storage;
- observability, audit, concurrency/rate-limit controls;
- контейнер, CI, release artifacts и инструкции для популярных MCP-клиентов.

### Этап 6 — write-tools

- добавлять по одному use case после threat review;
- feature flags, annotations, confirmations и audit;
- live tests только в изолированном тестовом окружении.

## 11. Критерии готовности MVP

- Один install/run сценарий и пример конфигурации MCP-клиента.
- Не менее одного e2e теста на каждый публичный tool.
- Ошибки Яндекса преобразуются в понятные и безопасные ответы.
- Токены не появляются в stdout, stderr, snapshots и fixtures.
- Любой результат имеет предсказуемый предел строк/байтов.
- Read-only Метрика и Вебмастер проходят live smoke tests.
- Документация содержит scopes, настройку OAuth, troubleshooting и ограничения.

## 12. Риски

| Риск                                   | Снижение                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------- |
| Разные модели пагинации и ошибок       | Отдельные API-клиенты и единый внутренний интерфейс                         |
| Большие отчеты переполняют контекст    | Presets, limits, cursor, aggregation, file artifacts                        |
| Нестабильные квоты                     | Backoff, concurrency limit, cache metadata, измерение в spike               |
| Sampling/скрытие чувствительных данных | Явно возвращать metadata и предупреждения                                   |
| Случайные изменения данных             | Read-only default, write feature flag, confirmations                        |
| Изменения API                          | Contract fixtures, permissive response parsing, регулярные live smoke tests |

## 13. Первые задачи в backlog

1. Зафиксировать Node.js и зависимости MCP SDK/Zod/Vitest.
2. Создать OAuth-приложение и тестовые счетчик/сайт.
3. Подготовить таблицу endpoints/scopes/quotas/errors по обоим API.
4. Реализовать token provider и redacting HTTP client.
5. Поднять MCP server со `stdio` и `yandex_connection_check`.
6. Реализовать `metrica_list_counters` и `metrica_get_report`.
7. Реализовать `webmaster_get_user` и `webmaster_list_hosts`.
8. Добавить contract fixtures и `InMemoryTransport` e2e.
9. Расширять tools вертикальными срезами: schema → client → service → tool → tests → docs.

## 14. Источники для сверки

- [API Яндекс Метрики](https://yandex.ru/dev/metrika/ru/)
- [API отчетов Метрики](https://yandex.ru/dev/metrika/ru/stat/index)
- [API Яндекс Вебмастера](https://yandex.ru/dev/webmaster/)
- [Документация MCP TypeScript SDK v1.29.0](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md)

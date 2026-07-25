# Статус реализации

## Выполнено

- TypeScript/ESM проект, строгая типизация и npm packaging.
- MCP SDK v1.29.0, `stdio` и Streamable HTTP на Hono.
- Общий OAuth HTTP-клиент с timeout, retry/backoff и безопасными ошибками.
- Read-only инструменты Метрики, Reports API и основной lifecycle Logs API.
- Read-only инструменты Webmaster для hosts, indexing, search queries, diagnostics, Sitemap и recrawl queue.
- Мониторинг запросов и URL через `query-analytics/list` с типизированными фильтрами и сортировкой.
- Составные SEO-инструменты для поиска точек роста и сравнения периодов Метрики.
- Подтверждаемые write-tools: очистка Logs request и постановка URL на переобход.
- Ограничения строк/байтов и `structuredContent`.
- Unit, MCP in-memory, stdio process и HTTP transport тесты.
- Opt-in live smoke tests.
- Документация конфигурации и исследованные API-контракты.

## Требует внешней конфигурации

- Live smoke tests нельзя выполнить без пользовательских OAuth-токенов и доступных тестовых счетчика/сайта.
- Регистрация OAuth-приложения выполняется владельцем проекта в аккаунте Яндекса.

## Отложено осознанно

- Публичный multi-user OAuth Authorization Code + PKCE и encrypted token storage: это отдельный deployment-компонент, зависящий от выбранного хостинга и identity model.
- `query-analytics` реализован по официальному контракту; перед публикацией желательно сохранить live fixture с доступного сайта.
- Webmaster PRO/β endpoints доступны не всем аккаунтам и остаются вне стабильного контракта.
- Sitemap recrawl v4.1 write-tool: success contract плохо индексируется и должен пройти live contract test.
- Изменение счетчиков, целей и прав Метрики: не входит в безопасный SEO read-only baseline.

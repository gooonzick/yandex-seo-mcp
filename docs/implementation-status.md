# Статус реализации

## Выполнено

- TypeScript/ESM проект, строгая типизация и npm packaging.
- MCP SDK v1.29.0, `stdio` и Streamable HTTP на Hono.
- Общий OAuth HTTP-клиент с timeout, retry/backoff и безопасными ошибками.
- Read-only инструменты Метрики, детали целей и доступов, Reports API и полный lifecycle Logs API.
- Безопасные пресеты Метрики для органических посадочных страниц и поисковых фраз.
- Read-only инструменты Webmaster для hosts, verification, indexing, search queries, diagnostics, Sitemap, recrawl queue и статуса приоритетного переобхода Sitemap v4.1.
- Мониторинг запросов и URL через `query-analytics/list` с типизированными фильтрами и сортировкой.
- Составные SEO-инструменты для поиска точек роста и сравнения периодов Метрики.
- Анализ падения органического трафика посадочных страниц между периодами.
- Объединённая аналитика страниц Webmaster + Метрика, поиск каннибализации и прогноз прироста кликов.
- Пакетный SEO-аудит с health score и приоритетными рекомендациями.
- Сегментные и атрибуционные пресеты Метрики, включая ecommerce и comparison report.
- Persistent monitoring snapshots, regression alerts, retention и interval scheduler.
- Общая storage schema `v3`: monitoring snapshots, crawl runs/pages/issues/link
  edges/aggregates и SEO change journal; последовательные миграции `v1 → v2 → v3`.
- Идемпотентная запись crawl snapshots через `crawler_save_snapshot`: atomic write,
  partial-run markers, query denylist, dry-run/confirmation и storage telemetry.
- Стабильный crawl issue fingerprint `v2` для redirect, canonical, metadata,
  indexing и link issues с backward-compatible чтением fingerprint `v1`.
- Единый keyset cursor pagination contract: versioned opaque cursor, filter/order
  binding, normalized errors и `pageInfo`; применен в `monitor_list_snapshots`.
- Atomic rolling storage backup, sequential forward migrations, fail-closed
  corruption handling и fixture-based rollback tests.
- Compact filtered crawl snapshot history via `crawler_list_snapshots` and bounded
  sectioned details via `crawler_get_snapshot`, both with cursor pagination.
- Deterministic crawl snapshot comparison via `crawler_compare_snapshots`: page
  health/field diff, stable-fingerprint issue lifecycle, isolated crawl parameter
  changes and bounded examples.
- Grouped technical regression detection via `crawler_detect_regressions` for
  HTTP errors, noindex, canonical drift, redirect chains, orphan pages and lost
  internal links, with deterministic scoring and target-level exclusions.
- Age/count crawl retention and opt-in atomic cleanup via
  `crawler_cleanup_history`, with protected active runs, deletion-volume dry-run
  and explicit confirmation for destructive execution.
- Bounded SEO change journal via `seo_record_change` and `seo_list_changes`, with
  strict change types, same-origin URL scope, external-reference idempotency and
  cursor-paginated filters.
- Crawl impact correlation via `seo_compare_change_crawl`: nearest saved crawl
  before/after the journal timestamp, URL/type-aware diff filtering and explicit
  `insufficient_data` results when either side is unavailable.
- Observational Metrica impact via `seo_measure_change_metrica`: equal whole-week
  organic periods around a journal entry, scoped visits/users/conversions and
  landing-page deltas, minimum-volume gates plus sampling/data-lag limitations.
- MCP resources и prompts для типовых SEO workflow.
- GET cache, bounded concurrency, HTTP rate limiting, telemetry и readiness endpoint.
- Multi-user OAuth Authorization Code + PKCE, encrypted profile storage и изолированные bearer sessions.
- Безопасный same-origin crawler с DNS/IP SSRF-защитой, robots.txt, Sitemap, on-page и structured-data проверками.
- Анализ внутренней перелинковки: orphan/deep/weak pages, broken links и duplicate groups.
- Сверка Sitemap, crawl results и Webmaster indexing samples с recrawl backlog.
- Детерминированная кластеризация поисковых запросов и классификация интента.
- Карта query cluster → landing page, semantic cannibalization и content gap scoring.
- Evidence-based content briefs с outline, FAQ, schema и internal-link suggestions.
- Подтверждаемые write-tools: управление счётчиками и доступами Метрики, host/verification/Sitemap Webmaster, отмена/очистка Logs request и постановка URL/Sitemap на переобход.
- Ограничения строк/байтов и `structuredContent`.
- Unit, MCP in-memory, stdio process и HTTP transport тесты.
- Opt-in live smoke tests.
- Документация конфигурации и исследованные API-контракты.

## Требует внешней конфигурации

- Live smoke tests нельзя выполнить без пользовательских OAuth-токенов и доступных тестовых счетчика/сайта.
- Регистрация OAuth-приложения выполняется владельцем проекта в аккаунте Яндекса.

## Отложено осознанно

- `query-analytics` реализован по официальному контракту; перед публикацией желательно сохранить live fixture с доступного сайта.
- Webmaster PRO/β endpoints доступны не всем аккаунтам и остаются вне стабильного контракта.
- Sitemap recrawl v4.1 write-tool требует подтверждения; success contract должен пройти live contract test перед публикацией.
- Изменение целей Метрики остаётся вне безопасного SEO baseline; счётчики и права доступны через ограниченные подтверждаемые write-tools.

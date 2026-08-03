# Backlog развития Yandex SEO MCP

## 1. Цель

Превратить MCP из набора аналитических инструментов в постоянно работающий SEO-контур:

1. фиксировать состояние сайта и выполненные изменения;
2. обнаруживать технические и поисковые регрессии;
3. связывать изменения с Метрикой и Вебмастером;
4. формировать единый приоритетный план действий;
5. безопасно выполнять разрешенные операции.

## 2. Обозначения

- Приоритет: `P0` — ближайший релиз, `P1` — следующий этап, `P2` — развитие.
- Размер: `S` — до 2 дней, `M` — 3–5 дней, `L` — 1–2 недели, `XL` — требует декомпозиции.
- Статус всех задач при создании backlog: `planned`.
- Любой новый tool должен иметь Zod-схему, лимиты результата, нормализованные ошибки, telemetry, unit-тесты и MCP e2e-тест.

## 3. Рекомендуемый порядок релизов

### Release 1 — Crawl History

Персистентная история обходов, сравнение состояний и технические регрессии.

### Release 2 — SEO Impact

Журнал SEO-изменений и оценка их влияния по данным Метрики и Вебмастера.

### Release 3 — Action Center

Единый дедуплицированный backlog проблем и возможностей с оценкой приоритета.

### Release 4 — Monitoring & Integrations

Правила оповещений, внешние каналы, спрос, SERP и портфель сайтов.

## 4. P0 — Persistent Crawl Diff

### CRWL-001 — Спроектировать модель хранения crawl snapshots

- Статус: `completed` (2026-08-03)
- Размер: `M`
- Зависимости: нет
- Результат: схема для run, page, issue, link edge и агрегатов.
- Критерии приемки:
  - один crawl имеет стабильный ID, target, timestamps и параметры запуска;
  - URL нормализуются одинаково при записи и сравнении;
  - предусмотрены миграции и версия схемы;
  - хранение ограничивается retention-настройкой;
  - старые monitoring snapshots продолжают читаться.

Реализация: [контракт хранения crawl snapshots](../architecture/crawl-snapshot-storage.md),
версионированная схема `v2`, миграция monitoring `v1`, единая нормализация URL и
retention policy с unit-тестами.

### CRWL-002 — Сохранять завершенный аудит

- Статус: `completed` (2026-08-03)
- Размер: `M`
- Зависимости: CRWL-001
- Предлагаемый tool: `crawler_save_snapshot`
- Критерии приемки:
  - сохраняются страницы, технические признаки, issues и link graph;
  - повторная запись одного run идемпотентна;
  - неполный crawl явно маркируется;
  - секреты, query-параметры из denylist и содержимое страниц не сохраняются.

Реализация: `crawler_audit_site` возвращает стабильный `runId` и явный статус
`completed`/`partial`, а `crawler_save_snapshot` выполняет dry-run или подтвержденную
идемпотентную запись страниц, технических признаков, issues, link graph и агрегатов.
Запись атомарна, применяет retention и очищает credentials, fragments и denylist
query-параметры; response body и тексты fetch errors не сохраняются.

### CRWL-003 — Добавить список и получение crawl snapshots

- Размер: `S`
- Зависимости: CRWL-002
- Tools: `crawler_list_snapshots`, `crawler_get_snapshot`
- Критерии приемки:
  - фильтрация по target и диапазону дат;
  - cursor pagination;
  - компактный результат по умолчанию;
  - детальные данные доступны через отдельный resource/tool.

### CRWL-004 — Ввести стабильный fingerprint проблемы

- Статус: `completed` (2026-08-03)
- Размер: `M`
- Зависимости: CRWL-001
- Критерии приемки:
  - одинаковая проблема на одном URL получает одинаковый fingerprint;
  - тексты и изменчивые значения не ломают идентичность;
  - версия алгоритма сохраняется вместе с issue;
  - тестами покрыты redirect, canonical, metadata, indexing и link issues.

Реализация: fingerprint `v2` строится из нормализованного URL scope, category и
issue code; для link issues дополнительно учитывается related URL. Тексты, severity,
HTTP status и другие изменчивые details не входят в identity. Snapshot persistence
добавляет отдельные `ORPHAN_PAGE` и `BROKEN_INTERNAL_LINK`, а schema продолжает
читать ранее записанные fingerprint `v1`.

### CRWL-005 — Реализовать сравнение двух обходов

- Размер: `L`
- Зависимости: CRWL-003, CRWL-004
- Tool: `crawler_compare_snapshots`
- Критерии приемки:
  - состояния: `new`, `resolved`, `worsened`, `improved`, `unchanged`;
  - сравниваются URL, status, indexability, canonical, title, description, headings и links;
  - отделяются изменения конфигурации crawl от изменений сайта;
  - результат содержит summary и ограниченную выборку примеров.

### CRWL-006 — Выявлять технические регрессии

- Размер: `M`
- Зависимости: CRWL-005
- Tool: `crawler_detect_regressions`
- Критерии приемки:
  - правила severity и confidence детерминированы;
  - поддерживаются новые 4xx/5xx, noindex, canonical drift, redirect chains, orphan pages и потеря внутренних ссылок;
  - массовое изменение распознается как один incident с affected URL count;
  - false-positive exclusions настраиваются для target.

### CRWL-007 — Добавить retention и очистку истории

- Размер: `S`
- Зависимости: CRWL-002
- Критерии приемки:
  - лимиты по возрасту и числу runs;
  - очистка не затрагивает активный run;
  - destructive tool доступен только при включенных write-tools;
  - dry-run показывает объем удаления.

## 5. P0 — SEO Change Impact

### IMP-001 — Создать журнал SEO-изменений

- Размер: `M`
- Зависимости: CRWL-001
- Tools: `seo_record_change`, `seo_list_changes`
- Критерии приемки:
  - change содержит target, timestamp, тип, URL scope, описание и внешний reference;
  - поддерживаются deploy, content, metadata, redirect, internal links, robots, sitemap и manual annotation;
  - запись идемпотентна по external reference;
  - никаких произвольных секретных payload.

### IMP-002 — Сопоставлять изменение с crawl diff

- Размер: `M`
- Зависимости: IMP-001, CRWL-005
- Критерии приемки:
  - определяется первый crawl до и после изменения;
  - показываются только релевантные URL и типы изменений;
  - отсутствие достаточных данных возвращается как `insufficient_data`, а не ошибка.

### IMP-003 — Оценивать влияние по Метрике

- Размер: `L`
- Зависимости: IMP-001
- Критерии приемки:
  - сравниваются равные периоды до/после;
  - учитываются день недели и минимальный объем трафика;
  - доступны organic visits, users, conversions и landing pages;
  - результат не объявляет причинность и содержит confidence/limitations.

### IMP-004 — Оценивать влияние по Вебмастеру

- Размер: `M`
- Зависимости: IMP-001
- Критерии приемки:
  - сравниваются impressions, clicks, CTR, position и indexing events;
  - поддерживается URL scope изменения;
  - учитывается задержка появления данных.

### IMP-005 — Объединить технические и поисковые сигналы

- Размер: `L`
- Зависимости: IMP-002, IMP-003, IMP-004
- Tool: `seo_measure_change_impact`
- Критерии приемки:
  - единый timeline: change → crawl diff → indexing → traffic/search metrics;
  - итог: positive, negative, mixed, neutral или insufficient data;
  - приводятся наблюдаемые evidence и альтернативные объяснения;
  - можно повторно рассчитать результат с обновившимися данными.

## 6. P0 — Unified Action Center

### ACT-001 — Определить единую модель action item

- Размер: `M`
- Зависимости: нет
- Критерии приемки:
  - поля: source, category, affected scope, severity, impact, confidence, effort, evidence и fingerprint;
  - lifecycle: open, acknowledged, in_progress, resolved, ignored;
  - source evidence остается трассируемым до исходного tool/result.

### ACT-002 — Нормализовать сигналы существующих подсистем

- Размер: `L`
- Зависимости: ACT-001, CRWL-006
- Критерии приемки:
  - ingest из crawler, Webmaster diagnostics, content decay, cannibalization, content gaps и monitoring alerts;
  - повторный запуск не создает дубликаты;
  - исчезнувшие сигналы переводятся в resolved только после подтверждения.

### ACT-003 — Реализовать scoring

- Размер: `M`
- Зависимости: ACT-002
- Критерии приемки:
  - формула документирована и детерминирована;
  - отдельно показываются impact, confidence и effort;
  - пользователь может переопределить веса target-level настройками;
  - отсутствие Метрики не обнуляет технические задачи.

### ACT-004 — Генерировать приоритетный план действий

- Размер: `M`
- Зависимости: ACT-003
- Tool: `seo_build_action_plan`
- Критерии приемки:
  - фильтры по target, category, severity, status и effort;
  - группировка массовых однотипных проблем;
  - каждая рекомендация содержит evidence и проверяемый expected outcome;
  - результат ограничен top-N и поддерживает cursor pagination.

### ACT-005 — Управлять состоянием задач

- Размер: `M`
- Зависимости: ACT-004
- Tools: `seo_update_action_status`, `seo_list_actions`
- Критерии приемки:
  - изменения состояния пишутся в audit log;
  - resolved item может переоткрыться при повторной регрессии;
  - ignore требует причины и необязательного срока;
  - массовое изменение требует write-tools и dry-run.

## 7. P1 — Monitoring и уведомления

### MON-001 — Правила мониторинга

- Размер: `L`
- Tool: `monitor_manage_rules`
- Scope: thresholds, anomaly rules, cooldown, schedules и target filters.

### MON-002 — Дедупликация и lifecycle инцидентов

- Размер: `M`
- Зависимости: MON-001, CRWL-004
- Scope: open/update/resolve, occurrence count, first/last seen.

### MON-003 — Webhook-уведомления

- Размер: `M`
- Зависимости: MON-002
- Tools: `monitor_test_notification`, `monitor_list_deliveries`
- Scope: signed webhook, retry policy, secret redaction, delivery log.

### MON-004 — Адаптеры Telegram/Slack/email

- Размер: `L`
- Зависимости: MON-003
- Scope: opt-in providers, compact message templates, links to evidence.

## 8. P1 — Расширенный технический аудит

### TECH-001 — Structured data audit

- Размер: `L`
- Tool: `crawler_audit_structured_data`
- Scope: JSON-LD extraction, syntax, duplicate entities и базовые consistency checks.

### TECH-002 — Hreflang и multilingual audit

- Размер: `M`
- Tool: `crawler_check_hreflang`
- Scope: return links, language/region validation, canonical conflicts.

### TECH-003 — Redirect graph

- Размер: `M`
- Scope: chains, loops, mixed destinations, internal links to redirects.

### TECH-004 — JavaScript rendering adapter

- Размер: `XL`
- Scope: опциональный Playwright worker, строгие URL/byte/time limits, HTML diff до/после rendering.
- Примечание: выделить в отдельный процесс и держать выключенным по умолчанию.

### TECH-005 — Performance adapter

- Размер: `L`
- Scope: Lighthouse/PageSpeed provider, lab metrics, budgets и regression diff.

## 9. P1 — Спрос и SERP

### DEM-001 — Исследовать контракт источника поискового спроса

- Размер: `S`
- Результат: подтвержденные auth, quota, regions, seasonality и license constraints.
- Gate: не начинать реализацию до contract fixture.

### DEM-002 — Получать спрос и сезонность

- Размер: `L`
- Зависимости: DEM-001
- Tools: `wordstat_get_demand`, `wordstat_expand_queries` либо provider-neutral названия.

### DEM-003 — Добавить demand в query intelligence

- Размер: `M`
- Зависимости: DEM-002
- Tool: `seo_find_demand_gaps`
- Scope: demand, current visibility, business relevance и content coverage.

### SERP-001 — Спроектировать provider interface

- Размер: `M`
- Scope: query, region, device, locale, timestamp, organic results и SERP features.

### SERP-002 — Отслеживать позиции и конкурентов

- Размер: `L`
- Зависимости: SERP-001
- Tools: `serp_track_queries`, `serp_compare_competitors`.

### SERP-003 — Детектировать изменения выдачи

- Размер: `M`
- Зависимости: SERP-002
- Tool: `serp_detect_feature_changes`
- Scope: entrants, exits, rank volatility, landing URL changes и SERP features.

## 10. P2 — Безопасные write-tools

### WRITE-001 — Унифицированный approval/dry-run слой

- Размер: `L`
- Критерии приемки:
  - read-before-write;
  - preview точных изменений;
  - idempotency strategy;
  - audit log без секретов;
  - write-tools всегда требуют явного подтверждения.

### WRITE-002 — Пакетная отправка на переобход

- Размер: `M`
- Зависимости: WRITE-001
- Tool: `webmaster_submit_recrawl_batch`
- Scope: quota-aware batching, partial failure и resume.

### WRITE-003 — Управление Sitemap

- Размер: `M`
- Зависимости: WRITE-001, подтвержденный live contract
- Scope: add/delete/resubmit, exact target confirmation.

### WRITE-004 — Управление сайтами и верификацией

- Размер: `L`
- Зависимости: WRITE-001, подтвержденный API contract.

## 11. P2 — Портфель сайтов и отчеты

### PORT-001 — Target registry

- Размер: `M`
- Scope: связь Webmaster host, Metrica counter, canonical origin и monitoring policy.

### PORT-002 — Портфельная сводка

- Размер: `L`
- Зависимости: PORT-001, ACT-003
- Tool: `portfolio_get_overview`
- Scope: health, organic trend, open incidents и top opportunities.

### PORT-003 — Ранжирование рисков портфеля

- Размер: `M`
- Зависимости: PORT-002
- Tool: `portfolio_rank_risks`.

### RPT-001 — Экспорт отчетов

- Размер: `M`
- Scope: compact JSON/CSV/Markdown artifacts с лимитами размера и без PII.

## 12. Сквозные engineering-задачи

### ENG-001 — Фоновые jobs для долгих операций

- Приоритет: `P0`
- Размер: `L`
- Scope: queued/running/succeeded/failed/cancelled, progress, TTL и recovery.

### ENG-002 — Cursor pagination contract

- Статус: `completed` (2026-08-03)
- Приоритет: `P0`
- Размер: `M`
- Scope: единая схема для snapshots, actions, jobs и больших API-выборок.

Реализация: общий versioned opaque cursor, canonical filter scope, keyset ordering,
единые `limit`/`cursor` inputs и `pageInfo` output, нормализованные validation errors.
Референсная интеграция — `monitor_list_snapshots`; контракт и правила стабильного
ключа зафиксированы в [architecture/cursor-pagination.md](../architecture/cursor-pagination.md).

### ENG-003 — Artifact resources

- Приоритет: `P1`
- Размер: `M`
- Scope: crawl diff, impact report и action plan как MCP resources вместо крупных inline results.

### ENG-004 — Target-level policies

- Приоритет: `P1`
- Размер: `M`
- Scope: exclusions, retention, thresholds, schedules и allowed write actions.

### ENG-005 — Backup и migration tests

- Статус: `completed` (2026-08-03)
- Приоритет: `P0`
- Размер: `M`
- Scope: forward migrations, rollback procedure, corrupted store behavior и fixtures.

Реализация: последовательный migration registry, atomic rolling `.bak` перед
overwrite, fail-closed `StorageCorruptionError`, v1/v2/corrupted fixtures и тест
полного rollback-сценария. Процедура восстановления описана в
[architecture/storage-backup-and-recovery.md](../architecture/storage-backup-and-recovery.md).

### ENG-006 — Observability для новых подсистем

- Приоритет: `P0`
- Размер: `S`
- Scope: job latency, store size, diff counts, alert deliveries и provider quota telemetry.

## 13. Definition of Done

Задача считается завершенной, когда:

1. контракт и ограничения зафиксированы в документации;
2. вход и выход валидируются строгими схемами;
3. результат имеет лимиты строк и байтов;
4. ошибки нормализованы и не раскрывают токены/PII;
5. unit, integration и MCP e2e tests проходят;
6. для внешнего API сохранен обезличенный contract fixture;
7. destructive/write операция имеет dry-run, audit и явное подтверждение;
8. README и `implementation-status.md` обновлены;
9. `pnpm lint`, `pnpm typecheck` и `pnpm test` проходят.

## 14. Первый спринт

Рекомендуемый scope первого спринта:

1. CRWL-001 — модель хранения crawl snapshots;
2. CRWL-004 — fingerprint проблемы;
3. ENG-002 — cursor pagination contract;
4. ENG-005 — migration tests;
5. CRWL-002 — сохранение завершенного аудита;
6. CRWL-003 — list/get tools.

Итог спринта: сервер сохраняет историю обходов и безопасно отдает ее через MCP; сравнение и регрессии переходят в следующий спринт.

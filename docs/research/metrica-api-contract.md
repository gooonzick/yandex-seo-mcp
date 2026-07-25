# Контракты Yandex Metrica API для MCP

Проверено по официальной документации 2026-07-24. Ниже описан read-only минимум и полный жизненный цикл Logs API, нужные для реализации MCP.

## Общие правила

- Host: `https://api-metrika.yandex.net`.
- Авторизация для всех методов: `Authorization: OAuth <token>`.
- JSON-запросы: `Content-Type: application/json`; JSON-ответы — UTF-8.
- Management API и Logs API имеют base path `/management/v1`.
- Reports API имеет base path `/stat/v1`.
- При `401` токен отсутствует или недействителен; код MCP не должен принимать или возвращать токен в аргументах/результатах tools.
- Массивы в query обычно кодируются через запятую. Значения фильтров, `row_ids` и знак `+` в timezone должны проходить корректное URL-кодирование.

## Счётчики (Management API)

### Список доступных счётчиков

`GET /management/v1/counters`

Обязательных query-параметров нет.

Практически полезные параметры:

| Параметр        | Тип / default     | Назначение                                                                                               |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `counter_ids`   | integer[]         | Фильтр по ID                                                                                             |
| `field`         | CSV string        | Дополнительные поля, например `goals,mirrors,grants,filters,operations,counter_flags,measurement_tokens` |
| `favorite`      | boolean / `false` | Только избранные                                                                                         |
| `permission`    | CSV enum          | `own`, `view`, `edit`                                                                                    |
| `status`        | enum / `Active`   | `Active`, `Deleted`                                                                                      |
| `type`          | enum              | `simple`, `partner`                                                                                      |
| `search_string` | string            | Поиск по полному ID или подстроке имени/сайта/зеркал                                                     |
| `label_id`      | integer           | Фильтр по метке                                                                                          |
| `sort`          | enum / `Default`  | `None`, `Default`, `Visits`, `Hits`, `Uniques`, `Name`                                                   |
| `reverse`       | boolean / `true`  | Направление сортировки                                                                                   |
| `robots`        | boolean / `true`  | Учитывать визиты роботов                                                                                 |
| `offset`        | integer / `1`     | Номер первого элемента; индексация с 1                                                                   |
| `per_page`      | integer / `1000`  | Размер страницы                                                                                          |

Ответ `200`: `{ rows: number, counters: CounterBrief[] }`. Для MCP сохранять как минимум `id`, `name`, `site`/`site2`, `status`, `activity_status`, `owner_login`, `permission`, `favorite`, `type`, `create_time`, `time_zone_name`, `time_zone_offset`; дополнительные поля зависят от `field`.

### Информация о счётчике

`GET /management/v1/counter/{counterId}`

- Path required: `counterId: integer`.
- Query optional: `field` (те же дополнительные поля), `callback` (для MCP не использовать).
- Ответ `200`: `{ counter: CounterFull }`.

Клиент должен считать схему расширяемой: `CounterFull` велик и меняется; неизвестные поля не отбрасывать на HTTP-слое.

## Цели (Management API)

### Список целей счётчика

`GET /management/v1/counter/{counterId}/goals`

- Path required: `counterId: integer`.
- Ответ `200`: `{ goals: Goal[] }`.

### Информация о цели

`GET /management/v1/counter/{counterId}/goal/{goalId}`

- Path required: `counterId: integer`, `goalId: integer`.
- Ответ `200`: `{ goal: Goal }`.

Общие важные поля union-типа `Goal`: `id`, `name`, `type`, `default_price`, `goal_source` (`user` или `auto`), `is_favorite`, `status`. В зависимости от `type` присутствуют `conditions[{type,url}]`, `depth`, `steps` и другие поля. Известные типы включают `action`, `chat`, `email`, `file`, `messenger`, `number`, `payment_system`, `phone`, `search`, `social`, `step`, `url`, `visit_duration`. Zod-схема ответа должна быть passthrough, а не закрытым discriminated union.

Примечание: тот же список можно запросить как часть счётчика через `GET .../counter/{counterId}?field=goals`; отдельный `/goals` удобнее для MCP-контракта.

## Reports API: таблица

`GET /stat/v1/data`

Обязательные параметры:

- `ids`: один или несколько ID счётчиков через запятую;
- `metrics`: CSV метрик, максимум 20.

Основные optional:

| Параметр                                 | Правило                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `dimensions`                             | CSV группировок, максимум 10                                                                                 |
| `date1`                                  | `YYYY-MM-DD`, `today`, `yesterday`, `NdaysAgo`; default `6daysAgo`                                           |
| `date2`                                  | те же форматы; default `today`                                                                               |
| `filters`                                | до 10 уникальных dimensions/metrics, 20 отдельных фильтров, 10 000 символов в строке, 100 значений в условии |
| `sort`                                   | CSV dimensions/metrics; `-` означает по убыванию                                                             |
| `limit`                                  | default 100, максимум 100 000                                                                                |
| `offset`                                 | default 1, индексация с 1                                                                                    |
| `accuracy`                               | управление долей выборки                                                                                     |
| `proposed_accuracy`                      | boolean; разрешает API повысить accuracy                                                                     |
| `preset`                                 | шаблон, например `sources_summary`                                                                           |
| `include_undefined`                      | включить undefined первой dimension                                                                          |
| `timezone`                               | `±hh:mm`; `+` кодировать как `%2B`                                                                           |
| `lang`, `pretty`, `direct_client_logins` | локаль, форматирование, логины клиентов Direct                                                               |

Ответ `200`:

- `query`: нормализованные параметры запроса;
- `data[]`: `{ dimensions: Array<{name: string, id?: string|number, ...}>, metrics: number[] }`;
- `total_rows`, `total_rows_rounded`;
- `sampled`, `sample_share` (0..1), `sample_size`, `sample_space`;
- `contains_sensitive_data`, `data_lag`;
- `totals`, `min`, `max`: `number[]`.

Для постраничного чтения следующий `offset = current offset + data.length`; окончание — пустая страница либо достигнут `total_rows`. Не путать официальный параметр `ids` с встречающимся в старых примерах `id`/`counter_id`.

### SEO-пресеты Reports API

- Органические посадочные страницы: dimension `ym:s:startURL`, фильтр `ym:s:lastSignTrafficSource=='organic'`.
- Органические поисковые фразы и посадочные страницы: dimensions `ym:s:lastSignSearchPhrase,ym:s:startURL` с тем же фильтром.
- Базовые метрики: `ym:s:visits`, `ym:s:users`, `ym:s:bounceRate`, `ym:s:avgVisitDurationSeconds`, `ym:s:anyGoalConversionRate`.
- Для конкретной цели последняя метрика заменяется на `ym:s:goal<goal_id>conversionRate`.

Эти контракты используются инструментами `metrica_get_landing_pages`, `metrica_get_search_phrases` и `seo_detect_content_decay`.

## Reports API: динамика

`GET /stat/v1/data/bytime`

Обязательные параметры: `ids`, `metrics` (максимум 20). Общие параметры совпадают с `/data`, кроме табличной пагинации `limit/offset`.

Специальные параметры:

- `group`, default `week`: `all`, `auto`, `minute`, `dekaminute`, `hour`, `day`, `week`, `month`, `quarter`, `year`, а также оптимизируемые `minutes`/`hours`;
- `row_ids`: JSON-массив массивов ключей dimensions, например `[["organic"],["direct"]]`;
- `top_keys`: число строк, если нет `row_ids`; default 7, максимум 30;
- `keys_sort`: сортировка ключей;
- `include_annotations` и `annotation_groups`.

Ответ `200` похож на `/data`, но:

- `data[].metrics` имеет тип `number[][]`: внешний индекс — метрика, внутренний — временные точки;
- `totals` — `number[][]`;
- может быть `annotations[][]` с `id`, `date`, `time`, `title`, `message`, `group`;
- также возвращаются `query`, `total_rows`, sampling-поля, `contains_sensitive_data`, `data_lag`.

## Logs API

Все четыре параметра `date1`, `date2`, `fields`, `source` для evaluate/create следует считать обязательными в MCP-схеме:

- даты в `YYYY-MM-DD`; `date2` не может быть текущим днём;
- `source`: `hits` (события) или `visits` (визиты);
- `fields`: CSV имён полей соответствующего source, длина строки не более 3000 символов;
- период одного запроса — не более одного года;
- фильтрации на уровне запроса нет.

### 1. Оценить возможность

`GET /management/v1/counter/{counterId}/logrequests/evaluate`

- Path required: `counterId`.
- Query required: `date1`, `date2`, `fields`, `source`.
- Ответ `200`: `{ log_request_evaluation: { possible: boolean, max_possible_day_quantity: number } }`.

Важно: актуальный официальный контракт не содержит `expected_size`; не закладывать это поле как обязательное.

### 2. Создать запрос

`POST /management/v1/counter/{counterId}/logrequests`

- Path required: `counterId`.
- Query required: `date1`, `date2`, `fields`, `source`.
- Query optional: `attribution`.
- Body отсутствует.
- Ответ `200`: `{ log_request: LogRequest }`.

`attribution`: `FIRST`, `LAST`, `LASTSIGN`, `LAST_YANDEX_DIRECT_CLICK`, `CROSS_DEVICE_LAST_SIGNIFICANT`, `CROSS_DEVICE_FIRST`, `CROSS_DEVICE_LAST_YANDEX_DIRECT_CLICK`, `CROSS_DEVICE_LAST`, `AUTOMATIC`.

### 3. Получить статус

`GET /management/v1/counter/{counterId}/logrequest/{requestId}`

Оба path-параметра обязательны. Ответ `200`: `{ log_request: LogRequest }`.

Полезно также реализовать список:

`GET /management/v1/counter/{counterId}/logrequests`

Ответ: `{ requests: LogRequest[] }` по смыслу официального метода; имя envelope следует подтвердить fixture/live-тестом (см. неопределённости).

`LogRequest`:

- `request_id`, `counter_id`;
- `source`, `date1`, `date2`, `fields`, `attribution`;
- `status`;
- `size` — общий размер в байтах;
- `parts[]`: `{ part_number, size }`.

Статусы: `created`, `canceled`, `processed`, `cleaned_by_user`, `cleaned_automatically_as_too_old`, `processing_failed`, `awaiting_retry`. Скачивание разрешать только при `processed`. `created` и `awaiting_retry` считать незавершёнными; остальные — терминальными.

### 4. Скачать часть

`GET /management/v1/counter/{counterId}/logrequest/{requestId}/part/{partNumber}/download`

Все path-параметры обязательны. Успешный ответ — поток TSV с заголовком полей, не JSON. Клиент не должен читать произвольно большую часть целиком в память: писать в файл/поток, учитывать `parts[].size`, вводить лимит MCP-вывода. В JSON-ответ tool лучше возвращать путь, количество байт и номер части, а не содержимое всей выгрузки.

### 5. Очистить подготовленные данные

`POST /management/v1/counter/{counterId}/logrequest/{requestId}/clean`

Body и query отсутствуют. Ответ `200`: `{ log_request: LogRequest }`, ожидаемый статус `cleaned_by_user`. Это изменяющая состояние операция: отдельный write-feature flag и явное подтверждение на уровне MCP.

Дополнительно API имеет `POST .../cancel` для ещё не обработанного запроса, но он не входит в требуемый минимум.

### Квоты и эксплуатация

- Суммарная квота подготовленных файлов — 10 GB для всех запросов; после скачивания надо вызывать `clean`.
- До создания рекомендуется вызывать `evaluate`.
- Обработка асинхронна и идёт очередью; polling обязан иметь backoff, общий timeout и не трактовать `created` как ошибку.

## Ошибки и защитные решения MCP

- Сохранять HTTP status и безопасно нормализовать официальный error envelope (`errors[]`, `code`, `message`), не включая Authorization.
- Retry только для сетевых ошибок, `429` и временных `5xx`; POST create нельзя слепо повторять без проверки списка запросов, иначе возможен дубль.
- Ограничивать `limit` Reports API ниже серверных 100 000 по умолчанию и возвращать метаданные sampling.
- Валидировать совместимость `ym:s:*`/`ym:pv:*` dimensions и metrics на стороне API; полный каталог полей изменяется и не должен быть жёстко зашит.

## Неопределённости, которые надо закрыть live/fixture-тестом

1. Английская OpenAPI-страница списка log requests в поисковом индексе показывает элементы, но неочевидно называет envelope (`requests` или `log_requests`). HTTP-клиент временно должен принять оба варианта, а контрактный тест — зафиксировать реальный.
2. Документация местами показывает ISO date-time в примере Logs API, русская версия — `YYYY-MM-DD`. Практический формат запроса следует стандартизовать как `YYYY-MM-DD`.
3. Для download официальная reference-страница плохо индексируется: подтвердить фактические `Content-Type`, `Content-Encoding` и наличие/отсутствие gzip на реальной части.
4. Отдельный `GET .../goals` следует подтвердить smoke-тестом; безопасный fallback для read-only списка — `GET .../counter/{counterId}?field=goals`.
5. Значения `null` в метриках и dimensions возможны на реальных данных, хотя краткая OpenAPI-схема показывает `number`; runtime-схемы должны принимать `null` и неизвестные дополнительные поля.

## Официальные источники

- [Авторизация](https://yandex.ru/dev/metrika/en/intro/authorization)
- [Список счётчиков](https://yandex.ru/dev/metrika/en/management/openapi/counter/counters)
- [Информация о счётчике](https://yandex.ru/dev/metrika/en/management/openapi/counter/counter)
- [Reports: table](https://yandex.ru/dev/metrika/en/stat/openapi/data)
- [Reports: by time](https://yandex.ru/dev/metrika/en/stat/openapi/bytime)
- [Logs: quick start](https://yandex.ru/dev/metrika/en/logs/practice/quick-start)
- [Logs: evaluate](https://yandex.ru/dev/metrika/en/logs/openapi/evaluate)
- [Logs: create](https://yandex.ru/dev/metrika/en/logs/openapi/createLogRequest)
- [Logs: status](https://yandex.ru/dev/metrika/en/logs/openapi/getLogRequest)
- [Logs: clean](https://yandex.ru/dev/metrika/en/logs/openapi/clean)
- [Logs: restrictions](https://yandex.ru/dev/metrika/en/logs/index)

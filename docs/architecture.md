# Архітектура і стек

Опис того, з чого система складається і чому саме так. Поведінку описує
`behaviour.md`, експлуатацію — `runbook.md`.

## Потік даних

```
   інвертор Deye
        │  (пристрій сам вивантажує телеметрію, каданс 10–15 хв)
        ▼
   Deye Cloud OpenAPI
        │  station/listWithDevice → device/latest
        ▼
   deye-collector ──── line protocol ────▶ InfluxDB Cloud Serverless
   (Fly, stateless)                        bucket monitoring, retention 30 днів
                                                │
                                                │ Flux через проксі Grafana
                                                ▼
                                          Grafana Cloud (Free)
                                          дашборд + 4 правила алертів
                                                │
                        ┌───────────────────────┴────────────────────┐
                        │ webhook (Bearer)                           │ telegram
                        ▼                                            ▼
                  deye-battery-bot ──▶ підписники              адмін (страхувка)
                  (Fly, SQLite на волюмі)
```

Дві властивості цієї схеми варті того, щоб їх назвати прямо:

**Бот не має креденшелів до InfluxDB.** Він ходить у дані виключно через
проксі Grafana службовим токеном з роллю Viewer. Компрометація бота не дає
запису в базу телеметрії.

**Алерти живуть у Grafana, не в коді.** Пороги, `for`, `noDataState`, тексти —
там. Бот отримує вебхук і вирішує лише одне: кому слати. Змінити поріг можна
без деплою; ціна — правила треба тримати в `grafana-alerting.md`, бо в репозиторії
їх немає.

## Стек

| Шар | Вибір | Чому саме він |
|---|---|---|
| Мова/рантайм | Node 22 (`node:22-slim`), чистий ESM | На alpine `better-sqlite3@12` не збирався взагалі; на glibc беруться prebuilt-бінарники, і збірка не потребує python3/make/g++ |
| Тести | вбудований `node:test` | Нуль тестових залежностей. 221 тест, без моків мережі — модулі розділені на чисту частину й тонкий I/O-шар саме заради цього |
| Залежності бота | `better-sqlite3`, `node-fetch` | І все. Колектор — **нуль** залежностей |
| Стан | SQLite (WAL) на волюмі Fly | Єдиний стан, якого не відновить ніщо: підписки й **рішення про доступ** |
| Часові ряди | InfluxDB Cloud Serverless | Дісталась у спадок; обмеження описані нижче |
| Візуалізація й алерти | Grafana Cloud Free | Рендер зображень (`/render/d-solo`) на Free працює — перевірено |
| Хостинг | Fly.io, регіон `fra`, 2 застосунки × 256 МБ | Регіон поруч із користувачами; 256 МБ — стеля, з якої випливає частина рішень |

### Обмеження, з яких випливає код

- **InfluxDB Serverless: типи колонок незмінні, видалення не підтримується.**
  `POST /api/v2/delete` → 405. Схема `battery` задана раніше й уся `float`:
  `soc=42i` дає 400 `table schema conflict`. Тому валідація діапазонів у
  колекторі обовʼязкова — записане не прибрати до кінця retention.
- **Одна машина, масштабувати не можна.** Два інстанси дадуть `409 Conflict`
  на полінгу Telegram і дві розбіжні БД.
- **256 МБ.** Звідси стеля `scrypt N = 16384` (`128·N·r ≈ 16.8 МБ`, дефолтний
  `maxmem` 32 МБ) і семафор на один одночасний `scrypt`: десять паралельних
  логінів це 168 МБ і OOM-kill.
- **`better-sqlite3` синхронний.** Гонок усередині процесу немає, але кожен
  запит блокує читання Telegram. Червона лінія — жодного full scan усередині
  вебхука; звідси `idx_subs_inverter`.
- **Пласка розкладка файлів обовʼязкова.** `Dockerfile` містить `COPY *.js ./`,
  а глоб не заходить у підкаталоги. Будь-який `web/server.js` працює локально
  й падає на Fly з `ERR_MODULE_NOT_FOUND`. Модулі розділені префіксами в імені
  (`admin-*`, `alerts-*`, `http-*`), а не каталогами.

## Модулі бота

Кожен розпадається на чисту частину й тонкий I/O-шар — інакше тести без моків
неможливі.

| Файл | Відповідальність |
|---|---|
| `index.js` | точка входу: полінг, маршрути, реєстр команд і callback-ів, фонові цикли, коректне завершення |
| `config.js` | env з валідацією на старті; секрети неперелічувані, щоб не витекти в лог |
| `db.js` | `createDb(filename)`, міграції через `PRAGMA user_version`, увесь SQL |
| `commands.js` | `createCommands` / `createCallbacks`, гейт доступу, `parseCommand` |
| `helpers.js` | форматування, `redact`, `escapeHtml`, `batteryState`, `gridPresent` |
| `telegram.js` | виклики Bot API з таймаутами; `sendAlert` розрізняє 429 і 403 |
| `grafana.js` | запит Flux, рендер панелі, посилання на дашборд, ретраї лише на 5xx |
| `discovery.js` | нові інвертори з `schema.tagValues()` раз на 5 хв |
| `health.js` | чистий `healthStatus(lastOk, limit, now)` |
| `http-router.js` | `matchRoute` — чиста функція; 404 проти 405; `.`/`..` відхиляються |
| `http-server.js` | сервер, `readBody` з лімітом, заголовки безпеки |
| `admin-auth.js` | scrypt, підпис сесії, CSRF, тротлінг — усе чисте |
| `admin-views.js` | SSR-HTML: `loginPage`, `usersPage`, `objectsPage` |
| `admin-routes.js` | маршрути адмінки (I/O) |
| `webhook-grafana.js` | `webhookAuthorized`, `parseGrafanaWebhook`, `dedupKey` |
| `alerts-fanout.js` | `selectRecipients`, `formatAlert` — кому слати і який текст |
| `alerts-queue.js` | послідовна відправка, пауза, дедуп, 429/403 |
| `subs-keyboard.js` | клавіатура вибору обʼєктів, розбір `callback_data` |
| `backup.js` | `VACUUM INTO` раз на добу з ротацією на 7 копій; щотижневий дамп у чат адміна за маркером на волюмі; знімок перед зміною версії у `shutdown` |

## Модулі колектора

Окремий застосунок, власні `package.json`, `Dockerfile`, `fly.toml`.

| Файл | Відповідальність |
|---|---|
| `transform.js` | чисте: `toPoint`, `toGridPoint`, `toLineProtocol`, `selectNewPoints` |
| `deye.js` | кеш токена, проактивний і реактивний ре-логін, пагінація, ретраї |
| `influx.js` | запис line protocol; ретраїть 5xx, не ретраїть 4xx |
| `retry.js` | експоненційний backoff із `shouldRetry` |
| `config.js` | env з валідацією |
| `collector.js` | цикл: discovery → latest → валідація → дедуп → запис |
| `index.js` | вхід і health-check, який **не бреше** |

Помилка одного пристрою не валить цикл: `toPoint` кидає, цикл ловить на кожен
пристрій окремо і пише решту.

## Виміри в InfluxDB

Тег `inverter` — серійник. Він тримає на собі discovery, фільтр дашборда й
групування алертів, тож має бути стабільним у часі: людська назва змінилась би
й породила дубль-серію. Читабельні назви живуть у SQLite і підставляються при
відправці.

```
battery,inverter=<SN> soc,voltage,current,power,temperature,state   (усі float)
grid,inverter=<SN>    voltage,frequency,power                        (усі float)
```

`grid` — окремий вимір, а не поля в `battery`: це інша сутність, інакше назва
виміру брехала б. `grid.voltage` — **максимум трьох фаз**: втрата однієї фази
не є блекаутом.

## Схема SQLite (`user_version = 3`)

```
inverters(id PK, name, dashboard_uid, panel_id, discovered_at)
users(chat_id PK, username, first_name, status, requested_at, created_at, decided_at, decided_by)
    status ∈ pending | approved | rejected
subscriptions(chat_id → users, inverter_id → inverters, subscribed_at)  PK (chat_id, inverter_id)
alert_deliveries(dedup_key, chat_id, delivered_at)                      PK (dedup_key, chat_id)
ignored_inverters(id PK, ignored_at)                                    -- надгробки, v2
invited(username PK, note, invited_at)                                  -- запрошення, v3
```

П'ять рішень, які легко зробити інакше й потім довго шукати причину:

- **`idx_subs_inverter`.** PK веде за `chat_id`, тож для `WHERE inverter_id = ?`
  він непридатний — був би full scan усередині вебхука.
- **Час пишеться як `strftime('%Y-%m-%dT%H:%M:%SZ','now')`.** `datetime('now')`
  віддає рядок без `Z`, і `new Date()` парсить його як **локальний** час: в
  адмінці це давало б зсув на години.
- **`ignored_inverters`.** Без надгробків discovery повертав видалений
  інвертор наступним циклом: тег живе в InfluxDB до кінця retention, тож
  адмінське видалення мовчки скасовувалось за пʼять хвилин.
- **`invited.username` у нижньому регістрі.** `TEXT PRIMARY KEY` у SQLite
  порівнюється побайтно, а Telegram віддає нік у тому регістрі, який людина
  набрала в профілі: без `lower()` запрошення для `@Petro` не знайшлося б за
  ніком `petro`. Витрата — `DELETE … RETURNING` одним кроком, щоб дві заявки
  поспіль не з'їли одне запрошення двічі.
- **Кому слати вирішується рівно в одному місці**, і воно одразу з фільтром:
  ```sql
  SELECT s.chat_id FROM subscriptions s
    JOIN users u ON u.chat_id = s.chat_id
   WHERE s.inverter_id = ? AND u.status = 'approved';
  ```
  Підписки несхваленого зберігаються звичайними рядками й відсікаються тут.
  Окрема таблиця чернеток дала б друге місце, де можна забути фільтр.

## HTTP

| Метод | Шлях | Захист |
|---|---|---|
| GET/HEAD | `/` | — health, **поза роутером** |
| GET | `/robots.txt` | — |
| POST | `/hooks/grafana` | `Authorization: Bearer`, тіло ≤ 256 КБ |
| GET | `/admin` | — форма логіну |
| POST | `/admin/login` | тротлінг |
| GET | `/admin/users`, `/admin/objects` | сесійна cookie |
| POST | `/admin/users`, `/admin/inverters`, `/admin/invites`, `/admin/logout` | cookie + CSRF |
| GET | `/admin/export.json` | cookie |
| — | решта | 404; відомий шлях з іншим методом → 405 |

**Health обробляється першим і безумовно, без БД і без auth.** Помилка в
роутингу зробила б `/` не-200, Fly почав би рестартити єдину машину, а рестарт
нічого не лікує.

Автентифікація адміна: `ADMIN_PASSWORD_HASH` формату `scrypt$N$r$p$salt$hash`
(хеш, а не пароль — `console.log(process.env)` під час дебагу інакше пише його
в логи Fly назавжди). Сесія — підписана cookie без серверного стану, ключі
виведені з хеша через `hkdfSync`: після кожного деплою памʼять чиста, а зміна
пароля миттєво розлогінює всі сесії. `SameSite=Lax`, а не `Strict` — свідомо:
`Strict` не шле cookie при переході за посиланням з Telegram.

## Що не так, як зазвичай

- **Автодеплою з GitHub немає.** Кожна зміна — `fly deploy` руками.
- **Секрети не в репозиторії.** Fly secrets і локальний `.env`; реальні
  ідентифікатори інфраструктури — у `.claude/infra.local.md` (у `.gitignore`).
- **Історія рішень — у `.claude/tasks/`.** Там 24 задачі з обґрунтуванням і
  результатами, включно з помилками, які знайшлись лише в проді.

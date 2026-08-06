# 03 — Сервіс збору `collector/`

**Фаза:** 1 — Фундамент даних
**Залежності:** 01 (write-токен), 02 (формат API)
**Блокує:** 04

## Контекст

Це відсутня ланка всієї системи. Дашборд, алерти й бот читають з InfluxDB, куди зараз ніхто нічого не пише.

Колектор — **окремий процес**, не частина бота. Причина: у бота polling-цикл Telegram у тому ж event loop, а колектор має власний ритм, власні креденшели й власний профіль відмов. Падіння одного не має забирати інше.

Живе в цьому ж репо (`collector/`), деплоїться окремим Fly-застосунком у 04.

## Схема запису

Це контракт, від якого залежить решта системи — міняти його потім дорого:

```
measurement: battery
tags:
  inverter=<стабільний id пристрою>
fields:
  soc         (int, %)
  voltage     (float, V)
  current     (float, A, signed)
  power       (float, W, signed)
  temperature (float, °C)
  state       (string)
timestamp: час виміру з Deye API (не час запиту)
```

Тег `inverter` — те, на чому тримається `schema.tagValues()` у discovery (задача 09), фільтр у панелях дашборда (08) і групування алерту (12). Значення має бути стабільним у часі: якщо взяти SN — воно таким і буде; якщо людську назву — вона може змінитись і породити дубль-серію.

## Кроки

1. `collector/index.js` — точка входу, цикл з інтервалом `COLLECT_INTERVAL` (дефолт 60 с; фактична частота оновлення в хмарі ~5 хв, тому частіше сенсу мало — уточнити за результатом 02).
2. `collector/deye.js` — клієнт Deye Cloud: отримання й кешування access token з проактивним refresh до закінчення TTL, список пристроїв, останні дані.
3. `collector/influx.js` — запис у InfluxDB через line protocol (`POST /api/v2/write?org=…&bucket=…&precision=s`), батчем по всіх пристроях за один запит.
4. `collector/config.js` — env-змінні (за зразком кореневого `config.js`).
5. Обов'язково:
   - `AbortController` з таймаутом на кожен fetch
   - ретраї з експоненційним backoff на 5xx і мережеві помилки
   - **timestamp виміру з API**, а не `Date.now()` — інакше при повторі запису з'являться дублікати замість перезапису точки
   - пропуск запису, якщо timestamp не змінився з минулої ітерації (хмара віддає ті самі дані між вивантаженнями логера)
   - логи без секретів: ніколи не логувати `appSecret`, токени й повний URL із токеном у query
   - валідація діапазонів перед записом (SOC 0..100 тощо) — сміття в бакеті потім не витравити

## Env-змінні

```
DEYE_APP_ID
DEYE_APP_SECRET
DEYE_EMAIL / DEYE_PASSWORD   # якщо flow з 02 їх вимагає
INFLUX_URL
INFLUX_ORG
INFLUX_BUCKET                # default: monitoring
INFLUX_TOKEN
COLLECT_INTERVAL             # мс, default 60000
```

## Критерії готовності

- [ ] `node collector/index.js` локально пише реальні дані в бакет
- [ ] Дані видно через Grafana:
  ```flux
  from(bucket: "monitoring") |> range(start: -15m)
    |> filter(fn: (r) => r._measurement == "battery") |> last()
  ```
- [ ] `schema.tagValues(bucket: "monitoring", tag: "inverter")` повертає непорожній список
- [ ] Повторний запуск не плодить дублікатів точок
- [ ] Симуляція недоступності Deye API (неправильний URL) → ретраї з backoff, процес не падає
- [ ] `grep -riE 'appsecret|token' collector/` не показує жодного логування значень

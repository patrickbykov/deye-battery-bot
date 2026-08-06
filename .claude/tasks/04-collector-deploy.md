# 04 — Деплой колектора

**Фаза:** 1 — Фундамент даних
**Залежності:** 03
**Блокує:** 07 (і фактично всю перевірку решти системи)

## Контекст

**Ключова точка всього плану.** Поки дані не течуть, ані `/status`, ані `/graph`, ані алерти, ані discovery неможливо перевірити — вони всі повертатимуть порожнечу, і буде неможливо відрізнити «код зламаний» від «даних немає».

Деплоїмо **окремим Fly-застосунком** `deye-collector`, а не другим процесом у `deye-battery-bot`. Причини: різні профілі відмов, різні креденшели, і бот сидить на волюмі з SQLite (одна машина, `min_machines_running = 1`) — змішувати з ним колектор означає, що рестарт колектора чіпає БД підписок.

Колектору волюм не потрібен — він stateless.

## Кроки

1. `collector/fly.toml` — окремий застосунок `deye-collector`, регіон `fra` (поруч з ботом), без `[mounts]`.
   Колектору не потрібен публічний HTTP — можна лишити без `[http_service]` і покладатись на `auto_stop_machines = 'off'`. Якщо Fly вимагатиме health-check, підняти мінімальний HTTP-сервер за зразком `index.js:51`, але прив'язати 200 до факту успішного циклу збору, а не віддавати безумовно.
2. `Dockerfile` для колектора — `node:22-slim` (див. задачу 06 про причину відмови від `node:18-alpine`).
3. `fly launch --no-deploy` / `fly apps create deye-collector`.
4. Виставити секрети: `DEYE_APP_ID`, `DEYE_APP_SECRET`, `INFLUX_URL`, `INFLUX_ORG`, `INFLUX_BUCKET`, `INFLUX_TOKEN` (+ те, що вимагає auth flow з 02).
5. `fly deploy`.
6. Спостерігати `fly logs -a deye-collector` протягом кількох циклів.

## Критерії готовності

- [ ] Застосунок `deye-collector` задеплоєний, машина в стані running
- [ ] Через 15 хв роботи:
  ```flux
  schema.measurements(bucket: "monitoring")                 // містить "battery"
  schema.tagValues(bucket: "monitoring", tag: "inverter")   // непорожній
  ```
- [ ] Дашборд `<GRAFANA_DASHBOARD_UID>` показує дані замість «No data»
- [ ] Alert rule `<ALERT_RULE_UID>` вийшов зі стану `nodata` (перевірити на сторінці Alerting або через `/api/prometheus/grafana/api/v1/rules`)
- [ ] `fly logs -a deye-collector` не містить секретів
- [ ] Точки надходять безперервно щонайменше годину без ручного втручання

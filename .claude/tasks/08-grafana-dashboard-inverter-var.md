# 08 — Дашборд під кілька інверторів

**Фаза:** 3 — Multi-inverter
**Залежності:** 04 (потрібні реальні значення тега `inverter`), 07
**Блокує:** 10 (`/graph` без цього безглуздий)

## Контекст

Незакомічений `grafana.js` формує render-URL із `&var-inverter=${id}`. **Це не працює:** у дашборді `<GRAFANA_DASHBOARD_UID>` `templating` — порожній масив. Grafana мовчки проігнорує невідомий `var-` параметр, і `/graph` віддасть **однакову картинку для всіх інверторів**. Помилки не буде — просто тихо неправильний результат, найгірший вид поломки.

Гірше: запити панелей взагалі не фільтрують за інвертором. Panel 6:
```flux
from(bucket: "monitoring")
  |> range(start: -7d)
  |> filter(fn: (r) => r._measurement == "battery" and r._field == "soc")
  |> aggregateWindow(every: 15m, fn: mean, createEmpty: false)
```
З двома інверторами це змішає дані обох в одну картинку.

Плюс усі панелі посилаються на `datasource: { type: "influxdb", uid: "influxdb" }`, тоді як реальний uid — `<GRAFANA_DS_UID>`. Зараз резолвиться за іменем (datasource так і називається — `influxdb`), тому працює, але це збіг, а не задум.

Панелей — 11. Panel 6 (`🔋 Battery State of Charge — Historical (7 days)`) — той, що рендерить бот.

## Кроки

1. Додати template-змінну:
   - name: `inverter`, type: Query, datasource: `<GRAFANA_DS_UID>`
   - query:
     ```flux
     import "influxdata/influxdb/schema"
     schema.tagValues(bucket: "monitoring", tag: "inverter")
     ```
   - refresh: On dashboard load
2. У кожну з 11 панелей додати рядок фільтра:
   ```flux
   |> filter(fn: (r) => r.inverter == "${inverter}")
   ```
3. Замінити `uid: "influxdb"` на `uid: "<GRAFANA_DS_UID>"` у всіх панелях.
4. Оновити заголовок дашборда — `Deye SUN-15K Battery Monitor` прив'язаний до однієї моделі; логічніше `Deye Battery Monitor` з назвою інвертора в заголовках панелей через `$inverter`.

Зручно робити через API, а не клікати 11 панелей:
```
GET  /api/dashboards/uid/<GRAFANA_DASHBOARD_UID>
POST /api/dashboards/db     # з модифікованим json + version
```

## Критерії готовності

- [x] У дашборді з'явився селектор `inverter` зі значеннями з InfluxDB
- [x] Перемикання селектора змінює дані на всіх 11 панелях
- [x] Render-URL з явним параметром дає різні картинки для різних інверторів:
  ```
  /render/d-solo/<GRAFANA_DASHBOARD_UID>/?orgId=1&panelId=6&width=800&height=400&from=now-24h&to=now&var-inverter=<id>
  ```
- [x] `grep '"uid": "influxdb"'` у JSON дашборда → порожньо
- [x] Alert rule `<ALERT_RULE_UID>` не зламався (він має власні запити, дашборда не торкається)

## Нотатка

Поки інвертор один, різницю між «фільтр працює» і «фільтр не працює» побачити неможливо. Тому повноцінна перевірка цієї задачі — після появи другого значення тега `inverter` у бакеті. До того — перевіряти хоча б, що з неіснуючим `var-inverter=nonexistent` панель стає порожньою.


## Результат (4 вер 2026)

Через API, не кліками: 12 запитів отримали фільтр `r.inverter == "${inverter}"`,
11 панелей — справжній uid датасорсу замість резолву за іменем, назву змінено
на `Deye Battery Monitor`, додано змінну `inverter` з
`schema.tagValues` і `refresh: on dashboard load`.

Перевірено в браузері: `98%`, `54.7 V`, `26.0 °C`, `-397 W`, `-7.3 A`,
у легендах — одна серія на об'єкт (`soc 2512151417`).

Побічний ефект: фантомна серія `test`, що дублювала кожну панель, зникла сама —
фільтр її відсікає. Раніше вона мала б висіти до 3 жовтня.

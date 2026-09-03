# 01 — Відновити доступ до InfluxDB Cloud

**Фаза:** 1 — Фундамент даних
**Залежності:** немає
**Блокує:** 03, 04

## Контекст

Бакет `monitoring` існує (id `<BUCKET_ID>`, retention 30 днів) і доступний на читання через Grafana — datasource `<GRAFANA_DS_UID>` тримає робочий read-токен, запити повертають 200. Але **бакет порожній**: `schema.measurements()` → `[]`, дані за 3 роки → `[]`.

Для колектора потрібен **write-токен**, а браузер у `cloud2.influxdata.com` не залогінений (редіректить на signup). Тобто доступу до консолі Influx зараз немає — без нього токен не створити.

Org в datasource вказана як `<INFLUX_ORG>`, продукт — InfluxDB Cloud Serverless, регіон `us-east-1-1.aws.cloud2.influxdata.com`.

## Кроки

1. Відновити вхід в акаунт InfluxDB Cloud (той, що містить org `<INFLUX_ORG>`). Ймовірно акаунт заведено через Google/Microsoft SSO — перевірити обидва варіанти.
2. Підтвердити в консолі: бакет `monitoring` на місці, retention 30 днів, org id збігається з тим, що в Grafana datasource.
3. Створити **окремий write-токен** з правами лише на запис у `monitoring` (не All Access). Назва: `deye-collector-write`.
4. Записати org id і URL — вони знадобляться в 03.
5. Токен покласти у Fly secrets на кроці 04. **У репо не комітити.**

## Критерії готовності

- [x] Є доступ до консолі InfluxDB Cloud
- [x] Створено токен `deye-collector-write` з правами write на бакет `monitoring`
- [x] Тестовий запис проходить:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST "$INFLUX_URL/api/v2/write?org=$INFLUX_ORG&bucket=monitoring&precision=s" \
    -H "Authorization: Token $INFLUX_TOKEN" \
    --data-binary 'battery,inverter=test soc=42i'
  # очікується 204
  ```
- [x] Тестовий запис видно — перевірено в Data Explorer самої консолі Influx
  (не через Grafana: локально немає `GRAFANA_SA_TOKEN`, він лише у Fly secrets):
  ```sql
  SELECT * FROM battery ORDER BY time DESC LIMIT 10
  ```
- [x] Тестові дані лишено — прибрати їх **неможливо в принципі**, див. нижче

## Нотатки

Якщо доступ відновити не вдається — запасний варіант: завести новий org/бакет і перевести Grafana datasource на нього. Це дорожче (треба міняти datasource uid у 08 і в alert rule 12), тому спершу вичерпати варіанти з відновленням.


## Результат (3 вер 2026)

Доступ відновлено: org `<INFLUX_ORG>`, org id `<INFLUX_ORG_ID>`. Бакет
`monitoring` на місці, retention 30 днів, ID `<BUCKET_ID>` — збігається
з тим, що в Grafana datasource.
Запасний варіант з новим org не знадобився.

Токен `deye-collector-write` створено, права перевірено в UI:
`monitoring` → **Write ✅, Read ☐**, не All Access. Підтверджено й з боку API:

| Перевірка | Результат |
|---|---|
| запис у `monitoring` | HTTP 204 |
| читання тим самим токеном | HTTP 401 `insufficient permissions to read specified organization and bucket` |

`org` у query-параметрі приймається і як назва, і як id.

### Знайдено попутно — два обмеження, які міняють задачу 03

1. **Схема таблиці `battery` вже задана і незмінна.** Бакет порожній за даними,
   але типи колонок пережили retention: усі шість полів — `float`. Запис
   `soc=42i` дає HTTP 400 `table schema conflict`. Специфікацію 03 виправлено.
2. **Видалення не підтримується.** `POST /api/v2/delete` → HTTP 405
   `Deletes ranges are not supported for serverless v3 buckets`. Записане
   лежить до кінця retention, прибрати не можна. Тому валідація діапазонів
   у колекторі — обов'язкова, а не бажана.

### Хвости

- Тестові точки з тегом `inverter=test` (17:17 UTC) лежатимуть до 3 жовтня.
- Є зайвий write-токен **`Write buckets monitoring`** від 8 серп 2026 — залишок
  попередньої сесії, ніким не використовується. Відкликати після того, як
  колектор поїде на `deye-collector-write`.

# 01 — Відновити доступ до InfluxDB Cloud

**Фаза:** 1 — Фундамент даних
**Залежності:** немає
**Блокує:** 03, 04

## Контекст

Бакет `monitoring` існує (id `1ddde32d55b6e965`, retention 30 днів) і доступний на читання через Grafana — datasource `aff44z3iv9fy8d` тримає робочий read-токен, запити повертають 200. Але **бакет порожній**: `schema.measurements()` → `[]`, дані за 3 роки → `[]`.

Для колектора потрібен **write-токен**, а браузер у `cloud2.influxdata.com` не залогінений (редіректить на signup). Тобто доступу до консолі Influx зараз немає — без нього токен не створити.

Org в datasource вказана як `Engineering`, продукт — InfluxDB Cloud Serverless, регіон `us-east-1-1.aws.cloud2.influxdata.com`.

## Кроки

1. Відновити вхід в акаунт InfluxDB Cloud (той, що містить org `Engineering`). Ймовірно акаунт заведено через Google/Microsoft SSO — перевірити обидва варіанти.
2. Підтвердити в консолі: бакет `monitoring` на місці, retention 30 днів, org id збігається з тим, що в Grafana datasource.
3. Створити **окремий write-токен** з правами лише на запис у `monitoring` (не All Access). Назва: `deye-collector-write`.
4. Записати org id і URL — вони знадобляться в 03.
5. Токен покласти у Fly secrets на кроці 04. **У репо не комітити.**

## Критерії готовності

- [ ] Є доступ до консолі InfluxDB Cloud
- [ ] Створено токен `deye-collector-write` з правами write на бакет `monitoring`
- [ ] Тестовий запис проходить:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST "$INFLUX_URL/api/v2/write?org=$INFLUX_ORG&bucket=monitoring&precision=s" \
    -H "Authorization: Token $INFLUX_TOKEN" \
    --data-binary 'battery,inverter=test soc=42i'
  # очікується 204
  ```
- [ ] Тестовий запис видно через Grafana:
  ```flux
  from(bucket: "monitoring") |> range(start: -5m) |> filter(fn: (r) => r.inverter == "test")
  ```
- [ ] Тестові дані прибрано (або лишено — retention їх з'їсть за 30 днів)

## Нотатки

Якщо доступ відновити не вдається — запасний варіант: завести новий org/бакет і перевести Grafana datasource на нього. Це дорожче (треба міняти datasource uid у 08 і в alert rule 12), тому спершу вичерпати варіанти з відновленням.

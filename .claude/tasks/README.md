# Задачі: доведення проєкту до продакшену

Стан на 2026-08-06. Повний аналіз і обґрунтування рішень — у `docs/plans/`.

## Головне, що з'ясувалося

Бот задеплоєний на Fly.io і формально живий (`https://deye-battery-bot.fly.dev/` → `OK`), але **не працює 5 місяців**: бакет InfluxDB `monitoring` **порожній**, колектора телеметрії не існує в жодному репозиторії. Grafana alert rule у стані `nodata` з 10 лип 2026, Grafana SA `telegram-bot` востаннє використовувався 6 бер 2026.

Крім того гілка `feature/multi-inverter` **не стартує** (ESM SyntaxError), а Fly-волюм `bot_data` з `fly.toml` не створений — наступний `fly deploy` впаде.

## Рішення

| Питання | Рішення |
|---|---|
| Джерело даних | **Deye Cloud OpenAPI** (не локальний Solarman V5) — масштабується на чужі об'єкти без заліза на кожній адресі |
| Алерти SOC < 20% | **Лишаються в Grafana.** `alerts.js` не пишемо, таблицю `alert_state` прибираємо |

## Довідка по сервісах (перевірено в браузері)

| Ресурс | Значення |
|---|---|
| Grafana | `https://kl117s3.grafana.net` (Cloud Free) |
| Дашборд | `0c5a65c2-e842-4802-af8b-4079d2657640`, slug `deye-sun-15k-battery-monitor`, 11 панелей, panel 6 = SOC |
| InfluxDB datasource | uid `aff44z3iv9fy8d`, Flux, org `Engineering`, bucket `monitoring` (retention 30d) |
| Grafana SA | `telegram-bot`, роль Viewer, токен без терміну дії |
| Alert rule | `fff49r52vklc0d`, папка `Deye Alerts` (`eff49ei1sgbuob`) → contact point `Telegram Deye Battery` (`bff49136fkrnke`) |
| Fly app | `deye-battery-bot`, release v5, машина `7843402c04e6d8`, регіон `fra` |
| Fly secrets | 7 шт., `ADMIN_CHAT_ID` **відсутній** |
| Fly volumes | **порожньо** |
| Рендер зображень | ✅ працює на Free-плані (перевірено) |

## Порядок виконання

```
01 ─┐
    ├─→ 03 ─→ 04 ─┐
02 ─┘             │
                  ├─→ 07 ─→ 08 ─→ 09 ─→ 10 ─→ 11 ─→ 12
05 ─→ 06 ─────────┘
                                              13, 14 (паралельно)
```

01/02 і 05/06 незалежні — можна вести паралельно. **04 — ключова точка:** після неї дані течуть і все інше стає перевірюваним.

## Список

### Фаза 1 — Фундамент даних

| # | Задача | Статус |
|---|---|---|
| 01 | [Відновити доступ до InfluxDB Cloud](01-influxdb-access.md) | ☐ |
| 02 | [Розвідка Deye Cloud OpenAPI](02-deye-cloud-recon.md) | ☐ |
| 03 | [Сервіс збору `collector/`](03-collector.md) | ☐ |
| 04 | [Деплой колектора](04-collector-deploy.md) | ☐ |

### Фаза 2 — Повернути бота в робочий стан

| # | Задача | Статус |
|---|---|---|
| 05 | [Полагодити зламану гілку](05-fix-broken-branch.md) | ☐ |
| 06 | [Полагодити збірку й конфіг](06-docker-fly-config.md) | ☐ |
| 07 | [Fly volume + секрети + деплой](07-fly-volume-secrets.md) | ☐ |

### Фаза 3 — Multi-inverter

| # | Задача | Статус |
|---|---|---|
| 08 | [Дашборд під кілька інверторів](08-grafana-dashboard-inverter-var.md) | ☐ |
| 09 | [`discovery.js`](09-discovery.md) | ☐ |
| 10 | [Переписати `commands.js`](10-commands-multi.md) | ☐ |
| 11 | [Переписати `index.js`](11-index-routing.md) | ☐ |
| 12 | [Алерт по кожному інвертору](12-grafana-alert-multi.md) | ☐ |

### Фаза 4 — Продакшн-гігієна

| # | Задача | Статус |
|---|---|---|
| 13 | [Стійкість і безпека](13-hardening.md) | ☐ |
| 14 | [Документація й бекап](14-docs.md) | ☐ |

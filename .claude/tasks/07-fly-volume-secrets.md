# 07 — Fly volume + секрети + деплой

**Фаза:** 2 — Повернути бота в робочий стан
**Залежності:** 04 (дані течуть), 05, 06
**Блокує:** фазу 3

## Контекст

**`fly deploy` зараз впаде.** `fly.toml` містить:
```toml
[mounts]
  source = "bot_data"
  destination = "/app/data"
```
але вкладка Volumes застосунку **порожня** — волюм ніколи не створювався. Fly відмовить з «Process group 'app' needs volumes with name 'bot_data'».

**`ADMIN_CHAT_ID` немає в секретах.** Заведені 7: `GRAFANA_DASHBOARD_UID`, `GRAFANA_DS_UID`, `GRAFANA_SA_TOKEN`, `GRAFANA_URL`, `INFLUXDB_BUCKET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. `config.js:9` читає `ADMIN_CHAT_ID`, але його ніде не виставлено — адмінські команди з фази 3 не працюватимуть.

Поточний реліз — v5 від 6 бер 2026, тобто **до** всіх комітів SQLite. Гілка `feature/multi-inverter` навіть не запушена на GitHub.

## Кроки

1. Створити волюм **до** деплою:
   ```bash
   fly volumes create bot_data --region fra --size 1 -a deye-battery-bot
   ```
   1 GB — мінімум і з великим запасом: у БД лежать лише підписки.
2. Дізнатися свій Telegram chat id і виставити:
   ```bash
   fly secrets set ADMIN_CHAT_ID=<id> -a deye-battery-bot
   ```
3. Запушити гілку на GitHub, змерджити в `main` (або деплоїти з гілки — але тоді `main` лишиться стухлим).
4. `fly deploy -a deye-battery-bot`.
5. Перевірити, що БД реально лягла на волюм, а не в шар образу:
   ```bash
   fly ssh console -a deye-battery-bot -C "ls -la /app/data"
   fly ssh console -a deye-battery-bot -C "df -h /app/data"
   ```

## Критерії готовності

- [ ] Волюм `bot_data` існує в `fra`, приаттачений до машини
- [ ] `ADMIN_CHAT_ID` у списку секретів
- [ ] `fly deploy` проходить, реліз ≥ v6
- [ ] `/app/data/bot.db` існує на волюмі й переживає `fly apps restart`
- [ ] У Telegram `/status` віддає живі цифри з інвертора
- [ ] `/graph` віддає PNG **з даними**, не «No data»
- [ ] `lastUsedAt` токена Grafana SA `telegram-bot` оновився на сьогодні (перевірка, що бот реально ходить у Grafana — до цієї задачі там стояло 6 бер 2026)
- [ ] `https://deye-battery-bot.fly.dev/` віддає `OK`

## Обережно

Один застосунок + SQLite на волюмі = **не масштабувати понад одну машину**. `fly scale count 2` дасть одночасно війну за Telegram polling (`409 Conflict`) і другу розбіжну БД. `min_machines_running = 1` і `auto_stop_machines = 'off'` у `fly.toml` вже виставлені правильно — не чіпати.

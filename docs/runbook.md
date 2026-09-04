# Інструкція експлуатації

Що робити руками. Будову описує `architecture.md`, поведінку — `behaviour.md`.

## Перше, що варто знати

- **Автодеплою немає.** Кожна зміна — `fly deploy` руками.
- **Масштабувати понад одну машину не можна** (звідси `--ha=false` скрізь).
- Два застосунки: `deye-battery-bot` і `deye-collector`.

## Локальний запуск

```bash
npm install
cp .env.example .env                 # заповнити
node --env-file=.env index.js        # Node 20+

cd collector && cp .env.example .env
node --env-file=.env index.js
```

Тести — без залежностей і без мережі:

```bash
npm test        # 221 тест, бот і колектор разом
```

## Деплой

```bash
fly deploy --ha=false                       # бот
fly deploy ./collector --ha=false           # колектор
```

Перевірити після:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://deye-battery-bot.fly.dev/   # 200
fly status -a deye-battery-bot                                              # без failing checks
fly logs -a deye-battery-bot --no-tail | tail -20
```

**503 на `/` — це не завжди аварія.** Health віддає 503, поки не було
успішного полінгу; протягом `grace_period` (60 с) після старту це нормально.
Якщо тримається довше — дивитись логи: найімовірніше `409 Conflict` (десь
живий другий інстанс) або впала стартова ініціалізація.

## Секрети

```bash
fly secrets list -a deye-battery-bot
fly secrets set ІМʼЯ=значення -a deye-battery-bot     # рестартує машину
```

| Секрет | Застосунок | Примітка |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | бот | від @BotFather |
| `ADMIN_CHAT_ID` | бот | отримує заявки й адмінські команди |
| `GRAFANA_URL`, `GRAFANA_SA_TOKEN` | бот | service account, роль **Viewer** |
| `GRAFANA_DS_UID`, `GRAFANA_DASHBOARD_UID` | бот | |
| `INFLUXDB_BUCKET` | бот | токена Influx боту не треба — ходить через проксі Grafana |
| `ADMIN_PASSWORD_HASH` | бот | **хеш**, не пароль |
| `GRAFANA_WEBHOOK_TOKEN` | бот | спільний з contact point у Grafana |
| `DEYE_*` | колектор | `DEYE_PASSWORD` — сирий пароль, хешує код |
| `INFLUX_URL`, `INFLUX_ORG`, `INFLUX_TOKEN` | колектор | токен лише на **запис**, не All Access |

### Пароль до адмінки

Зберігається лише як хеш scrypt. Пароль передається через stdin, а не
аргументом — аргумент осідає в history і видно в `ps`:

```bash
echo -n 'новий-пароль' | node admin-auth.js
# scrypt$16384$8$1$<salt>$<hash>
fly secrets set ADMIN_PASSWORD_HASH='scrypt$…' -a deye-battery-bot
```

Зміна пароля **миттєво розлогінює всі сесії**: ключі підпису cookie виведені з
самого хеша.

`N = 16384` — стеля, піднімати не можна: `128·N·r ≈ 16.8 МБ` проти дефолтного
`maxmem` 32 МБ, а машина має 256 МБ на все.

### Токен вебхука

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Виставити **в обох місцях**: `fly secrets set GRAFANA_WEBHOOK_TOKEN=…` і в
Grafana → contact point типу webhook → `Authorization: Bearer`.

## Щоденні операції

### Схвалити або відхилити користувача

Два шляхи, обидва робочі:

- **Telegram**: заявка приходить адміну кнопками `[✅ Схвалити] [🚫 Відхилити]`.
- **Веб**: `https://deye-battery-bot.fly.dev/admin` → «Користувачі» → галочки →
  «Зберегти».

Веб зручніший, коли заявок кілька. Telegram працює з телефона без пароля.

### Назвати обʼєкт

`/admin` → «Обʼєкти» → поле поруч із серійником. Порожнє поле повертає
серійник. Назва підставляється і в підписки, і **в текст алерту**.
Discovery назву не затирає.

### Додати обʼєкт

Нічого робити не треба: щойно колектор запише точки з новим тегом `inverter`,
discovery підхопить його протягом 5 хв і повідомить адміна. Далі — дати назву.

### Прибрати обʼєкт

```
/remove_inverter <серійник>
```

Створює надгробок у `ignored_inverters`, інакше discovery поверне його за
пʼять хвилин: тег живе в InfluxDB до кінця retention (30 днів).

### Забрати дані про себе

Користувач сам: `/forgetme` і підтвердження кнопкою. Дія незворотна —
відновити підписки може лише експорт.

## Бекап і відновлення

Копії лежать поруч із базою на волюмі, `data/backup-YYYY-MM-DD.db`, робляться
раз на добу через `VACUUM INTO` (узгоджена копія на живій БД), зберігається 7.
Щойно створена копія не видаляється ніколи — ротація рахує решту.

Три способи дістати дані:

```bash
fly ssh sftp get /app/data/backup-2026-09-04.db -a deye-battery-bot   # файл
```
- `/export` у Telegram — дамп файлом у чат адміна;
- `GET /admin/export.json` — те саме з браузера.

### Відновлення

```bash
fly ssh console -a deye-battery-bot
  cd /app/data
  cp bot.db bot.db.broken            # спершу зберегти те, що є
  cp backup-2026-09-04.db bot.db
  rm -f bot.db-wal bot.db-shm        # інакше WAL «доллє» старі сторінки
fly apps restart deye-battery-bot
```

Що **не** треба відновлювати: інвертори перевідкриються discovery з InfluxDB,
метрики лежать там, правила алертів — у Grafana. Незамінні лише підписки й
рішення про доступ.

## Діагностика

```bash
fly logs -a deye-battery-bot --no-tail | tail -40
fly logs -a deye-collector --no-tail | tail -20
fly status -a deye-battery-bot
```

Що шукати в логах бота: `Poll error`, `409`, `Watchdog`, `Вебхук:`,
`Алерт «…» → N адресат(ів)`. У колектора нормальний рядок — `Записано точок: 2`
(battery + grid на кожен пристрій).

Запит до БД на живій машині. **`sqlite3` в образі немає** — він `node:22-slim`,
тож ходимо тим самим `better-sqlite3`, що й бот, і обовʼязково `readonly`:
другий пишучий конект дасть `SQLITE_BUSY` (звідси `busy_timeout = 5000`).

```bash
fly ssh console -a deye-battery-bot -C 'node -e "const D=require(\"better-sqlite3\");
  const d=new D(\"/app/data/bot.db\",{readonly:true});
  console.log(d.prepare(\"select chat_id,status from users\").all())"'
# [ { chat_id: <chat_id>, status: 'approved' } ]
```

| Симптом | Найімовірніша причина |
|---|---|
| Бот мовчить, health 200 | `409 Conflict`: живі два інстанси. `fly scale count 1` |
| Бот мовчить, health 503 | полінг стоїть; вотчдог перезапустить за 10 хв |
| `/status` каже «немає даних» | став колектор. Дивитись `fly logs -a deye-collector` |
| Алерти не доходять | токен вебхука розійшовся між Fly і Grafana → у Grafana буде помилка доставки |
| Алерт дійшов адміну, але не підписникам | у правила немає мітки `inverter` — це задумано для глобального правила застою |
| Повідомлення обірване або не прийшло | `<` чи `>` у тексті алерту ламає розбір HTML у Telegram |
| Адмінка просить логін щоразу | змінився `ADMIN_PASSWORD_HASH` — усі сесії анульовано |

## Планові дрібниці

- **Токен Deye живе ~60 днів**, ендпойнта оновлення немає. Колектор
  перелогінюється сам — проактивно і у відповідь на відмову. Втручання
  потрібне лише якщо змінили пароль акаунта Deye.
- **Retention InfluxDB — 30 днів.** Дані старші зникають; це не помилка.
  Видалити щось раніше строку **неможливо**: `POST /api/v2/delete` віддає 405
  на serverless-бакетах.
- **Grafana Free**: рендер зображень метрований. Ліміт команд на chat_id стоїть
  саме через це.

## Зміна правил алертів

Правила редагуються **в Grafana**, не в коді, і деплой для цього не потрібен.
Після зміни оновити `grafana-alerting.md` — інакше опис розійдеться з
реальністю, а в репозиторії правил немає.

Два запобіжники, куплені болем:

- **Жодних `<` і `>` у тексті алерту.** Contact point шле `parse_mode: HTML`,
  і `<` робить повідомлення невідправним. Правило колись називалось
  «SOC < 20%» і мовчало саме тому.
- **Вікно запиту має бути ширшим за каданс даних.** `-10m` при вивантаженні раз
  на 10–15 хв дає `NoData` і хибну тривогу вночі. Стоїть `-45m`.

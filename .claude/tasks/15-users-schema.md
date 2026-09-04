# 15 — Таблиця `users`, статуси й міграція схеми

**Фаза:** 5 — Користувачі та персональні алерти
**Залежності:** немає
**Блокує:** 17, 18, 20, 23

## Контекст

Модель підписок зараз **безкористувацька**: `subscriptions(chat_id, inverter_id)`
і все. Немає ані таблиці користувачів, ані ніка, ані статусу — адмін бачив би
лише числові `chat_id` і не знав би, хто це.

**Робити до задачі 09.** Прод-файлу `/app/data/bot.db` ще не існує (`db.js`
ніхто не імпортує), тож це закладання схеми, а не міграція даних. Щойно 09
почне писати інвертори, а 10 — підписки, додати `FOREIGN KEY` стане неможливо:
SQLite не вміє `ALTER TABLE ADD CONSTRAINT`, доведеться робити
`CREATE TABLE new … INSERT SELECT … DROP … RENAME`.

Локальна `data/bot.db` містить забуту таблицю `alert_state` (0 рядків) від
видаленого дизайну `alerts.js`. Її треба прибрати, інакше `sqlite_master`
перестає бути джерелом істини про схему.

## Кроки

1. Механізм версій через `PRAGMA user_version` — 10 рядків, знімає питання
   «а що робити наступного разу»:
   ```js
   const SCHEMA_VERSION = 1;
   function migrate(db) {
     const current = db.pragma('user_version', { simple: true });
     if (current === SCHEMA_VERSION) return;
     db.transaction(() => {
       if (current === 0) {
         db.exec('DROP TABLE IF EXISTS alert_state');
         db.exec(SCHEMA_V1);
       }
       db.pragma(`user_version = ${SCHEMA_VERSION}`);
     })();
   }
   ```
2. Схема v1:
   ```sql
   CREATE TABLE users (
     chat_id      INTEGER PRIMARY KEY,
     username     TEXT,          -- без '@'; у Telegram необов'язковий → NULL
     first_name   TEXT,          -- довільний Unicode → екранувати всюди
     status       TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
     requested_at TEXT,
     created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
     decided_at   TEXT,
     decided_by   TEXT           -- 'tg:<admin_chat_id>' | 'web'
   );

   CREATE TABLE subscriptions (
     chat_id       INTEGER NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
     inverter_id   TEXT    NOT NULL REFERENCES inverters(id)  ON DELETE CASCADE,
     subscribed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
     PRIMARY KEY (chat_id, inverter_id)
   );

   CREATE INDEX idx_subs_inverter ON subscriptions(inverter_id);
   CREATE INDEX idx_users_status  ON users(status);

   CREATE TABLE alert_deliveries (
     dedup_key    TEXT    NOT NULL,
     chat_id      INTEGER NOT NULL,
     delivered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
     PRIMARY KEY (dedup_key, chat_id)
   );
   ```
3. `db.pragma('busy_timeout = 5000')` — діагностична команда з задачі 09
   відкриває **другий** конект до файлу; у WAL читач не блокує письменника,
   але письменник ззовні заблокує бота.
4. Функції: `upsertUser`, `getUser`, `setUserStatus`, `deleteUser`,
   `listUsersWithSubscriptions`, `replaceSubscriptions(chatId, ids)` —
   остання **однією транзакцією** разом зі скиданням статусу в `pending`.
5. `getSubscribers(inverterId)` — **єдине** місце, де вирішується «кому слати»,
   і воно одразу з фільтром:
   ```sql
   SELECT s.chat_id FROM subscriptions s
     JOIN users u ON u.chat_id = s.chat_id
    WHERE s.inverter_id = ? AND u.status = 'approved';
   ```

## Три рішення, які варто розуміти

**`strftime('%Y-%m-%dT%H:%M:%SZ','now')`, а не `datetime('now')`.** Це не стиль.
`datetime('now')` дає `'2026-09-03 12:00:00'`, а `new Date()` парсить такий
рядок як **локальний** час — перевірено, зсув 3 години. `formatKyivTime()`
з `helpers.js` показував би в адмінці брехню.

**Окремий `idx_subs_inverter` попри композитний PK.** PK `(chat_id, inverter_id)`
це індекс з ведучою колонкою `chat_id`; запит фан-ауту `WHERE inverter_id = ?`
ним скористатись **не може** і скотиться у full scan — усередині вебхука, який
блокує читання Telegram.

**Підписки несхваленого зберігаються звичайними рядками.** Альтернатива —
окрема таблиця чернеток — дає друге місце, де можна забути фільтр: при першому
ж рефакторингу хтось напише `getSubscribers()` без JOIN, і несхвалені почнуть
отримувати алерти. Тут функція одна, і її поведінку фіксує тест.

## Критерії готовності

- [x] `getSubscribers()` не повертає `pending` і `rejected` — покрито тестом
- [x] FK не дає підписати неіснуючого користувача
- [x] Каскад: видалення користувача прибирає його підписки
- [x] `migrate()` на БД з `alert_state` прибирає її й ставить `user_version = 1`
- [x] Повторний виклик `migrate()` — no-op
- [x] `replaceSubscriptions()` переводить `approved` → `pending` в одній транзакції
- [x] Усі таймстемпи парсяться `new Date()` без зсуву — тест на `Z` у кінці
- [x] Тести на `new Database(':memory:')`, без файлів і моків

## Результат (4 вер 2026)

`db.js` переписаний: `createDb(filename)` замість конекта на рівні модуля —
інакше тести створювали б файл БД при самому лише імпорті. Експортується
`DEFAULT_DB_PATH`, відкриває конект той, хто його закриває.

10 тестів у `db.test.js` на `:memory:`, разом 64 у проєкті.

Локальну `data/bot.db` (з березня, схема з `alert_state`, **нуль рядків у всіх
таблицях**, у git не була) прибрано — створиться заново вже за версією 1.

Не робив: функції над `alert_deliveries`. Таблиця в схемі є, але дедуп —
логіка задачі 20, і писати її наперед означало б писати без тестів на неї.

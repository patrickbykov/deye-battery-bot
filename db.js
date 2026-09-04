import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Шлях, а не готовий конект: конект на рівні модуля створював би файл БД
// під час запуску тестів. Відкриває його той, хто його й закриває.
export const DEFAULT_DB_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'data', 'bot.db'
);

export const SCHEMA_VERSION = 3;

// strftime з явним 'Z', а не datetime('now'). Останній віддає
// '2026-09-03 12:00:00' — без зони й без 'T', і new Date() читає такий рядок
// як ЛОКАЛЬНИЙ час. У адмінці це давало б зсув на кілька годин.
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS inverters (
    id            TEXT PRIMARY KEY,
    name          TEXT,
    dashboard_uid TEXT,
    panel_id      INTEGER DEFAULT 6,
    discovered_at TEXT NOT NULL DEFAULT (${NOW})
  );

  CREATE TABLE IF NOT EXISTS users (
    chat_id      INTEGER PRIMARY KEY,
    username     TEXT,
    first_name   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected')),
    requested_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (${NOW}),
    decided_at   TEXT,
    decided_by   TEXT
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    chat_id       INTEGER NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
    inverter_id   TEXT    NOT NULL REFERENCES inverters(id)  ON DELETE CASCADE,
    subscribed_at TEXT NOT NULL DEFAULT (${NOW}),
    PRIMARY KEY (chat_id, inverter_id)
  );

  CREATE TABLE IF NOT EXISTS alert_deliveries (
    dedup_key    TEXT    NOT NULL,
    chat_id      INTEGER NOT NULL,
    delivered_at TEXT NOT NULL DEFAULT (${NOW}),
    PRIMARY KEY (dedup_key, chat_id)
  );

  -- PK subscriptions веде за chat_id, тож для WHERE inverter_id = ? він
  -- непридатний. А це запит фан-ауту, який виконується всередині вебхука
  -- й блокує читання Telegram — full scan тут неприйнятний.
  CREATE INDEX IF NOT EXISTS idx_subs_inverter ON subscriptions(inverter_id);
  CREATE INDEX IF NOT EXISTS idx_users_status  ON users(status);
`;

// Надгробки. Без них discovery повертає видалений інвертор наступним циклом:
// тег живе в InfluxDB до кінця retention (30 днів), тож адмінське видалення
// мовчки скасовувалось за 5 хвилин.
const SCHEMA_V2 = `
  CREATE TABLE IF NOT EXISTS ignored_inverters (
    id         TEXT PRIMARY KEY,
    ignored_at TEXT NOT NULL DEFAULT (${NOW})
  );
`;

// Запрошення: адмін наперед називає нік, і перша заявка від цієї людини
// схвалюється без його участі. Нік, а не chat_id, бо chat_id за ніком не
// дізнатись — Bot API такого не дає, і бот не може написати першим.
const SCHEMA_V3 = `
  CREATE TABLE IF NOT EXISTS invited (
    username   TEXT PRIMARY KEY,
    note       TEXT,
    invited_at TEXT NOT NULL DEFAULT (${NOW})
  );
`;

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current === SCHEMA_VERSION) return;

  db.transaction(() => {
    if (current === 0) {
      // Таблиця від дизайну alerts.js, від якого відмовились: алертинг
      // лишається в Grafana. Поки вона є, схема виглядає більшою, ніж є.
      db.exec('DROP TABLE IF EXISTS alert_state');
      db.exec(SCHEMA_V1);
    }
    if (current <= 1) db.exec(SCHEMA_V2);
    if (current <= 2) db.exec(SCHEMA_V3);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

export function createDb(filename) {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Діагностичні команди (fly ssh console) відкривають другий конект; у WAL
  // читач не заважає, але письменник ззовні заблокує бота без цього таймаута.
  db.pragma('busy_timeout = 5000');
  migrate(db);

  return {
    raw: db,
    close: () => db.close(),

    // --- Inverters ---
    getAllInverters: () =>
      db.prepare('SELECT rowid, * FROM inverters ORDER BY id').all(),

    getInverter: id =>
      db.prepare('SELECT rowid, * FROM inverters WHERE id = ?').get(id),

    upsertInverter: (id, name = null, dashboardUid = null, panelId = 6) =>
      db.prepare(`
        INSERT INTO inverters (id, name, dashboard_uid, panel_id)
        SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM ignored_inverters WHERE id = ?)
        ON CONFLICT(id) DO NOTHING
      `).run(id, name ?? id, dashboardUid, panelId, id),

    // Назву задає адмін, щоб люди бачили «Клочківська 117», а не серійник.
    // Порожнє значення повертає серійник: обʼєкт без назви гірший за обʼєкт
    // із технічною назвою.
    renameInverter: (id, name) => {
      const clean = String(name ?? '').trim();
      return db.prepare('UPDATE inverters SET name = ? WHERE id = ?')
        .run(clean === '' ? id : clean, id);
    },

    isIgnoredInverter: id =>
      !!db.prepare('SELECT 1 FROM ignored_inverters WHERE id = ?').get(id),

    // Усі, хто підписаний, незалежно від статусу. Свідомо окремо від
    // getSubscribers: той віддає лише схвалених, бо він — єдине місце, де
    // вирішується «кому слати алерт». Видалення ж обʼєкта зачіпає й тих,
    // чия заявка ще на розгляді.
    getSubscriberChatIds: inverterId =>
      db.prepare('SELECT chat_id FROM subscriptions WHERE inverter_id = ? ORDER BY chat_id')
        .all(inverterId).map(r => r.chat_id),

    // Видалення лишає надгробок, інакше discovery поверне об'єкт наступним
    // циклом, поки тег ще живий у InfluxDB.
    //
    // Повертає тих, хто був підписаний: після каскаду їх уже не дізнатись.
    // Збирає їх сама транзакція, щоб порядок не можна було переплутати —
    // якби кожен викликач робив це сам, рано чи пізно хтось зробив би це
    // після DELETE і розсилка мовчки спорожніла б.
    removeInverter: id => db.transaction(() => {
      const affected = db.prepare('SELECT chat_id FROM subscriptions WHERE inverter_id = ?')
        .all(id).map(r => r.chat_id);
      db.prepare('DELETE FROM inverters WHERE id = ?').run(id);
      db.prepare('INSERT OR IGNORE INTO ignored_inverters (id) VALUES (?)').run(id);
      return affected;
    })(),

    // --- Запрошення ---
    // Регістр зводимо тут, а не лише на вході в адмінку: нижній регістр —
    // інваріант самої колонки, бо PRIMARY KEY у SQLite порівнюється побайтно,
    // а Telegram віддає нік у тому регістрі, який людина набрала в профілі.
    listInvited: () =>
      db.prepare('SELECT * FROM invited ORDER BY username').all(),

    addInvited: (username, note = null) =>
      db.prepare(`
        INSERT INTO invited (username, note) VALUES (lower(?), ?)
        ON CONFLICT(username) DO UPDATE SET note = excluded.note
      `).run(String(username ?? ''), note),

    removeInvited: username =>
      db.prepare('DELETE FROM invited WHERE username = lower(?)').run(String(username ?? '')),

    // DELETE ... RETURNING: перевірка й витрата одним кроком. Двома запитами
    // між ними лишалась би мить, у якій дві заявки поспіль з'їли б одне
    // запрошення двічі.
    consumeInvite: username => {
      const clean = String(username ?? '').trim();
      if (clean === '') return undefined;
      return db.prepare('DELETE FROM invited WHERE username = lower(?) RETURNING *').get(clean);
    },

    // --- Доставка алертів ---
    // Вікно, а не вічний ключ: Grafana повторює сповіщення для алерту, що
    // досі горить, кожні repeat_interval (типово 4 год). Вічний дедуп убив би
    // ці нагадування — SOC лежить на 15% третю добу, а повідомлень немає.
    wasDelivered: (dedupKey, chatId, windowMs) => {
      const row = db.prepare(
        'SELECT delivered_at FROM alert_deliveries WHERE dedup_key = ? AND chat_id = ?'
      ).get(dedupKey, chatId);
      if (!row) return false;
      return Date.now() - Date.parse(row.delivered_at) < windowMs;
    },

    markDelivered: (dedupKey, chatId) =>
      db.prepare(
        `INSERT INTO alert_deliveries (dedup_key, chat_id, delivered_at)
         VALUES (?, ?, ${NOW})
         ON CONFLICT(dedup_key, chat_id) DO UPDATE SET delivered_at = ${NOW}`
      ).run(dedupKey, chatId),

    pruneDeliveries: days =>
      db.prepare(
        `DELETE FROM alert_deliveries WHERE delivered_at < datetime('now', ?)`
      ).run(`-${days} days`),

    // --- Users ---
    // Нік оновлюємо при кожному контакті: у Telegram його міняють, і застарілий
    // нік в адмінці робить схвалення вгадуванням. Статус НЕ чіпаємо.
    upsertUser: (chatId, username = null, firstName = null) =>
      db.prepare(`
        INSERT INTO users (chat_id, username, first_name) VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username,
                                           first_name = excluded.first_name
      `).run(chatId, username, firstName),

    // Окремий лічильник, щоб сторінка обʼєктів не вантажила всіх користувачів
    // із їхніми підписками заради одного числа в навігації.
    countPendingUsers: () =>
      db.prepare("SELECT count(*) n FROM users WHERE status = 'pending'").get().n,

    getUser: chatId =>
      db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId),

    setUserStatus: (chatId, status, decidedBy) =>
      db.prepare(
        `UPDATE users SET status = ?, decided_at = ${NOW}, decided_by = ? WHERE chat_id = ?`
      ).run(status, decidedBy, chatId),

    deleteUser: chatId =>
      db.prepare('DELETE FROM users WHERE chat_id = ?').run(chatId),

    // Два запити замість JOIN з групуванням: користувач без підписок має
    // лишатись у списку, інакше адмін не побачить того, хто щойно натиснув
    // /start. Рядків тут десятки — вартість не має значення.
    listUsersWithSubscriptions: () => {
      const byChat = new Map();
      for (const row of db.prepare(`
        SELECT s.chat_id, i.rowid AS rowid, i.id, i.name FROM subscriptions s
          JOIN inverters i ON i.id = s.inverter_id
         ORDER BY i.id
      `).all()) {
        const { chat_id, ...inverter } = row;
        if (!byChat.has(chat_id)) byChat.set(chat_id, []);
        byChat.get(chat_id).push(inverter);
      }
      return db.prepare('SELECT * FROM users ORDER BY chat_id').all()
        .map(user => ({ ...user, inverters: byChat.get(user.chat_id) ?? [] }));
    },

    // Дамп для бекапу: підписки й рішення про доступ не відновить ніщо,
    // якщо втратити волюм.
    exportAll: () => ({
      exportedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      users: db.prepare('SELECT * FROM users ORDER BY chat_id').all(),
      subscriptions: db.prepare('SELECT * FROM subscriptions ORDER BY chat_id, inverter_id').all(),
      inverters: db.prepare('SELECT * FROM inverters ORDER BY id').all(),
      ignoredInverters: db.prepare('SELECT * FROM ignored_inverters ORDER BY id').all(),
      invited: db.prepare('SELECT * FROM invited ORDER BY username').all(),
    }),

    // --- Subscriptions ---
    // Одна транзакція: новий набір і скидання статусу нероздільні. Інакше
    // між двома операціями існує мить, коли користувач уже підписаний на
    // новий об'єкт, але ще вважається схваленим — і отримає по ньому алерт.
    replaceSubscriptions: (chatId, inverterIds) => db.transaction(ids => {
      db.prepare('DELETE FROM subscriptions WHERE chat_id = ?').run(chatId);
      const insert = db.prepare(
        'INSERT INTO subscriptions (chat_id, inverter_id) VALUES (?, ?)'
      );
      for (const id of ids) insert.run(chatId, id);
      db.prepare(`
        UPDATE users SET status = 'pending', requested_at = ${NOW},
                         decided_at = NULL, decided_by = NULL
         WHERE chat_id = ?
      `).run(chatId);
    })(inverterIds),

    getSubscriptions: chatId =>
      db.prepare(`
        SELECT i.rowid, i.* FROM subscriptions s
          JOIN inverters i ON i.id = s.inverter_id
         WHERE s.chat_id = ? ORDER BY i.id
      `).all(chatId),

    // Єдине місце, де вирішується «кому слати». Фільтр за статусом стоїть
    // саме тут і нікуди більше не дублюється — щоб його не можна було
    // забути в іншій гілці коду.
    getSubscribers: inverterId =>
      db.prepare(`
        SELECT s.chat_id FROM subscriptions s
          JOIN users u ON u.chat_id = s.chat_id
         WHERE s.inverter_id = ? AND u.status = 'approved'
         ORDER BY s.chat_id
      `).all(inverterId).map(r => r.chat_id),
  };
}

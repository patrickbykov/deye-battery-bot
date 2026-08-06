import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'bot.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS inverters (
    id TEXT PRIMARY KEY,
    name TEXT,
    dashboard_uid TEXT,
    panel_id INTEGER DEFAULT 6,
    discovered_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    chat_id INTEGER NOT NULL,
    inverter_id TEXT NOT NULL REFERENCES inverters(id) ON DELETE CASCADE,
    subscribed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, inverter_id)
  );

  CREATE TABLE IF NOT EXISTS alert_state (
    inverter_id TEXT NOT NULL REFERENCES inverters(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL,
    active INTEGER DEFAULT 0,
    last_triggered_at TEXT,
    PRIMARY KEY (inverter_id, alert_type)
  );
`);

// --- Inverters ---

export function getAllInverters() {
  return db.prepare('SELECT * FROM inverters ORDER BY id').all();
}

export function getInverter(id) {
  return db.prepare('SELECT * FROM inverters WHERE id = ?').get(id);
}

export function upsertInverter(id, name = null, dashboardUid = null, panelId = 6) {
  return db.prepare(`
    INSERT INTO inverters (id, name, dashboard_uid, panel_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(id, name || id, dashboardUid, panelId);
}

export function removeInverter(id) {
  return db.prepare('DELETE FROM inverters WHERE id = ?').run(id);
}

// --- Subscriptions ---

export function subscribe(chatId, inverterId) {
  return db.prepare(`
    INSERT OR IGNORE INTO subscriptions (chat_id, inverter_id)
    VALUES (?, ?)
  `).run(chatId, inverterId);
}

export function unsubscribe(chatId, inverterId) {
  return db.prepare(
    'DELETE FROM subscriptions WHERE chat_id = ? AND inverter_id = ?'
  ).run(chatId, inverterId);
}

export function getSubscriptions(chatId) {
  return db.prepare(
    'SELECT inverter_id FROM subscriptions WHERE chat_id = ?'
  ).all(chatId).map(r => r.inverter_id);
}

export function getSubscribers(inverterId) {
  return db.prepare(
    'SELECT chat_id FROM subscriptions WHERE inverter_id = ?'
  ).all(inverterId).map(r => r.chat_id);
}

export function getAllSubscriptions() {
  return db.prepare(`
    SELECT s.chat_id, s.inverter_id, i.name
    FROM subscriptions s JOIN inverters i ON s.inverter_id = i.id
    ORDER BY s.chat_id, s.inverter_id
  `).all();
}

// --- Alert State ---

export function getAlertState(inverterId, alertType) {
  return db.prepare(
    'SELECT * FROM alert_state WHERE inverter_id = ? AND alert_type = ?'
  ).get(inverterId, alertType);
}

export function setAlertActive(inverterId, alertType) {
  db.prepare(`
    INSERT INTO alert_state (inverter_id, alert_type, active, last_triggered_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(inverter_id, alert_type)
    DO UPDATE SET active = 1, last_triggered_at = datetime('now')
  `).run(inverterId, alertType);
}

export function clearAlert(inverterId, alertType) {
  db.prepare(`
    UPDATE alert_state SET active = 0 WHERE inverter_id = ? AND alert_type = ?
  `).run(inverterId, alertType);
}

export default db;

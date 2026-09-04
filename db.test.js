import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDb, migrate, SCHEMA_VERSION } from './db.js';

const tables = db => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all().map(r => r.name).sort();

test('створює схему на порожній БД і ставить версію', () => {
  const store = createDb(':memory:');
  assert.deepEqual(tables(store.raw), ['alert_deliveries', 'ignored_inverters', 'inverters', 'subscriptions', 'users']);
  assert.equal(store.raw.pragma('user_version', { simple: true }), SCHEMA_VERSION);
});

test('прибирає успадковану таблицю alert_state', () => {
  // Локальна data/bot.db має її від видаленого дизайну alerts.js: 0 рядків,
  // але поки вона є, sqlite_master не є джерелом істини про схему.
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE inverters (id TEXT PRIMARY KEY);
    CREATE TABLE alert_state (inverter_id TEXT, alert_type TEXT);
  `);
  migrate(raw);
  assert.ok(!tables(raw).includes('alert_state'));
  assert.equal(raw.pragma('user_version', { simple: true }), SCHEMA_VERSION);
});

test('повторна міграція нічого не робить', () => {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший');
  migrate(store.raw);
  assert.equal(store.getAllInverters().length, 1, 'дані пережили повторний виклик');
});

function seeded() {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший');
  store.upsertInverter('INV2', 'Другий');
  return store;
}

test('не дає підписати користувача, якого немає', () => {
  const store = seeded();
  assert.throws(() => store.replaceSubscriptions(999, ['INV1']), /FOREIGN KEY/);
});

test('видалення користувача прибирає його підписки', () => {
  const store = seeded();
  store.upsertUser(1, 'petro', 'Петро');
  store.replaceSubscriptions(1, ['INV1', 'INV2']);
  store.deleteUser(1);
  assert.equal(store.raw.prepare('SELECT count(*) n FROM subscriptions').get().n, 0);
});

test('розсилка йде лише схваленим — не pending і не rejected', () => {
  // Найважливіший тест у файлі: він ловить майбутній рефакторинг, який
  // напише getSubscribers() без JOIN, і несхвалені почнуть отримувати алерти.
  const store = seeded();
  for (const [id, nick, status] of [[1,'a','approved'], [2,'b','pending'], [3,'c','rejected']]) {
    store.upsertUser(id, nick, nick);
    store.replaceSubscriptions(id, ['INV1']);
    store.setUserStatus(id, status, 'web');
  }
  assert.deepEqual(store.getSubscribers('INV1'), [1]);
});

test('підписник іншого інвертора не потрапляє в розсилку', () => {
  const store = seeded();
  store.upsertUser(1, 'a', 'A');
  store.replaceSubscriptions(1, ['INV2']);
  store.setUserStatus(1, 'approved', 'web');
  assert.deepEqual(store.getSubscribers('INV1'), []);
});

test('зміна набору підписок повертає схваленого на розгляд', () => {
  const store = seeded();
  store.upsertUser(1, 'a', 'A');
  store.replaceSubscriptions(1, ['INV1']);
  store.setUserStatus(1, 'approved', 'web');

  store.replaceSubscriptions(1, ['INV1', 'INV2']);

  const user = store.getUser(1);
  assert.equal(user.status, 'pending');
  assert.equal(user.decided_at, null, 'старе рішення скасоване, а не лишилось');
  assert.deepEqual(store.getSubscribers('INV1'), [], 'алерти замовкли й по старому обʼєкту');
});

test('таймстемпи читаються new Date() без зсуву', () => {
  // datetime('now') віддає рядок без 'Z', і new Date() читає його як
  // локальний час — у адмінці це зсув на кілька годин.
  const store = seeded();
  store.upsertUser(1, 'a', 'A');
  const { created_at } = store.getUser(1);

  assert.match(created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Math.abs(Date.now() - new Date(created_at).getTime()) < 5000,
    `розбіжність із поточним часом: ${created_at}`);
});

test('список для адмінки віддає нік і обрані обʼєкти', () => {
  const store = seeded();
  store.upsertUser(1, 'petro', 'Петро');
  store.replaceSubscriptions(1, ['INV2', 'INV1']);
  store.upsertUser(2, null, 'Без ніка');

  const rows = store.listUsersWithSubscriptions();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].username, 'petro');
  assert.deepEqual(rows[0].inverters.map(i => i.id), ['INV1', 'INV2']);
  assert.deepEqual(rows[1].inverters, [], 'користувач без підписок не зникає зі списку');
});

test('видалений інвертор не повертається discovery', () => {
  // Спіймано в проді: /remove_inverter test спрацював, а через 5 хвилин
  // discovery додав його знову — тег ще живий у InfluxDB до кінця retention.
  const store = seeded();
  store.removeInverter('INV1');
  assert.ok(store.isIgnoredInverter('INV1'));
  assert.ok(!store.isIgnoredInverter('INV2'));
});

test('повторне виявлення проігнорованого не створює рядка', () => {
  const store = seeded();
  store.removeInverter('INV1');
  store.upsertInverter('INV1', 'Перший');
  assert.deepEqual(store.getAllInverters().map(i => i.id), ['INV2']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from './db.js';
import { createBackup, createWeeklyExport, BACKUP_PREFIX, EXPORT_MARKER, EXPORT_INTERVAL_MS } from './backup.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deye-backup-'));
}
const backups = dir => fs.readdirSync(dir).filter(f => f.startsWith(BACKUP_PREFIX)).sort();

test('створює копію, яку можна відкрити й прочитати', () => {
  const dir = tmpdir();
  const store = createDb(path.join(dir, 'bot.db'));
  store.upsertInverter('INV1', 'Перший');
  store.upsertUser(1, 'petro', 'Петро');

  createBackup({ store, dir, keep: 7, log: { info() {}, error() {} } }).runOnce();

  const files = backups(dir);
  assert.equal(files.length, 1);

  // Головне не «файл створився», а «з нього можна відновитись».
  const restored = createDb(path.join(dir, files[0]));
  assert.deepEqual(restored.getAllInverters().map(i => i.id), ['INV1']);
  assert.equal(restored.getUser(1).username, 'petro');
  restored.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ротація лишає рівно keep копій, найсвіжіші', () => {
  const dir = tmpdir();
  const store = createDb(path.join(dir, 'bot.db'));
  for (let day = 1; day <= 10; day++) {
    fs.writeFileSync(path.join(dir, `${BACKUP_PREFIX}2026-09-${String(day).padStart(2, '0')}.db`), '');
  }
  createBackup({ store, dir, keep: 3, log: { info() {}, error() {} } }).runOnce();

  const files = backups(dir);
  assert.equal(files.length, 3);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(files.some(f => f.includes(today)),
    `щойно створену копію не можна видаляти ротацією; лишилось: ${files}`);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('збій бекапу не кидає — цикл бота не має падати через нього', () => {
  const store = createDb(':memory:');
  const errors = [];
  const backup = createBackup({ store, dir: '/неіснуючий/шлях', keep: 7,
    log: { info() {}, error: m => errors.push(m) } });
  assert.doesNotThrow(() => backup.runOnce());
  assert.equal(errors.length, 1);
  store.close();
});

// --- Щотижневий експорт у Telegram ---

// Збирає відправлені документи замість справжнього Telegram. Реальний
// sendDocument — мережа й токен; усе, що тут перевіряється, це рішення
// «слати чи ні» та вміст файлу.
function exportHarness({ chatId = 44958130, sendFails = false } = {}) {
  const dir = tmpdir();
  const store = createDb(path.join(dir, 'bot.db'));
  store.upsertInverter('INV1', 'Клочківська 117');
  store.upsertUser(7, 'petro', 'Петро');
  store.setUserStatus(7, 'approved', 'test');

  const docs = [], errors = [];
  const make = now => createWeeklyExport({
    store, dir, chatId,
    sendDocument: async (chat, buffer, filename, caption) => {
      if (sendFails) throw new Error('Telegram: HTTP 502');
      docs.push({ chat, buffer, filename, caption });
    },
    log: { info() {}, error: m => errors.push(m) },
    now: () => now,
  });
  const marker = () => path.join(dir, EXPORT_MARKER);
  const cleanup = () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, docs, errors, make, marker, cleanup };
}

const DAY = 24 * 3600_000;
const T0 = new Date('2026-09-04T10:00:00Z').getTime();

test('перший запуск шле експорт — маркера ще немає', async () => {
  const h = exportHarness();
  await h.make(T0).runIfDue();
  assert.equal(h.docs.length, 1);
  assert.equal(h.docs[0].chat, 44958130);
  assert.match(h.docs[0].filename, /^deye-backup-2026-09-04\.json$/);
  h.cleanup();
});

test('у файл потрапляє те саме, що віддає exportAll', async () => {
  // Інакше «бекап» був би файлом, з якого не відновитись.
  const h = exportHarness();
  await h.make(T0).runIfDue();

  const dump = JSON.parse(h.docs[0].buffer.toString());
  assert.deepEqual(dump.users.map(u => u.username), ['petro']);
  assert.deepEqual(dump.inverters.map(i => i.name), ['Клочківська 117']);
  assert.equal(dump.schemaVersion, h.store.exportAll().schemaVersion);
  h.cleanup();
});

test('свіжий маркер мовчить — щоденний тик не шле щодня', async () => {
  const h = exportHarness();
  await h.make(T0).runIfDue();
  await h.make(T0 + 6 * DAY).runIfDue();
  assert.equal(h.docs.length, 1, 'через 6 днів ще рано');
  h.cleanup();
});

test('через сім днів шле знову', async () => {
  const h = exportHarness();
  await h.make(T0).runIfDue();
  await h.make(T0 + 7 * DAY).runIfDue();
  assert.equal(h.docs.length, 2);
  h.cleanup();
});

test('маркер переживає перезапуск процесу — рестарт не скидає відлік', async () => {
  // Головна причина, чому відлік живе на диску: setInterval у памʼяті
  // обнуляється на кожному деплої, і тижневий експорт не настав би ніколи.
  const h = exportHarness();
  await h.make(T0).runIfDue();
  // Нова фабрика = новий процес; спільна лише тека на волюмі.
  await h.make(T0 + DAY).runIfDue();
  await h.make(T0 + 2 * DAY).runIfDue();
  assert.equal(h.docs.length, 1);
  h.cleanup();
});

test('невдала відправка не пише маркер — наступний тик спробує знову', async () => {
  const h = exportHarness({ sendFails: true });
  await h.make(T0).runIfDue();
  assert.equal(h.docs.length, 0);
  assert.equal(fs.existsSync(h.marker()), false, 'маркер зʼїв би цілий тиждень');
  assert.equal(h.errors.length, 1);
  h.cleanup();
});

test('збій відправки не кидає — цикл бота не має падати через нього', async () => {
  const h = exportHarness({ sendFails: true });
  await assert.doesNotReject(() => h.make(T0).runIfDue());
  h.cleanup();
});

test('без ADMIN_CHAT_ID нічого не шле й не пише маркер', async () => {
  const h = exportHarness({ chatId: null });
  await h.make(T0).runIfDue();
  assert.equal(h.docs.length, 0);
  assert.equal(fs.existsSync(h.marker()), false);
  h.cleanup();
});

test('битий маркер не блокує експорт назавжди', async () => {
  // Обірваний запис чи ручне редагування не мають означати, що бекапів
  // більше не буде ніколи.
  const h = exportHarness();
  fs.writeFileSync(h.marker(), 'не дата');
  await h.make(T0).runIfDue();
  assert.equal(h.docs.length, 1);
  h.cleanup();
});

test('тиждень — це сім днів', () => {
  assert.equal(EXPORT_INTERVAL_MS, 7 * 24 * 3600_000);
});

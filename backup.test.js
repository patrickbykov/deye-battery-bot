import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from './db.js';
import {
  createBackup, createWeeklyExport, createDeploySnapshot,
  BACKUP_PREFIX, EXPORT_MARKER, EXPORT_INTERVAL_MS, PREDEPLOY_PREFIX,
} from './backup.js';

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

// --- Знімок перед деплоєм ---

const snapshots = dir =>
  fs.readdirSync(dir).filter(f => f.startsWith(PREDEPLOY_PREFIX)).sort();

function snapshotHarness({ version = '30', sendFails = false, chatId = 44958130 } = {}) {
  const dir = tmpdir();
  const store = createDb(path.join(dir, 'bot.db'));
  store.upsertInverter('INV1', 'Клочківська 117');
  store.upsertUser(7, 'petro', 'Петро');

  const docs = [], errors = [];
  const make = (v = version) => createDeploySnapshot({
    store, dir, keep: 3, chatId, version: v,
    sendDocument: async (chat, buffer, filename, caption) => {
      if (sendFails) throw new Error('Telegram: HTTP 502');
      docs.push({ chat, buffer, filename, caption });
    },
    log: { info() {}, error: m => errors.push(m) },
    now: () => new Date('2026-09-04T10:15:51Z').getTime(),
  });
  const cleanup = () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, store, docs, errors, make, cleanup };
}

test('кладе знімок під власним префіксом — щоб добовий бекап його не затер', async () => {
  // backup-YYYY-MM-DD.db перезаписується на кожному старті: саме так копія
  // до міграції v3 загинула через три секунди після завантаження.
  const h = snapshotHarness();
  await h.make().runOnce();
  assert.deepEqual(snapshots(h.dir), ['predeploy-30.db']);
  assert.equal(backups(h.dir).length, 0, 'у простір добових бекапів не лізе');
  h.cleanup();
});

test('зі знімка можна відновитись', async () => {
  const h = snapshotHarness();
  await h.make().runOnce();

  const restored = createDb(path.join(h.dir, snapshots(h.dir)[0]));
  assert.equal(restored.getUser(7).username, 'petro');
  assert.deepEqual(restored.getAllInverters().map(i => i.name), ['Клочківська 117']);
  restored.close();
  h.cleanup();
});

test('перший вихід версії шле файл у Telegram', async () => {
  const h = snapshotHarness();
  await h.make().runOnce();
  assert.equal(h.docs.length, 1);
  assert.equal(h.docs[0].chat, 44958130);
  assert.match(h.docs[0].filename, /^deye-predeploy-30\.json$/);
  h.cleanup();
});

test('повторний рестарт тієї самої версії оновлює копію, але не шле вдруге', async () => {
  // Сьогодні машина рестартувала пʼять разів за дві години; без цього
  // в чаті було б пʼять однакових файлів.
  const h = snapshotHarness();
  await h.make().runOnce();
  await h.make().runOnce();
  assert.equal(h.docs.length, 1, 'та сама версія — та сама подія');
  assert.deepEqual(snapshots(h.dir), ['predeploy-30.db']);
  h.cleanup();
});

test('нова версія шле знову', async () => {
  const h = snapshotHarness();
  await h.make('30').runOnce();
  await h.make('31').runOnce();
  assert.equal(h.docs.length, 2);
  assert.deepEqual(snapshots(h.dir), ['predeploy-30.db', 'predeploy-31.db']);
  h.cleanup();
});

test('без версії іменує за часом і шле щоразу', async () => {
  // FLY_MACHINE_VERSION без ssh перевірити не вдалось, тож код не має на неї
  // покладатись: без неї кожен вихід — окрема подія.
  const h = snapshotHarness({ version: null });
  await h.make(null).runOnce();
  assert.deepEqual(snapshots(h.dir), ['predeploy-2026-09-04T10-15-51Z.db']);
  assert.equal(h.docs.length, 1);
  h.cleanup();
});

test('ротація лишає keep версій і не чіпає щойно створену', async () => {
  const h = snapshotHarness();
  for (const v of ['26', '27', '28', '29']) {
    fs.writeFileSync(path.join(h.dir, `${PREDEPLOY_PREFIX}${v}.db`), '');
  }
  await h.make('30').runOnce();

  const files = snapshots(h.dir);
  assert.equal(files.length, 3);
  assert.ok(files.includes('predeploy-30.db'), `щойно створену видаляти не можна: ${files}`);
  h.cleanup();
});

test('у дампі для Telegram те саме, що віддає exportAll', async () => {
  const h = snapshotHarness();
  await h.make().runOnce();
  const dump = JSON.parse(h.docs[0].buffer.toString());
  assert.deepEqual(dump.users.map(u => u.username), ['petro']);
  assert.equal(dump.schemaVersion, h.store.exportAll().schemaVersion);
  h.cleanup();
});

test('невдала відправка лишає знімок на волюмі — головне збережено', async () => {
  const h = snapshotHarness({ sendFails: true });
  await h.make().runOnce();
  assert.deepEqual(snapshots(h.dir), ['predeploy-30.db']);
  assert.equal(h.errors.length, 1);
  h.cleanup();
});

test('збій не кидає — процес мусить вийти чисто попри все', async () => {
  const store = createDb(':memory:');
  const errors = [];
  const snapshot = createDeploySnapshot({
    store, dir: '/неіснуючий/шлях', keep: 3, chatId: null, version: '30',
    sendDocument: async () => {}, log: { info() {}, error: m => errors.push(m) },
  });
  await assert.doesNotReject(() => snapshot.runOnce());
  assert.equal(errors.length, 1);
  store.close();
});

test('без ADMIN_CHAT_ID знімок робиться, але нікуди не летить', async () => {
  const h = snapshotHarness({ chatId: null });
  await h.make().runOnce();
  assert.deepEqual(snapshots(h.dir), ['predeploy-30.db']);
  assert.equal(h.docs.length, 0);
  h.cleanup();
});

test('відправка не чекає довше за бюджет — Fly вбиває через 5 с', async () => {
  // sendDocument у telegram.js має власний таймаут 15 с. У шатдауні це
  // означало б SIGKILL посеред очікування.
  const dir = tmpdir();
  const store = createDb(path.join(dir, 'bot.db'));
  const snapshot = createDeploySnapshot({
    store, dir, keep: 3, chatId: 1, version: '30',
    sendDocument: () => new Promise(() => {}),   // не завершується ніколи
    log: { info() {}, error() {} },
    sendTimeoutMs: 40,
  });

  const started = Date.now();
  await snapshot.runOnce();
  assert.ok(Date.now() - started < 2000, 'вийшли за бюджет — у шатдауні це SIGKILL');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('capture робить локальну роботу без мережі — щоб шатдаун встиг звести WAL', async () => {
  // Порядок у shutdown: знімок → wal_checkpoint → close → лише потім мережа.
  // Інакше чекпойнт чекав би на Telegram до трьох секунд, а він і є те,
  // заради чого обробник сигналу існує.
  const h = snapshotHarness();
  const captured = h.make().capture();

  assert.deepEqual(snapshots(h.dir), ['predeploy-30.db']);
  assert.equal(h.docs.length, 0, 'capture не має торкатись мережі');
  assert.ok(captured.dump.length > 0);
  h.cleanup();
});

test('send надсилає те, що зібрав capture, уже після закриття БД', async () => {
  const h = snapshotHarness();
  const snapshot = h.make();
  const captured = snapshot.capture();

  // Саме так робить shutdown: БД уже закрита, коли починається відправка.
  h.store.raw.pragma('wal_checkpoint(TRUNCATE)');
  h.store.close();

  await snapshot.send(captured);
  assert.equal(h.docs.length, 1);
  assert.deepEqual(JSON.parse(h.docs[0].buffer.toString()).users.map(u => u.username), ['petro']);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

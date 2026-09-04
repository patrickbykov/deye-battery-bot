import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from './db.js';
import { createBackup, BACKUP_PREFIX } from './backup.js';

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

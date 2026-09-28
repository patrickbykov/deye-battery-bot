import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePauseArg, isPauseActive, createPauseControl, pauseMenu } from './pause.js';
import { createDb } from './db.js';

const NOW = Date.parse('2026-09-28T10:00:00Z');

test('parsePauseArg: без аргументу — безстрокова пауза без причини', () => {
  assert.deepEqual(parsePauseArg(undefined, NOW), { until: null, reason: null });
});

test('parsePauseArg: тривалість і причина', () => {
  assert.deepEqual(parsePauseArg('2h планові роботи', NOW),
    { until: '2026-09-28T12:00:00.000Z', reason: 'планові роботи' });
  assert.equal(parsePauseArg('30m', NOW).until, '2026-09-28T10:30:00.000Z');
  assert.equal(parsePauseArg('1d', NOW).until, '2026-09-29T10:00:00.000Z');
});

test('parsePauseArg: текст без тривалості — це причина', () => {
  // «2 години» не мусить мовчки стати двохвилинною паузою.
  assert.deepEqual(parsePauseArg('Grafana недоступна', NOW), { until: null, reason: 'Grafana недоступна' });
  assert.deepEqual(parsePauseArg('2 години', NOW), { until: null, reason: '2 години' });
});

test('parsePauseArg: нульова тривалість — помилка, а не миттєва пауза', () => {
  assert.equal(parsePauseArg('0h', NOW), null);
});

test('isPauseActive: немає рядка / безстрокова / прострочена', () => {
  assert.equal(isPauseActive(undefined, NOW), false);
  assert.equal(isPauseActive({ until: null }, NOW), true);
  assert.equal(isPauseActive({ until: '2026-09-28T11:00:00Z' }, NOW), true);
  assert.equal(isPauseActive({ until: '2026-09-28T09:00:00Z' }, NOW), false);
});

function harness() {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший');
  for (const [id, status] of [[1, 'approved'], [2, 'approved'], [3, 'pending']]) {
    store.upsertUser(id, `u${id}`, `U${id}`);
    store.replaceSubscriptions(id, ['INV1']);
    store.setUserStatus(id, status, 'test');
  }
  const sent = [];
  let now = NOW;
  const control = createPauseControl({
    store,
    send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; },
    sleep: async () => {},
    log: { info() {}, warn() {}, error() {} },
    now: () => now,
  });
  return { store, control, sent, setNow: t => { now = t; } };
}

test('pause повідомляє лише схвалених і вмикає паузу', async () => {
  const { control, sent } = harness();
  const result = await control.pause({ reason: 'планові роботи', until: null, by: 'admin' });
  assert.equal(result.announced, 2);
  assert.deepEqual(sent.map(s => s.chatId).sort(), [1, 2]);
  assert.match(sent[0].text, /планові роботи/);
  assert.equal(control.isActive(), true);
});

test('повторна pause оновлює причину, але не розсилає вдруге', async () => {
  const { control, sent, store } = harness();
  await control.pause({ reason: 'a', until: null, by: 'admin' });
  const again = await control.pause({ reason: 'b', until: null, by: 'admin' });
  assert.equal(again.announced, 0);
  assert.equal(sent.length, 2);
  assert.equal(store.getPause().reason, 'b');
});

test('resume знімає паузу й повідомляє схвалених', async () => {
  const { control, sent } = harness();
  await control.pause({ reason: null, until: null, by: 'admin' });
  sent.length = 0;
  const result = await control.resume();
  assert.equal(result.wasPaused, true);
  assert.equal(control.isActive(), false);
  assert.deepEqual(sent.map(s => s.chatId).sort(), [1, 2]);
});

test('resume без паузи нікого не турбує', async () => {
  const { control, sent } = harness();
  const result = await control.resume();
  assert.equal(result.wasPaused, false);
  assert.equal(sent.length, 0);
});

test('tick після закінчення строку відновлює сам', async () => {
  const { control, sent, setNow } = harness();
  await control.pause({ reason: null, until: '2026-09-28T11:00:00.000Z', by: 'admin' });
  sent.length = 0;

  assert.equal((await control.tick()).resumed, false, 'строк ще не вийшов');
  assert.equal(sent.length, 0);

  setNow(Date.parse('2026-09-28T11:00:01Z'));
  assert.equal((await control.tick()).resumed, true);
  assert.equal(sent.length, 2);
  assert.equal(control.isActive(), false);
});

test('пауза переживає перевідкриття сховища', () => {
  const store = createDb(':memory:');
  store.setPause({ reason: 'x', until: null, by: 'admin' });
  assert.equal(store.getPause().reason, 'x');
  assert.equal(store.clearPause().reason, 'x');
  assert.equal(store.getPause(), undefined);
});

const callbacks = markup => markup.inline_keyboard.flat().map(b => b.callback_data);

test('pauseMenu без паузи пропонує строки й скасування', () => {
  const { text, reply_markup } = pauseMenu(undefined, NOW);
  assert.match(text, /не на паузі/);
  const data = callbacks(reply_markup);
  assert.ok(data.includes('p:2h'));
  assert.ok(data.includes('p:inf'));
  assert.ok(data.includes('p:cancel'));
  assert.ok(!data.includes('p:resume'));
  // Ліміт Telegram — 64 байти на callback_data.
  for (const d of data) assert.ok(Buffer.byteLength(d) <= 64);
});

test('pauseMenu на паузі показує стан і кнопку відновлення', () => {
  const { text, reply_markup } = pauseMenu({ reason: 'роботи', until: null }, NOW);
  assert.match(text, /роботи/);
  assert.ok(callbacks(reply_markup).includes('p:resume'));
});

test('pauseMenu: прострочена пауза — як без паузи', () => {
  const { reply_markup } = pauseMenu({ reason: 'x', until: '2026-09-28T09:00:00Z' }, NOW);
  assert.ok(!callbacks(reply_markup).includes('p:resume'));
});

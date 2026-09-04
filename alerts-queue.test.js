import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertQueue } from './alerts-queue.js';
import { createDb } from './db.js';

function harness(sendImpl) {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший', 'DASH');
  for (const id of [1, 2]) {
    store.upsertUser(id, `u${id}`, `U${id}`);
    store.replaceSubscriptions(id, ['INV1']);
    store.setUserStatus(id, 'approved', 'test');
  }
  const sent = [], slept = [];
  const queue = createAlertQueue({
    store,
    send: sendImpl ?? (async (chatId, text) => { sent.push({ chatId, text }); return { ok: true }; }),
    log: { info() {}, warn() {}, error() {} },
    sleep: async ms => slept.push(ms),
    adminChatId: null,
  });
  return { store, queue, sent, slept };
}

const alert = (over = {}) => ({
  status: 'firing', inverterId: 'INV1', alertname: 'A',
  summary: 'Заряд нижче 20%', description: 'опис', resolved: '',
  stateReason: '', startsAt: '2026-09-04T06:00:00Z', fingerprint: 'f1', ...over,
});

test('шле кожному схваленому підписнику', async () => {
  const { queue, sent } = harness();
  await queue.deliver([alert()]);
  assert.deepEqual(sent.map(s => s.chatId).sort(), [1, 2]);
});

test('витримує паузу між повідомленнями', async () => {
  const { queue, slept } = harness();
  await queue.deliver([alert()]);
  assert.ok(slept.length >= 1, 'між адресатами має бути пауза');
});

test('повторна доставка того самого алерту не дублює', async () => {
  const { queue, sent } = harness();
  await queue.deliver([alert()]);
  await queue.deliver([alert()]);
  assert.equal(sent.length, 2, 'другий прохід не мав нічого слати');
});

test('429 — дочекатись retry_after і повторити, а не загубити', async () => {
  let attempts = 0;
  const { queue, sent, slept } = harness(async (chatId, text) => {
    attempts++;
    if (attempts === 1) return { ok: false, retryAfter: 3 };
    sent.push({ chatId, text });
    return { ok: true };
  });
  await queue.deliver([alert({ inverterId: 'INV1' })]);
  assert.ok(slept.includes(3000), `мала бути пауза 3000 мс, було: ${slept}`);
  assert.ok(sent.length >= 1, 'повідомлення врешті доставлено');
});

test('403 — користувач заблокував бота: не ретраїмо й позначаємо', async () => {
  const { store, queue } = harness(async () => ({ ok: false, blocked: true }));
  await queue.deliver([alert()]);
  assert.equal(store.getUser(1).status, 'rejected');
});

test('невідомий інвертор без адміна нікому не шле', async () => {
  const { queue, sent } = harness();
  await queue.deliver([alert({ inverterId: null })]);
  assert.equal(sent.length, 0);
});

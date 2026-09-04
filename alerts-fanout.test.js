import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRecipients, formatAlert } from './alerts-fanout.js';
import { createDb } from './db.js';

test('адресує схваленим підписникам і адміну без дубля', () => {
  const r = selectRecipients({ inverterId: 'INV1', inverterKnown: true, subscribers: [1, 2, 99], adminChatId: 99 });
  assert.deepEqual(r.chatIds.sort((a, b) => a - b), [1, 2, 99]);
});

test('алерт без мітки інвертора йде лише адміну', () => {
  // Правило застою рахує точки по всьому бакету — мітки не має. Полагодити
  // може тільки адмін, решті це шум.
  const r = selectRecipients({ inverterId: null, inverterKnown: false, subscribers: [1, 2], adminChatId: 99 });
  assert.deepEqual(r.chatIds, [99]);
  assert.equal(r.reason, 'no-label');
});

test('невідомий інвертор не губиться мовчки — йде адміну', () => {
  const r = selectRecipients({ inverterId: 'ХТОЗНА', inverterKnown: false, subscribers: [], adminChatId: 99 });
  assert.deepEqual(r.chatIds, [99]);
  assert.equal(r.reason, 'unknown-inverter');
});

test('відсутній адмін не породжує адресата null', () => {
  const r = selectRecipients({ inverterId: null, inverterKnown: false, subscribers: [1], adminChatId: null });
  assert.deepEqual(r.chatIds, []);
});

test('текст firing будується з summary й description', () => {
  const text = formatAlert({ status: 'firing', summary: '🔋 Заряд нижче 20%', description: 'Батарея майже розряджена.' });
  assert.match(text, /Заряд нижче 20%/);
  assert.match(text, /майже розряджена/);
});

test('текст resolved — один рядок', () => {
  const text = formatAlert({ status: 'resolved', resolved: 'заряд відновився' });
  assert.match(text, /✅/);
  assert.match(text, /заряд відновився/);
});

test('NoData не видається за спрацювання правила', () => {
  // Інакше людина читає «батарея майже розряджена», коли насправді бракує
  // даних — рівно та хибна тривога, що була в проді 4 вер.
  const text = formatAlert({ status: 'firing', stateReason: 'NoData', alertname: 'Заряд нижче 20%',
    summary: '🔋 Заряд нижче 20%', description: 'Батарея майже розряджена.' });
  assert.doesNotMatch(text, /майже розряджена/);
  assert.match(text, /даних/i);
});

test('текст з кутовими дужками екранується', () => {
  const text = formatAlert({ status: 'firing', summary: 'SOC < 20%', description: 'a & b' });
  assert.doesNotMatch(text, /SOC < 20/);
  assert.match(text, /&lt;/);
});

test('дедуп не пускає повтор у вікні й пускає після нього', () => {
  const store = createDb(':memory:');
  assert.equal(store.wasDelivered('k1', 5, 900_000), false);
  store.markDelivered('k1', 5);
  assert.equal(store.wasDelivered('k1', 5, 900_000), true);
  assert.equal(store.wasDelivered('k1', 6, 900_000), false, 'інший адресат — окремо');
  assert.equal(store.wasDelivered('k1', 5, 0), false, 'вікно вичерпалось — пускаємо');
});

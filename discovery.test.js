import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTagValues, createDiscovery } from './discovery.js';
import { createDb } from './db.js';

// Форма відповіді Grafana на Flux-запит schema.tagValues
const frames = values => ({
  results: { A: { frames: [{ schema: { fields: [{ name: '_value' }] }, data: { values: [values] } }] } },
});

test('дістає значення тега з відповіді Grafana', () => {
  assert.deepEqual(parseTagValues(frames(['INV1', 'INV2'])), ['INV1', 'INV2']);
});

test('порожня відповідь не ламає розбір', () => {
  assert.deepEqual(parseTagValues({ results: { A: { frames: [] } } }), []);
  assert.deepEqual(parseTagValues({}), []);
});

function harness(responses) {
  const store = createDb(':memory:');
  const notified = [];
  const discovery = createDiscovery({
    store,
    queryGrafana: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    notifyAdmin: async msg => notified.push(msg),
    log: { info() {}, warn() {}, error() {} },
    bucket: 'monitoring',
    dashboardUid: 'DASH',
  });
  return { store, discovery, notified };
}

test('записує знайдені інвертори в БД', async () => {
  const { store, discovery } = harness([frames(['INV1', 'INV2'])]);
  await discovery.runOnce();
  assert.deepEqual(store.getAllInverters().map(i => i.id), ['INV1', 'INV2']);
  assert.equal(store.getInverter('INV1').dashboard_uid, 'DASH');
});

test('повідомляє адміна лише про нові інвертори', async () => {
  const { discovery, notified } = harness([frames(['INV1']), frames(['INV1', 'INV2'])]);
  await discovery.runOnce();
  await discovery.runOnce();

  assert.equal(notified.length, 2);
  assert.match(notified[0], /INV1/);
  assert.match(notified[1], /INV2/);
  assert.doesNotMatch(notified[1], /INV1/, 'про вже відомий не повторюємо');
});

test('зникнення тега не видаляє інвертор', async () => {
  // Retention бакета 30 днів; мовчазне видалення знесло б підписки каскадом.
  const { store, discovery } = harness([frames(['INV1']), frames([])]);
  await discovery.runOnce();
  await discovery.runOnce();
  assert.deepEqual(store.getAllInverters().map(i => i.id), ['INV1']);
});

test('помилка запиту не вилітає з циклу', async () => {
  const { store, discovery } = harness([new Error('Grafana 500'), frames(['INV1'])]);
  await discovery.runOnce();                       // не має кинути
  await discovery.runOnce();
  assert.deepEqual(store.getAllInverters().map(i => i.id), ['INV1'], 'наступна ітерація працює');
});

test('не повертає інвертор, який адмін видалив', async () => {
  const { store, discovery, notified } = harness([frames(['INV1']), frames(['INV1'])]);
  await discovery.runOnce();
  store.removeInverter('INV1');
  await discovery.runOnce();

  assert.deepEqual(store.getAllInverters(), []);
  assert.equal(notified.length, 1, 'і не повідомляє про нього повторно');
});

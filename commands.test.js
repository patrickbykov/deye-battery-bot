import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, createCommands } from './commands.js';
import { createDb } from './db.js';

test('лоуеркейсить команду, але не аргумент', () => {
  // Головний баг вихідного плану: parseCommand(text.toLowerCase()) робив
  // getInverter('deye-sun-15k') проти "Deye-SUN-15K" у BINARY-колації, і
  // кожен /subscribe відповідав «інвертор не знайдено».
  assert.deepEqual(parseCommand('/SUBSCRIBE Deye-SUN-15K'),
    { cmd: '/subscribe', arg: 'Deye-SUN-15K' });
});

test('команда без аргументу', () => {
  assert.deepEqual(parseCommand('/status'), { cmd: '/status', arg: undefined });
});

test('зайві пробіли не ламають розбір', () => {
  assert.deepEqual(parseCommand('  /subscribe   INV1  '), { cmd: '/subscribe', arg: 'INV1' });
});

test('звичайний текст не є командою', () => {
  assert.equal(parseCommand('привіт'), null);
  assert.equal(parseCommand(''), null);
});

function harness() {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший', 'DASH');
  store.upsertInverter('INV2', 'Другий', 'DASH');
  store.upsertUser(7, 'petro', 'Петро');

  const sent = [];
  const photos = [];
  const commands = createCommands({
    store,
    telegram: {
      sendMessage: async (chatId, text) => sent.push({ chatId, text }),
      sendPhoto: async (chatId, buf, caption) => photos.push({ chatId, caption }),
    },
    grafana: {
      queryGrafana: async () => ({ results: { A: { frames: [{
        schema: { fields: [{ name: '_time' }, { name: 'soc' }, { name: 'voltage' }] },
        data: { values: [[1788455061000], [98], [53.9]] },
      }] } } }),
      renderGrafanaPanel: async () => Buffer.from('png'),
      getDashboardLink: inv => `https://g/d/${inv.dashboard_uid}`,
    },
    log: { info() {}, warn() {}, error() {} },
    sleep: () => Promise.resolve(),
  });
  return { store, commands, sent, photos, ctx: { chatId: 7 } };
}

test('/list показує всі інвертори з БД', async () => {
  const { commands, sent, ctx } = harness();
  await commands.get('/list')(ctx);
  assert.match(sent[0].text, /INV1/);
  assert.match(sent[0].text, /INV2/);
});

test('/subscribe зберігає регістр аргументу', async () => {
  const { commands, store, ctx } = harness();
  await commands.get('/subscribe')({ ...ctx, arg: 'INV1' });
  assert.deepEqual(store.getSubscriptions(7).map(i => i.id), ['INV1']);
});

test('/subscribe на неіснуючий інвертор → зрозуміла відмова, не мовчанка', async () => {
  const { commands, sent, ctx } = harness();
  await commands.get('/subscribe')({ ...ctx, arg: 'НЕМАЄ' });
  assert.match(sent[0].text, /не знайдено|немає/i);
});

test('/status без підписок → підказка, а не порожнеча', async () => {
  const { commands, sent, ctx } = harness();
  await commands.get('/status')(ctx);
  assert.match(sent[0].text, /\/subscribe|\/list/);
});

test('/status з двома підписками → два окремі повідомлення', async () => {
  const { commands, store, sent, ctx } = harness();
  store.replaceSubscriptions(7, ['INV1', 'INV2']);
  await commands.get('/status')(ctx);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Перший/);
  assert.match(sent[1].text, /Другий/);
});

test('/graph з двома підписками → два різні графіки', async () => {
  const { commands, store, photos, ctx } = harness();
  store.replaceSubscriptions(7, ['INV1', 'INV2']);
  await commands.get('/graph')(ctx);
  assert.equal(photos.length, 2);
  assert.notEqual(photos[0].caption, photos[1].caption);
});

test('/mysubs і /unsubscribe', async () => {
  const { commands, store, sent, ctx } = harness();
  store.replaceSubscriptions(7, ['INV1']);
  await commands.get('/mysubs')(ctx);
  assert.match(sent[0].text, /INV1|Перший/);

  await commands.get('/unsubscribe')({ ...ctx, arg: 'INV1' });
  assert.deepEqual(store.getSubscriptions(7), []);
});

test('помилка Grafana не показує користувачу внутрішніх деталей', async () => {
  const { store, ctx } = harness();
  const sent = [];
  const commands = createCommands({
    store,
    telegram: { sendMessage: async (c, t) => sent.push(t), sendPhoto: async () => {} },
    grafana: {
      queryGrafana: async () => { throw new Error('uid датасорсу aff44z3iv9fy8d'); },
      renderGrafanaPanel: async () => Buffer.from(''),
      getDashboardLink: () => 'https://g',
    },
    log: { info() {}, warn() {}, error() {} },
    sleep: () => Promise.resolve(),
  });
  store.replaceSubscriptions(7, ['INV1']);
  await commands.get('/status')(ctx);
  assert.doesNotMatch(sent.join(' '), /aff44z3iv9fy8d/);
});

test('/help не містить хардкоду моделі й порогу', async () => {
  const { commands, sent, ctx } = harness();
  await commands.get('/help')(ctx);
  assert.doesNotMatch(sent[0].text, /SUN-15K-SG05LP3|20%/);
});

test('лукап команд не піддається __proto__', async () => {
  const { commands } = harness();
  assert.equal(commands.get('__proto__'), undefined);
  assert.equal(commands.get('constructor'), undefined);
});

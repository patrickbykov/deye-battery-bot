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
  // Гейт задачі 18: /status і /graph доступні лише схваленим. Ці тести
  // перевіряють механіку команд, а не гейт — він має власні тести.
  store.setUserStatus(7, 'approved', 'test');

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
  store.setUserStatus(7, 'approved', 'test');   // зміна набору повернула в pending
  await commands.get('/status')(ctx);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Перший/);
  assert.match(sent[1].text, /Другий/);
});

test('/graph з двома підписками → два різні графіки', async () => {
  const { commands, store, photos, ctx } = harness();
  store.replaceSubscriptions(7, ['INV1', 'INV2']);
  store.setUserStatus(7, 'approved', 'test');
  await commands.get('/graph')(ctx);
  assert.equal(photos.length, 2);
  assert.notEqual(photos[0].caption, photos[1].caption);
});

test('/mysubs і /unsubscribe', async () => {
  const { commands, store, sent, ctx } = harness();
  store.replaceSubscriptions(7, ['INV1']);
  store.setUserStatus(7, 'approved', 'test');
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
  store.setUserStatus(7, 'approved', 'test');
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

test('/subscribe від невідомого боту користувача створює його, а не падає', async () => {
  // Спіймано в проді: FOREIGN KEY constraint failed. Підписка посилається на
  // users(chat_id), а рядка користувача не існувало — його ніхто не створював.
  const { commands, store } = harness();
  const ctx = { chatId: 999, from: { username: 'nova', first_name: 'Нова' }, arg: 'INV1' };

  await commands.get('/subscribe')(ctx);

  assert.deepEqual(store.getSubscriptions(999).map(i => i.id), ['INV1']);
  assert.equal(store.getUser(999).username, 'nova');
});

test('нік оновлюється при кожному зверненні', async () => {
  const { commands, store } = harness();
  await commands.get('/subscribe')({ chatId: 999, from: { username: 'old' }, arg: 'INV1' });
  await commands.get('/subscribe')({ chatId: 999, from: { username: 'new' }, arg: 'INV2' });
  assert.equal(store.getUser(999).username, 'new');
});

// --- Callback-и клавіатури підписок ---
import { createCallbacks } from './commands.js';
import { buildKeyboard, CHECK, UNCHECK } from './subs-keyboard.js';

function cbHarness() {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший', 'DASH');
  store.upsertInverter('INV2', 'Другий', 'DASH');
  const edits = [], toasts = [], adminMsgs = [], texts = [];
  const callbacks = createCallbacks({
    store,
    telegram: {
      editMessageReplyMarkup: async (c, m, markup) => edits.push(markup),
      editMessageText: async (c, m, text) => texts.push(text),
      answerCallbackQuery: async (id, text) => toasts.push(text),
      sendMessage: async () => {},
    },
    notifyAdmin: async msg => adminMsgs.push(msg),
    log: { info() {}, warn() {}, error() {} },
  });
  const inverters = store.getAllInverters();
  return { store, callbacks, edits, toasts, adminMsgs, texts, inverters };
}

const ctx = (markup, from = { id: 5, username: 'petro', first_name: 'Петро' }) => ({
  chatId: 5, messageId: 1, callbackId: 'cb1', from, replyMarkup: markup,
});

test('тик по інвертору перемикає галочку в клавіатурі', async () => {
  const { callbacks, edits, inverters } = cbHarness();
  const markup = buildKeyboard(inverters, []);
  await callbacks.get('t')({ ...ctx(markup), value: String(inverters[0].rowid) });

  assert.ok(edits[0].inline_keyboard[0][0].text.startsWith(CHECK));
  assert.ok(edits[0].inline_keyboard[1][0].text.startsWith(UNCHECK));
});

test('повторний тик знімає галочку', async () => {
  const { callbacks, edits, inverters } = cbHarness();
  const markup = buildKeyboard(inverters, ['INV1']);
  await callbacks.get('t')({ ...ctx(markup), value: String(inverters[0].rowid) });
  assert.ok(edits[0].inline_keyboard[0][0].text.startsWith(UNCHECK));
});

test('заявка без жодного обраного не пише в БД', async () => {
  const { callbacks, store, toasts, inverters } = cbHarness();
  await callbacks.get('req')(ctx(buildKeyboard(inverters, [])));
  assert.equal(store.getUser(5), undefined);
  assert.match(toasts.join(' '), /хоча б один/i);
});

test('заявка записує підписки, ставить pending і повідомляє адміна', async () => {
  const { callbacks, store, adminMsgs, inverters } = cbHarness();
  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1', 'INV2'])));

  assert.deepEqual(store.getSubscriptions(5).map(i => i.id), ['INV1', 'INV2']);
  assert.equal(store.getUser(5).status, 'pending');
  assert.ok(store.getUser(5).requested_at);
  assert.match(adminMsgs[0], /petro/);
  assert.match(adminMsgs[0], /Перший/);
});

test('зміна набору схваленим повертає його на розгляд', async () => {
  const { callbacks, store, inverters } = cbHarness();
  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1'])));
  store.setUserStatus(5, 'approved', 'web');

  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1', 'INV2'])));
  assert.equal(store.getUser(5).status, 'pending');
});

test('нік із кутовою дужкою не ламає повідомлення адміну', async () => {
  const { callbacks, adminMsgs, inverters } = cbHarness();
  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1']),
    { id: 5, username: '<script>', first_name: 'A & B' }));
  assert.doesNotMatch(adminMsgs[0], /<script>/);
  assert.match(adminMsgs[0], /&lt;script&gt;/);
});

test('/subscribe без аргументу показує клавіатуру з поточним вибором', async () => {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший', 'DASH');
  store.upsertUser(7, 'petro', 'Петро');
  store.replaceSubscriptions(7, ['INV1']);

  const sent = [];
  const commands = createCommands({
    store,
    telegram: { sendMessage: async (c, t, o) => sent.push({ t, o }), sendPhoto: async () => {} },
    grafana: { queryGrafana: async () => ({}), renderGrafanaPanel: async () => Buffer.from(''), getDashboardLink: () => '' },
    log: { info() {}, warn() {}, error() {} },
    sleep: () => Promise.resolve(),
  });

  await commands.get('/subscribe')({ chatId: 7, from: { id: 7 } });
  assert.ok(sent[0].o?.reply_markup, 'має бути inline-клавіатура');
  assert.ok(sent[0].o.reply_markup.inline_keyboard[0][0].text.startsWith(CHECK));
});

// --- Гейт доступу і схвалення (задача 18) ---

function gateHarness(status) {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший', 'DASH');
  store.upsertUser(7, 'petro', 'Петро');
  store.replaceSubscriptions(7, ['INV1']);
  if (status) store.setUserStatus(7, status, 'web');

  const sent = [];
  let grafanaCalled = false;
  const commands = createCommands({
    store,
    telegram: { sendMessage: async (c, t) => sent.push(t), sendPhoto: async () => {} },
    grafana: {
      queryGrafana: async () => { grafanaCalled = true; return { results: { A: { frames: [] } } }; },
      renderGrafanaPanel: async () => { grafanaCalled = true; return Buffer.from(''); },
      getDashboardLink: () => 'https://g',
    },
    log: { info() {}, warn() {}, error() {} },
    sleep: () => Promise.resolve(),
  });
  return { store, commands, sent, grafana: () => grafanaCalled };
}

test('несхвалений не доходить до Grafana — рендер метрований', async () => {
  const { commands, sent, grafana } = gateHarness('pending');
  await commands.get('/graph')({ chatId: 7 });
  assert.equal(grafana(), false, 'запиту до Grafana бути не повинно');
  assert.match(sent[0], /розгляд/i);
});

test('відхиленому кажуть прямо і пропонують спробувати пізніше', async () => {
  const { commands, sent } = gateHarness('rejected');
  await commands.get('/status')({ chatId: 7 });
  assert.match(sent[0], /відхилено/i);
  assert.match(sent[0], /пізніше/i);
});

test('схвалений проходить до даних', async () => {
  const { commands, grafana } = gateHarness('approved');
  await commands.get('/status')({ chatId: 7 });
  assert.equal(grafana(), true);
});

test('/forgetme без підтвердження нічого не видаляє', async () => {
  const { commands, store, sent } = gateHarness('approved');
  await commands.get('/forgetme')({ chatId: 7 });
  assert.ok(store.getUser(7), 'користувач має лишитись');
  assert.match(sent[0], /підтверд/i);
});

function adminHarness() {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший', 'DASH');
  store.upsertUser(7, 'petro', 'Петро');
  store.replaceSubscriptions(7, ['INV1']);
  const toUser = [], toasts = [], texts = [];
  const callbacks = createCallbacks({
    store,
    telegram: {
      editMessageReplyMarkup: async () => {},
      editMessageText: async (c, m, t) => texts.push(t),
      answerCallbackQuery: async (id, t) => toasts.push(t),
      sendMessage: async (c, t) => toUser.push({ c, t }),
    },
    notifyAdmin: async () => {},
    log: { info() {}, warn() {}, error() {} },
    adminChatId: 99,
  });
  return { store, callbacks, toUser, toasts, texts };
}

test('адмін схвалює — статус міняється, користувач дізнається', async () => {
  const { store, callbacks, toUser } = adminHarness();
  await callbacks.get('a')({ chatId: 99, messageId: 1, callbackId: 'c', from: { id: 99 }, value: 'ok:7' });

  assert.equal(store.getUser(7).status, 'approved');
  assert.equal(toUser[0].c, 7);
  assert.match(toUser[0].t, /схвалено|доступ/i);
});

test('не-адмін не може схвалити нікого', async () => {
  const { store, callbacks } = adminHarness();
  await callbacks.get('a')({ chatId: 5, messageId: 1, callbackId: 'c', from: { id: 5 }, value: 'ok:7' });
  assert.equal(store.getUser(7).status, 'pending', 'статус не мав змінитись');
});

test('відхилення лишає підписки — людину можуть схвалити пізніше', async () => {
  const { store, callbacks } = adminHarness();
  await callbacks.get('a')({ chatId: 99, messageId: 1, callbackId: 'c', from: { id: 99 }, value: 'no:7' });
  assert.equal(store.getUser(7).status, 'rejected');
  assert.deepEqual(store.getSubscriptions(7).map(i => i.id), ['INV1']);
});

test('видалення себе прибирає користувача й підписки', async () => {
  const { store, callbacks } = adminHarness();
  await callbacks.get('fg')({ chatId: 7, messageId: 1, callbackId: 'c', from: { id: 7 }, value: 'yes' });
  assert.equal(store.getUser(7), undefined);
  assert.equal(store.raw.prepare('SELECT count(*) n FROM subscriptions').get().n, 0);
});

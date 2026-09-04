import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, createCommands } from './commands.js';
import { createDb } from './db.js';
import { decisionMessage } from './helpers.js';

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
  const adminMsgs = [];
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
    notifyAdmin: async msg => adminMsgs.push(msg),
    log: { info() {}, warn() {}, error() {} },
    sleep: () => Promise.resolve(),
  });
  return { store, commands, sent, photos, adminMsgs, ctx: { chatId: 7 } };
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
      queryGrafana: async () => { throw new Error('uid датасорсу ds-uid-that-must-not-leak'); },
      renderGrafanaPanel: async () => Buffer.from(''),
      getDashboardLink: () => 'https://g',
    },
    log: { info() {}, warn() {}, error() {} },
    sleep: () => Promise.resolve(),
  });
  store.replaceSubscriptions(7, ['INV1']);
  store.setUserStatus(7, 'approved', 'test');
  await commands.get('/status')(ctx);
  assert.doesNotMatch(sent.join(' '), /ds-uid-that-must-not-leak/);
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
  const edits = [], toasts = [], adminMsgs = [], adminOpts = [], texts = [], sent = [];
  const callbacks = createCallbacks({
    store,
    telegram: {
      editMessageReplyMarkup: async (c, m, markup) => edits.push(markup),
      editMessageText: async (c, m, text) => texts.push(text),
      answerCallbackQuery: async (id, text) => toasts.push(text),
      sendMessage: async (chatId, text) => sent.push({ chatId, text }),
    },
    notifyAdmin: async (msg, opts) => { adminMsgs.push(msg); adminOpts.push(opts); },
    log: { info() {}, warn() {}, error() {} },
  });
  const inverters = store.getAllInverters();
  return { store, callbacks, edits, toasts, adminMsgs, adminOpts, texts, sent, inverters };
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

test('/status пояснює знак потужності словами', async () => {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Перший', 'DASH');
  store.upsertUser(7, 'petro', 'Петро');
  store.replaceSubscriptions(7, ['INV1']);
  store.setUserStatus(7, 'approved', 'test');

  const sent = [];
  const commands = createCommands({
    store,
    telegram: { sendMessage: async (c, t) => sent.push(t), sendPhoto: async () => {} },
    grafana: {
      queryGrafana: async () => ({ results: { A: { frames: [{
        schema: { fields: [{ name: '_time' }, { name: 'soc' }, { name: 'power' }] },
        data: { values: [[1788455061000], [98], [-405]] },
      }] } } }),
      renderGrafanaPanel: async () => Buffer.from(''), getDashboardLink: () => 'https://g',
    },
    log: { info() {}, warn() {}, error() {} },
    sleep: () => Promise.resolve(),
  });

  await commands.get('/status')({ chatId: 7 });
  assert.match(sent[0], /-405/);
  assert.match(sent[0], /заряджається/, 'відʼємна потужність — це заряд');
});

test('/help ставить щоденні команди перед налаштуванням', async () => {
  // /status і /graph використовують постійно, /subscribe — раз. Порядок у
  // довідці має збігатися з порядком у меню Telegram, інакше людина шукає
  // очима те, що вже бачила в іншому місці.
  const { commands, sent, ctx } = harness();
  await commands.get('/help')(ctx);

  const text = sent[0].text;
  assert.ok(text.indexOf('/status') < text.indexOf('/subscribe'), '/status має бути вище');
  assert.ok(text.indexOf('/graph') < text.indexOf('/subscribe'), '/graph має бути вище');
});

test('/help не обіцяє аргумент там, де тепер клавіатура', async () => {
  const { commands, sent, ctx } = harness();
  await commands.get('/help')(ctx);
  assert.doesNotMatch(sent[0].text, /\/subscribe &lt;id&gt;/);
});

// --- Стан мережі в /status ---

function statusHarness({ gridVoltage, gridFails = false } = {}) {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Клочківська 117', 'DASH');
  store.upsertUser(7, 'petro', 'Петро');
  store.replaceSubscriptions(7, ['INV1']);
  store.setUserStatus(7, 'approved', 'test');

  const sent = [];
  const frame = (names, values) => ({ results: { A: { frames: [{
    schema: { fields: names.map(name => ({ name })) }, data: { values } } ] } } });

  const commands = createCommands({
    store,
    telegram: { sendMessage: async (c, t) => sent.push(t), sendPhoto: async () => {} },
    grafana: {
      queryGrafana: async flux => {
        if (flux.includes('"grid"')) {
          if (gridFails) throw new Error('Grafana 500 на запиті мережі');
          if (gridVoltage === undefined) return frame([], []);
          return frame(['_time', 'voltage'], [[1788455061000], [gridVoltage]]);
        }
        return frame(['_time', 'soc', 'power'], [[1788455061000], [98], [-405]]);
      },
      renderGrafanaPanel: async () => Buffer.from(''), getDashboardLink: () => 'https://g',
    },
    log: { info() {}, warn() {}, error() {} },
    sleep: () => Promise.resolve(),
  });
  return { commands, sent };
}

test('/status каже, що мережа є', async () => {
  const { commands, sent } = statusHarness({ gridVoltage: 237.3 });
  await commands.get('/status')({ chatId: 7 });
  assert.match(sent[0], /Мережа/);
  assert.match(sent[0], /є/);
});

test('/status каже, що живлення немає і обʼєкт на батареї', async () => {
  const { commands, sent } = statusHarness({ gridVoltage: 0 });
  await commands.get('/status')({ chatId: 7 });
  assert.match(sent[0], /немає/);
  assert.match(sent[0], /батаре/i);
});

test('без даних мережі рядок просто відсутній — не «невідомо»', async () => {
  const { commands, sent } = statusHarness({});
  await commands.get('/status')({ chatId: 7 });
  assert.doesNotMatch(sent[0], /Мережа/);
  assert.match(sent[0], /SOC/, 'решта стану на місці');
});

test('збій запиту мережі не забирає стан батареї', async () => {
  // Дані мережі другорядні; втратити через них SOC було б обміном навпаки.
  const { commands, sent } = statusHarness({ gridFails: true });
  await commands.get('/status')({ chatId: 7 });
  assert.match(sent[0], /SOC/);
  assert.doesNotMatch(sent[0], /Мережа/);
});

// --- Запрошені ніки ---

test('заявка від запрошеного схвалюється без адміна', async () => {
  const { callbacks, store, inverters } = cbHarness();
  store.addInvited('petro', 'Клочківська');

  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1'])));

  assert.equal(store.getUser(5).status, 'approved');
  assert.match(store.getUser(5).decided_by, /invite/);
});

test('запрошення шукається незалежно від регістру ніка в Telegram', async () => {
  const { callbacks, store, inverters } = cbHarness();
  store.addInvited('petro');

  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1']),
    { id: 5, username: 'Petro', first_name: 'Петро' }));

  assert.equal(store.getUser(5).status, 'approved');
});

test('запрошення витрачається першою ж заявкою', async () => {
  // Без цього правило «зміна набору обʼєктів іде на розгляд» перестало б
  // діяти для запрошених: людина мовчки додала б собі чужий будинок.
  const { callbacks, store, inverters } = cbHarness();
  store.addInvited('petro');

  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1'])));
  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1', 'INV2'])));

  assert.equal(store.getUser(5).status, 'pending');
  assert.deepEqual(store.listInvited(), []);
});

test('запрошений одразу читає, що доступ відкрито', async () => {
  const { callbacks, store, texts, inverters } = cbHarness();
  store.addInvited('petro');

  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1'])));

  assert.match(texts[0], /доступ відкрито/i);
  assert.doesNotMatch(texts[0], /на розгляд/i);
});

test('про автосхвалення адміну повідомляють, але без кнопок рішення', async () => {
  // Слід рішення має лишатись: адмін мусить бачити, кого впустило
  // запрошення, навіть якщо його не питали.
  const { callbacks, store, adminMsgs, adminOpts, inverters } = cbHarness();
  store.addInvited('petro');

  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1'])));

  assert.match(adminMsgs[0], /запрош/i);
  assert.equal(adminOpts[0]?.reply_markup, undefined);
});

test('заявка від незапрошеного все одно йде з кнопками рішення', async () => {
  const { callbacks, store, adminOpts, inverters } = cbHarness();
  store.addInvited('somebody_else');

  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1'])));

  assert.equal(store.getUser(5).status, 'pending');
  assert.ok(adminOpts[0]?.reply_markup, 'адмін мусить мати чим вирішити');
  assert.equal(store.listInvited().length, 1, 'чуже запрошення не витрачено');
});

test('людина без ніка в Telegram не ламає заявку', async () => {
  const { callbacks, store, inverters } = cbHarness();
  store.addInvited('petro');

  await callbacks.get('req')(ctx(buildKeyboard(inverters, ['INV1']),
    { id: 5, username: undefined, first_name: 'Без ніка' }));

  assert.equal(store.getUser(5).status, 'pending');
  assert.equal(store.listInvited().length, 1);
});

test('текстовий /subscribe теж витрачає запрошення', async () => {
  // Другий шлях подачі заявки. Якби запрошення тут не спрацьовувало,
  // воно мовчки не діяло б для тих, хто підписується за id.
  const { commands, store } = harness();
  store.setUserStatus(7, 'pending', 'test');
  store.addInvited('petro');

  await commands.get('/subscribe')({
    chatId: 7, arg: 'INV1', from: { username: 'petro', first_name: 'Петро' },
  });

  assert.equal(store.getUser(7).status, 'approved');
  assert.deepEqual(store.listInvited(), []);
});

test('текстовий /subscribe теж лишає слід автосхвалення в адміна', async () => {
  // Інакше запрошення витрачалось би зовсім безшумно: людина отримує доступ,
  // а адмін дізнається про це, лише відкривши адмінку.
  const { commands, store, adminMsgs } = harness();
  store.setUserStatus(7, 'pending', 'test');
  store.addInvited('petro');

  await commands.get('/subscribe')({
    chatId: 7, arg: 'INV1', from: { username: 'petro', first_name: 'Петро' },
  });

  assert.match(adminMsgs.join(' '), /запрош/i);
});

test('звичайний текстовий /subscribe адміна не смикає', async () => {
  const { commands, store, adminMsgs } = harness();
  store.setUserStatus(7, 'pending', 'test');

  await commands.get('/subscribe')({
    chatId: 7, arg: 'INV1', from: { username: 'petro', first_name: 'Петро' },
  });

  assert.deepEqual(adminMsgs, []);
});

test('схвалення з Telegram шле рівно той самий текст, що й веб-адмінка', async () => {
  // Сторож від розходження: тексти живуть в одному місці, і ця перевірка
  // впаде, щойно хтось поправить формулювання лише в одному зі шляхів.
  const { callbacks, toUser } = adminHarness();
  await callbacks.get('a')({ chatId: 99, messageId: 1, callbackId: 'c', from: { id: 99 }, value: 'ok:7' });

  assert.equal(toUser[0].t, decisionMessage('pending', 'approved'));
});

test('повторне схвалення того, хто вже має доступ, не шле нічого', async () => {
  // Рішення не змінилось — писати нема про що.
  const { store, callbacks, toUser } = adminHarness();
  store.setUserStatus(7, 'approved', 'test');

  await callbacks.get('a')({ chatId: 99, messageId: 1, callbackId: 'c', from: { id: 99 }, value: 'ok:7' });
  assert.deepEqual(toUser, []);
});

test('зняття доступу з Telegram каже про зняття, а не про відмову за заявкою', async () => {
  const { store, callbacks, toUser } = adminHarness();
  store.setUserStatus(7, 'approved', 'test');

  await callbacks.get('a')({ chatId: 99, messageId: 1, callbackId: 'c', from: { id: 99 }, value: 'no:7' });
  assert.match(toUser[0].t, /Доступ закрито/);
});

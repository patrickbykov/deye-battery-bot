import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAdminRoutes } from './admin-routes.js';
import { createDb } from './db.js';
import { deriveKeys, signSession, csrfToken } from './admin-auth.js';
import { decisionMessage, objectRemoved } from './helpers.js';

// Хеш не перевіряється в цих тестах — з нього лише виводяться ключі сесії
// й CSRF, тож будь-який стабільний рядок годиться.
const HASH = 'scrypt$16384$8$1$c2FsdA$aGFzaA';
const SID = 'test-session';

function harness({ notifyFails = false } = {}) {
  const store = createDb(':memory:');
  const notified = [], errors = [];
  const routes = createAdminRoutes({
    store, passwordHash: HASH,
    notifyUser: async (chatId, text) => {
      if (notifyFails) throw new Error('403 bot was blocked by the user');
      notified.push({ chatId, text });
    },
    log: { info() {}, warn() {}, error: m => errors.push(m) },
  });
  const keys = deriveKeys(HASH);
  const cookie = signSession({ sid: SID, exp: Math.floor(Date.now() / 1000) + 3600 }, keys.session);
  const csrf = csrfToken(SID, keys.csrf);

  const route = (method, path) => routes.find(r => r.method === method && r.path === path);

  // Тіло форми йде потоком, як і від справжнього http.Server.
  async function post(path, fields) {
    const body = new URLSearchParams(fields).toString();
    const req = Object.assign(Readable.from([Buffer.from(body)]), {
      method: 'POST', url: path,
      headers: { cookie: `deye_admin=${cookie}`, 'content-length': String(body.length) },
      socket: { remoteAddress: '127.0.0.1' },
    });
    const res = { statusCode: null, headers: null, body: '',
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(chunk) { this.body = chunk ?? ''; } };
    await route('POST', path).handler(req, res, {});
    return res;
  }

  return { store, post, csrf, notified, errors };
}

test('запрошує нік і нормалізує його', () => {
  const { store, post, csrf } = harness();
  return post('/admin/invites', { csrf, username: '@Volunteer', note: 'Клочківська' })
    .then(res => {
      assert.equal(res.statusCode, 303);
      assert.deepEqual(store.listInvited().map(r => r.username), ['volunteer']);
      assert.equal(store.listInvited()[0].note, 'Клочківська');
    });
});

test('порожнє поле ніка не створює запрошення — адмін лише зберіг список', async () => {
  const { store, post, csrf } = harness();
  store.addInvited('volunteer');
  const res = await post('/admin/invites', { csrf, username: '', note: '', keep: 'volunteer' });
  assert.equal(res.statusCode, 303);
  assert.deepEqual(store.listInvited().map(r => r.username), ['volunteer']);
});

test('негодящий нік не зберігається і пояснює причину на сторінці', async () => {
  const { store, post, csrf } = harness();
  const res = await post('/admin/invites', { csrf, username: 't.me/volunteer' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /нік/i);
  assert.deepEqual(store.listInvited(), []);
});

test('знятий чекбокс прибирає запрошення', async () => {
  const { store, post, csrf } = harness();
  store.addInvited('volunteer');
  store.addInvited('another_one');
  await post('/admin/invites', { csrf, username: '', keep: 'volunteer' });
  assert.deepEqual(store.listInvited().map(r => r.username), ['volunteer']);
});

test('щойно доданий нік не прибирається власним же збереженням', async () => {
  // keep[] приходить лише для тих, кого сторінка показувала. Новий нік у
  // ньому відсутній за побудовою, і наївне «видалити все, чого немає в keep»
  // з'їдало б його тієї ж миті.
  const { store, post, csrf } = harness();
  const res = await post('/admin/invites', { csrf, username: 'volunteer' });
  assert.equal(res.statusCode, 303);
  assert.deepEqual(store.listInvited().map(r => r.username), ['volunteer']);
});

test('без CSRF-токена нічого не змінюється', async () => {
  const { store, post } = harness();
  const res = await post('/admin/invites', { csrf: 'підроблений', username: 'volunteer' });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(store.listInvited(), []);
});

test('без сесії маршрут запрошень веде на форму входу', async () => {
  const store = createDb(':memory:');
  const routes = createAdminRoutes({
    store, passwordHash: HASH, log: { info() {}, warn() {}, error() {} },
  });
  const req = Object.assign(Readable.from([]), {
    method: 'POST', url: '/admin/invites', headers: {}, socket: { remoteAddress: '127.0.0.1' },
  });
  const res = { statusCode: null, headers: null,
    writeHead(s, h) { this.statusCode = s; this.headers = h; }, end() {} };

  await routes.find(r => r.path === '/admin/invites').handler(req, res, {});
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.Location, '/admin');
  assert.deepEqual(store.listInvited(), []);
});

// --- Рішення з вебу доходять до людини ---

function withUser(h, status = 'pending') {
  h.store.upsertUser(42, 'petro', 'Петро');
  if (status !== 'pending') h.store.setUserStatus(42, status, 'test');
  return h;
}

test('схвалення перемикачем доходить до людини в Telegram', async () => {
  // Без цього адмін тисне «Зберегти», а людина далі чекає й не знає, що
  // вже може питати /status.
  const h = withUser(harness());
  await h.post('/admin/users', { csrf: h.csrf, known: '42', approve: '42' });

  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].chatId, 42);
  assert.match(h.notified[0].text, /Доступ відкрито/);
});

test('відмова перемикачем теж доходить', async () => {
  const h = withUser(harness());
  await h.post('/admin/users', { csrf: h.csrf, known: '42' });

  assert.match(h.notified[0].text, /Заявку відхилено/);
});

test('зняття доступу каже саме про зняття, а не про відмову за заявкою', async () => {
  // Інакше підписник читає «заявку відхилено» про заявку, яку не подавав.
  const h = withUser(harness(), 'approved');
  await h.post('/admin/users', { csrf: h.csrf, known: '42' });

  assert.match(h.notified[0].text, /Доступ закрито/);
});

test('текст із вебу збігається з текстом Telegram-кнопки', async () => {
  const h = withUser(harness());
  await h.post('/admin/users', { csrf: h.csrf, known: '42', approve: '42' });

  assert.equal(h.notified[0].text, decisionMessage('pending', 'approved'));
});

test('незмінене рішення нікого не турбує', async () => {
  // Адмін відкрив сторінку й натиснув «Зберегти», нічого не чіпаючи.
  const h = withUser(harness(), 'approved');
  await h.post('/admin/users', { csrf: h.csrf, known: '42', approve: '42' });

  assert.deepEqual(h.notified, []);
});

test('заблокований бот не ламає збереження форми', async () => {
  // 403 «bot was blocked» — звичайна річ, і вона не має заважати адміну
  // зберегти рішення щодо решти людей.
  const h = withUser(harness({ notifyFails: true }));
  const res = await h.post('/admin/users', { csrf: h.csrf, known: '42', approve: '42' });

  assert.equal(res.statusCode, 303);
  assert.equal(h.store.getUser(42).status, 'approved', 'рішення записано попри збій');
  assert.equal(h.errors.length, 1);
});

test('видаленому користувачу нічого не шлють', async () => {
  // known[] може містити того, хто зробив /forgetme, поки сторінка була
  // відкрита. UPDATE не знайде рядка, і писати нема кому.
  const h = harness();
  await h.post('/admin/users', { csrf: h.csrf, known: '42', approve: '42' });

  assert.deepEqual(h.notified, []);
});

// --- Видалення обʼєкта ---

function withInverter(h) {
  h.store.upsertInverter('INV1', 'Клочківська 117');
  h.store.upsertInverter('INV2', 'Сумська 4');
  h.store.upsertUser(7, 'petro', 'Петро');
  h.store.replaceSubscriptions(7, ['INV1']);
  return h;
}

test('перший POST лише показує підтвердження і нічого не видаляє', async () => {
  // Кнопка в рядку не має бути мінним полем: один промах миші не мусить
  // знести обʼєкт разом із чужими підписками.
  const h = withInverter(harness());
  const res = await h.post('/admin/objects/delete', { csrf: h.csrf, id: 'INV1' });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Клочківська 117/);
  assert.ok(h.store.getInverter('INV1'), 'обʼєкт на місці');
  assert.deepEqual(h.notified, []);
});

test('сторінка підтвердження називає, скількох це зачепить', async () => {
  const h = withInverter(harness());
  const res = await h.post('/admin/objects/delete', { csrf: h.csrf, id: 'INV1' });
  assert.match(res.body, /1/);
});

test('підтверджений POST видаляє обʼєкт', async () => {
  const h = withInverter(harness());
  const res = await h.post('/admin/objects/delete', { csrf: h.csrf, id: 'INV1', confirm: '1' });

  assert.equal(res.statusCode, 303);
  assert.equal(h.store.getInverter('INV1'), undefined);
  assert.ok(h.store.getInverter('INV2'), 'сусіда не зачепило');
});

test('видалення лишає надгробок — discovery не поверне обʼєкт', async () => {
  const h = withInverter(harness());
  await h.post('/admin/objects/delete', { csrf: h.csrf, id: 'INV1', confirm: '1' });
  assert.ok(h.store.isIgnoredInverter('INV1'));
});

test('підписники дізнаються, що обʼєкт більше не відстежується', async () => {
  const h = withInverter(harness());
  await h.post('/admin/objects/delete', { csrf: h.csrf, id: 'INV1', confirm: '1' });

  assert.equal(h.notified.length, 1);
  assert.equal(h.notified[0].chatId, 7);
  assert.equal(h.notified[0].text, objectRemoved('Клочківська 117'));
});

test('збій сповіщення не скасовує видалення — воно вже в БД', async () => {
  const h = withInverter(harness({ notifyFails: true }));
  const res = await h.post('/admin/objects/delete', { csrf: h.csrf, id: 'INV1', confirm: '1' });

  assert.equal(res.statusCode, 303);
  assert.equal(h.store.getInverter('INV1'), undefined);
  assert.equal(h.errors.length, 1);
});

test('невідомий обʼєкт не малює підтвердження ні для чого', async () => {
  const h = withInverter(harness());
  const res = await h.post('/admin/objects/delete', { csrf: h.csrf, id: 'НЕМАЄ' });
  assert.equal(res.statusCode, 404);
});

test('видалення без CSRF-токена не відбувається', async () => {
  const h = withInverter(harness());
  const res = await h.post('/admin/objects/delete',
    { csrf: 'підроблений', id: 'INV1', confirm: '1' });

  assert.equal(res.statusCode, 403);
  assert.ok(h.store.getInverter('INV1'), 'обʼєкт на місці');
});

test('без сесії маршрут видалення веде на форму входу', async () => {
  const store = createDb(':memory:');
  store.upsertInverter('INV1', 'Клочківська 117');
  const routes = createAdminRoutes({
    store, passwordHash: HASH, log: { info() {}, warn() {}, error() {} },
  });
  const req = Object.assign(Readable.from([]), {
    method: 'POST', url: '/admin/objects/delete', headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = { writeHead(s, h) { this.statusCode = s; this.headers = h; }, end() {} };

  await routes.find(r => r.path === '/admin/objects/delete').handler(req, res, {});
  assert.equal(res.statusCode, 303);
  assert.ok(store.getInverter('INV1'));
});

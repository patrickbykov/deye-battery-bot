import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAdminRoutes } from './admin-routes.js';
import { createDb } from './db.js';
import { deriveKeys, signSession, csrfToken } from './admin-auth.js';

// Хеш не перевіряється в цих тестах — з нього лише виводяться ключі сесії
// й CSRF, тож будь-який стабільний рядок годиться.
const HASH = 'scrypt$16384$8$1$c2FsdA$aGFzaA';
const SID = 'test-session';

function harness() {
  const store = createDb(':memory:');
  const routes = createAdminRoutes({
    store, passwordHash: HASH, log: { info() {}, warn() {}, error() {} },
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

  return { store, post, csrf };
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

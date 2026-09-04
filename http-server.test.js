import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, readBody } from './http-server.js';

const silent = { info() {}, warn() {}, error() {} };

async function withServer({ routes = [], health = { healthy: true, ageMs: 0 } }, fn) {
  const server = createHttpServer({ getHealth: () => health, routes, log: silent });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(r => server.close(r)); }
}

test('health віддає 200 і не торкається таблиці маршрутів', async () => {
  const explode = () => { throw new Error('роутер не мав викликатись'); };
  await withServer({ routes: [{ method: 'GET', path: '/', handler: explode }] }, async base => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
  });
});

test('health віддає 503, коли цикл став', async () => {
  await withServer({ health: { healthy: false, ageMs: null } }, async base => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 503);
  });
});

test('невідомий шлях → 404, а не health', async () => {
  await withServer({}, async base => {
    assert.equal((await fetch(base + '/nope')).status, 404);
  });
});

test('відомий шлях з іншим методом → 405', async () => {
  const routes = [{ method: 'POST', path: '/hooks/grafana', handler: async () => {} }];
  await withServer({ routes }, async base => {
    assert.equal((await fetch(base + '/hooks/grafana')).status, 405);
  });
});

test('виняток у хендлері → 500, процес живий, деталі не течуть', async () => {
  const routes = [{ method: 'GET', path: '/boom', handler: async () => {
    throw new Error('таємниця з uid датасорсу');
  } }];
  await withServer({ routes }, async base => {
    const res = await fetch(base + '/boom');
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /таємниця/);
    assert.equal((await fetch(base + '/nope')).status, 404, 'сервер живий далі');
  });
});

test('health не отримує заголовків адмінки, решта отримує', async () => {
  const routes = [{ method: 'GET', path: '/x', handler: async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  } }];
  await withServer({ routes }, async base => {
    const admin = await fetch(base + '/x');
    assert.equal(admin.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(admin.headers.get('cache-control'), 'no-store');

    const health = await fetch(base + '/');
    assert.equal(health.headers.get('x-content-type-options'), null);
  });
});

test('readBody кидає 413 понад ліміт', async () => {
  const stream = (async function* () { yield Buffer.alloc(100); })();
  stream.destroy = () => {};
  await assert.rejects(() => readBody(stream, { limitBytes: 10 }), /413|too large/i);
});

test('readBody повертає тіло в межах ліміту', async () => {
  const stream = (async function* () { yield Buffer.from('привіт'); })();
  stream.destroy = () => {};
  assert.equal((await readBody(stream, { limitBytes: 1000 })).toString(), 'привіт');
});

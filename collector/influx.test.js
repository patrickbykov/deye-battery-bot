import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInfluxWriter } from './influx.js';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 204 };
    return { ok: r.status < 300, status: r.status, text: async () => r.body ?? '' };
  };
  fn.calls = calls;
  return fn;
}

function writer(fetchFn) {
  return createInfluxWriter({
    url: 'https://influx.test', org: 'Engineering', bucket: 'monitoring',
    token: 'INFLUX_SECRET', fetchFn, sleep: () => Promise.resolve(),
  });
}

test('пише line protocol з precision=s у вказаний бакет', async () => {
  const fetchFn = fakeFetch([]);
  await writer(fetchFn).write('battery,inverter=SN1 soc=98 1788455061');

  const { url, init } = fetchFn.calls[0];
  assert.equal(url, 'https://influx.test/api/v2/write?org=Engineering&bucket=monitoring&precision=s');
  assert.equal(init.headers.Authorization, 'Token INFLUX_SECRET');
  assert.equal(init.body, 'battery,inverter=SN1 soc=98 1788455061');
});

test('не робить запиту, якщо писати нічого', async () => {
  const fetchFn = fakeFetch([]);
  await writer(fetchFn).write('');
  assert.equal(fetchFn.calls.length, 0);
});

test('кидає помилку з тілом відповіді, якщо запис відхилено', async () => {
  const fetchFn = fakeFetch([
    { status: 400, body: '{"code":"invalid","message":"table schema conflict"}' },
  ]);
  await assert.rejects(() => writer(fetchFn).write('battery,inverter=SN1 soc=98i 1'),
                       /schema conflict/);
});

test('не кладе токен у текст помилки', async () => {
  const fetchFn = fakeFetch([{ status: 400, body: 'bad' }]);
  await assert.rejects(() => writer(fetchFn).write('x'), err => {
    assert.doesNotMatch(err.message, /INFLUX_SECRET/);
    return true;
  });
});

test('повторює спробу після 5xx', async () => {
  const fetchFn = fakeFetch([{ status: 503, body: 'upstream' }, { status: 204 }]);
  await writer(fetchFn).write('battery,inverter=SN1 soc=98 1');
  assert.equal(fetchFn.calls.length, 2);
});

test('не повторює спробу після 400 — сміття не стане валідним', async () => {
  const fetchFn = fakeFetch([{ status: 400, body: 'schema conflict' }]);
  await assert.rejects(() => writer(fetchFn).write('x'));
  assert.equal(fetchFn.calls.length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeyeClient } from './deye.js';

const TOKEN_OK = { success: true, code: '1000000', accessToken: 'TOK1', expiresIn: '5183999' };
const TOKEN_OK2 = { ...TOKEN_OK, accessToken: 'TOK2' };
const LATEST_OK = {
  success: true, code: '1000000',
  deviceDataList: [{ deviceSn: 'SN1', collectionTime: 1, dataList: [] }],
};
// Помилки Deye приходять з HTTP 200 — розрізняються тільки тілом.
const INVALID_TOKEN = { success: false, code: '2101019', msg: 'auth invalid token' };
// Форма підтверджена живим запитом 2026-09-03.
const STATIONS_OK = {
  success: true, code: '1000000',
  stationList: [{
    id: 900001, name: 'Станція 1',
    deviceListItems: [
      { deviceSn: 'COLLECTOR1', deviceType: 'COLLECTOR' },
      { deviceSn: '2000000001', deviceType: 'INVERTER' },
    ],
  }],
};

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const body = responses.shift();
    if (!body) throw new Error(`неочікуваний запит: ${url}`);
    if (body instanceof Error) throw body;
    const { __status: status = 200, ...payload } = body;
    return { ok: status < 300, status, json: async () => payload };
  };
  fn.calls = calls;
  return fn;
}

function client(fetchFn, now = () => 0) {
  return createDeyeClient({
    baseUrl: 'https://deye.test/v1.0', appId: 'APP', appSecret: 'SECRET',
    email: 'a@b.c', password: 'hunter2', fetchFn, now,
    sleep: () => Promise.resolve(),
  });
}

test('логіниться і підписує запит даних отриманим токеном', async () => {
  const fetchFn = fakeFetch([TOKEN_OK, LATEST_OK]);
  await client(fetchFn).getLatest(['SN1']);

  assert.match(fetchFn.calls[0].url, /\/account\/token\?appId=APP$/);
  assert.equal(fetchFn.calls[1].init.headers.Authorization, 'bearer TOK1');
});

test('не логіниться вдруге, поки токен свіжий', async () => {
  const fetchFn = fakeFetch([TOKEN_OK, LATEST_OK, LATEST_OK]);
  const deye = client(fetchFn);
  await deye.getLatest(['SN1']);
  await deye.getLatest(['SN1']);

  assert.equal(fetchFn.calls.filter(c => c.url.includes('/account/token')).length, 1);
});

test('перелогінюється, коли до протухання лишився менше ніж запас', async () => {
  const fetchFn = fakeFetch([TOKEN_OK, LATEST_OK, TOKEN_OK2, LATEST_OK]);
  let clock = 0;
  const deye = client(fetchFn, () => clock);
  await deye.getLatest(['SN1']);
  clock = (5183999 - 3600) * 1000; // лишилась година — менше за добовий запас
  await deye.getLatest(['SN1']);

  assert.equal(fetchFn.calls.filter(c => c.url.includes('/account/token')).length, 2);
  assert.equal(fetchFn.calls[3].init.headers.Authorization, 'bearer TOK2');
});

test('на code 2101019 перелогінюється і повторює запит', async () => {
  const fetchFn = fakeFetch([TOKEN_OK, INVALID_TOKEN, TOKEN_OK2, LATEST_OK]);
  const res = await client(fetchFn).getLatest(['SN1']);

  assert.equal(res[0].deviceSn, 'SN1');
  assert.equal(fetchFn.calls[3].init.headers.Authorization, 'bearer TOK2');
});

test('не зациклюється: другий 2101019 поспіль кидає помилку', async () => {
  const fetchFn = fakeFetch([TOKEN_OK, INVALID_TOKEN, TOKEN_OK2, INVALID_TOKEN]);
  await assert.rejects(() => client(fetchFn).getLatest(['SN1']), /2101019/);
});

test('не кладе секрети в текст помилки', async () => {
  const fetchFn = fakeFetch([{ success: false, code: '2101007', msg: 'bad credentials' }]);
  await assert.rejects(() => client(fetchFn).getLatest(['SN1']), err => {
    assert.doesNotMatch(err.message, /SECRET|hunter2/);
    return true;
  });
});

test('повертає лише серійники інверторів, без логера й банок', async () => {
  const fetchFn = fakeFetch([TOKEN_OK, STATIONS_OK]);
  const sns = await client(fetchFn).listInverterSns();

  assert.deepEqual(sns, ['2000000001']);
  assert.match(fetchFn.calls[1].url, /\/station\/listWithDevice$/);
});

test('перелогінюється і повторює також у списку пристроїв', async () => {
  const fetchFn = fakeFetch([TOKEN_OK, INVALID_TOKEN, TOKEN_OK2, STATIONS_OK]);
  assert.deepEqual(await client(fetchFn).listInverterSns(), ['2000000001']);
});

test('показує код і повідомлення Deye, навіть коли статус 400', async () => {
  // Помилки валідації параметрів приходять з HTTP 400 і тілом success:false —
  // на відміну від помилок автентифікації, що йдуть з 200.
  const fetchFn = fakeFetch([
    TOKEN_OK,
    { __status: 400, success: false, code: '2101006', msg: 'size max 50' },
  ]);
  await assert.rejects(() => client(fetchFn).listInverterSns(), /2101006.*size max 50/);
});

test('забирає всі сторінки станцій, а не лише першу', async () => {
  const page = (ids, total) => ({
    success: true, code: '1000000', stationTotal: total,
    stationList: ids.map(id => ({
      id, deviceListItems: [{ deviceSn: `SN${id}`, deviceType: 'INVERTER' }],
    })),
  });
  const first = Array.from({ length: 50 }, (_, i) => i + 1);
  const fetchFn = fakeFetch([TOKEN_OK, page(first, 51), page([51], 51)]);

  const sns = await client(fetchFn).listInverterSns();

  assert.equal(sns.length, 51);
  assert.equal(JSON.parse(fetchFn.calls[2].init.body).page, 2);
});

test('повторює запит після мережевої помилки', async () => {
  const fetchFn = fakeFetch([
    TOKEN_OK,
    Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    LATEST_OK,
  ]);
  const res = await client(fetchFn).getLatest(['SN1']);

  assert.equal(res[0].deviceSn, 'SN1');
  assert.equal(fetchFn.calls.length, 3);
});

test('здається після вичерпання спроб, а не зависає', async () => {
  const fetchFn = fakeFetch([
    TOKEN_OK,
    new Error('мережа 1'), new Error('мережа 2'), new Error('мережа 3'),
  ]);
  await assert.rejects(() => client(fetchFn).getLatest(['SN1']), /мережа 3/);
});

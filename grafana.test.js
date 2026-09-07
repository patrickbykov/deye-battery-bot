import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGrafanaRetry, panelRenderUrl } from './grafana.js';

test('повертає результат з першої вдалої спроби', async () => {
  let calls = 0;
  const result = await withGrafanaRetry(async () => { calls++; return 'ok'; }, { sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('повторює після 5xx і врешті віддає результат', async () => {
  // Одна 5xx від Grafana не має ставати видимою користувачу помилкою.
  let calls = 0;
  const result = await withGrafanaRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('Grafana 503'), { retryable: true });
    return 'ok';
  }, { sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('не повторює те, що від повторення не полагодиться', async () => {
  let calls = 0;
  await assert.rejects(() => withGrafanaRetry(async () => {
    calls++;
    throw Object.assign(new Error('401 Unauthorized'), { retryable: false });
  }, { sleep: async () => {} }));
  assert.equal(calls, 1, 'протухлий токен від ретраю не оживе');
});

test('здається після вичерпання спроб', async () => {
  let calls = 0;
  await assert.rejects(() => withGrafanaRetry(async () => {
    calls++;
    throw Object.assign(new Error('Grafana 500'), { retryable: true });
  }, { attempts: 3, sleep: async () => {} }), /Grafana 500/);
  assert.equal(calls, 3);
});

const INV = { id: 'INV1', dashboard_uid: null, panel_id: null };

test('render-URL несе var-inverter — без нього дашборд віддає ту саму картинку всім', () => {
  // Пастка задачі 08: Grafana мовчки ігнорує невідомий var-параметр, і
  // помилки не буде — просто однаковий графік для різних об'єктів.
  const url = panelRenderUrl(INV, { baseUrl: 'https://g', defaultDashboardUid: 'DASH' });
  assert.match(url, /var-inverter=INV1/);
  assert.match(url, /^https:\/\/g\/render\/d-solo\/DASH\//);
});

test('render-URL кодує id інвертора', () => {
  const url = panelRenderUrl({ id: 'a b&c' }, { baseUrl: 'https://g', defaultDashboardUid: 'DASH' });
  assert.match(url, /var-inverter=a\+b%26c/);
});

test('panel_id інвертора перекриває панель SOC за замовчуванням', () => {
  const url = panelRenderUrl({ id: 'INV1', panel_id: 9 }, { baseUrl: 'https://g', defaultDashboardUid: 'DASH' });
  assert.match(url, /panelId=9/);
});

test('явний panelId перекриває panel_id інвертора', () => {
  // Шлях /outages: панель теплокарти спільна для всіх об'єктів, тоді як
  // panel_id у БД вказує на панель SOC саме цього об'єкта.
  const url = panelRenderUrl({ id: 'INV1', panel_id: 9 }, {
    baseUrl: 'https://g', defaultDashboardUid: 'DASH', panelId: 12,
  });
  assert.match(url, /panelId=12/);
  assert.doesNotMatch(url, /panelId=9/);
});

test('вікно рендера задається викликачем', () => {
  const url = panelRenderUrl(INV, { baseUrl: 'https://g', defaultDashboardUid: 'DASH', from: 'now-30d' });
  assert.match(url, /from=now-30d/);
  assert.match(url, /to=now/);
});

test('dashboard_uid інвертора перекриває дашборд за замовчуванням', () => {
  const url = panelRenderUrl({ id: 'INV1', dashboard_uid: 'OWN' }, {
    baseUrl: 'https://g', defaultDashboardUid: 'DASH',
  });
  assert.match(url, /\/d-solo\/OWN\//);
});

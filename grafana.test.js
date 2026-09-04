import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGrafanaRetry } from './grafana.js';

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

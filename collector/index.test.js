import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startCollector } from './index.js';

const env = {
  DEYE_APP_ID: 'a', DEYE_APP_SECRET: 's', DEYE_EMAIL: 'e', DEYE_PASSWORD: 'p',
  INFLUX_URL: 'http://influx', INFLUX_ORG: 'o', INFLUX_TOKEN: 't',
  COLLECT_INTERVAL: '90000',
};
const silent = { info() {}, warn() {}, error() {} };

test('startCollector падає одразу, якщо секретів немає', () => {
  assert.throws(() => startCollector({ env: {}, log: silent }), /DEYE_APP_ID/);
});

test('збій циклу не зупиняє планування, а успіх видно через lastSuccessAt', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let calls = 0;
    let last = null;
    const collector = {
      runCycle: async () => {
        calls++;
        if (calls === 1) throw new Error('Deye лежить');
        last = 123;
      },
      lastSuccessAt: () => last,
    };

    const handle = startCollector({ env, log: silent, collector });
    assert.equal(handle.stalenessLimitMs, 900_000);
    await new Promise(setImmediate);
    assert.equal(calls, 1);
    assert.equal(handle.lastSuccessAt(), null);

    mock.timers.tick(10 * 60_000); // будь-який відступ після одного збою коротший
    await new Promise(setImmediate);
    assert.equal(calls, 2);
    assert.equal(handle.lastSuccessAt(), 123);
  } finally {
    mock.timers.reset();
  }
});

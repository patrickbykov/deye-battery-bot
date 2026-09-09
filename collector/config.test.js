import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const complete = {
  DEYE_APP_ID: 'APP', DEYE_APP_SECRET: 'S', DEYE_EMAIL: 'a@b.c', DEYE_PASSWORD: 'p',
  INFLUX_URL: 'https://influx.test', INFLUX_ORG: 'Engineering', INFLUX_TOKEN: 'T',
};

test('називає всі відсутні змінні одразу, а не по одній', () => {
  assert.throws(
    () => loadConfig({ ...complete, DEYE_APP_SECRET: undefined, INFLUX_TOKEN: '' }),
    /DEYE_APP_SECRET.*INFLUX_TOKEN|INFLUX_TOKEN.*DEYE_APP_SECRET/s
  );
});

test('підставляє дефолти для необов язкових', () => {
  const cfg = loadConfig(complete);
  assert.equal(cfg.influx.bucket, 'monitoring');
  assert.equal(cfg.collectIntervalMs, 90_000);
  assert.equal(cfg.deye.baseUrl, 'https://eu1-developer.deyecloud.com/v1.0');
});

test('не тримає секрети в перелічуваному вигляді для логів', () => {
  const cfg = loadConfig(complete);
  assert.doesNotMatch(JSON.stringify(cfg), /"S"|"p"|"T"/);
});

test('відхиляє інтервал, коротший за поріг безпеки для Deye API', () => {
  assert.throws(
    () => loadConfig({ ...complete, COLLECT_INTERVAL: '5000' }),
    /COLLECT_INTERVAL/
  );
});

test('ліміт несвіжості не тісніший за 15 хв навіть на коротких інтервалах', () => {
  const cfg = loadConfig({ ...complete, COLLECT_INTERVAL: '90000' });
  assert.equal(cfg.stalenessLimitMs, 900_000);
});

test('на довгих інтервалах ліміт несвіжості росте разом з ними', () => {
  const cfg = loadConfig({ ...complete, COLLECT_INTERVAL: '600000' });
  assert.equal(cfg.stalenessLimitMs, 1_800_000);
});

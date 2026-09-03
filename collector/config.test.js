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
  assert.equal(cfg.collectIntervalMs, 300_000);
  assert.equal(cfg.deye.baseUrl, 'https://eu1-developer.deyecloud.com/v1.0');
});

test('не тримає секрети в перелічуваному вигляді для логів', () => {
  const cfg = loadConfig(complete);
  assert.doesNotMatch(JSON.stringify(cfg), /"S"|"p"|"T"/);
});

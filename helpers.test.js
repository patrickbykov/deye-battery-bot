import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, renderSocBar, redact } from './helpers.js';

test('fmt повертає N/A для нечислового рядка, а не "NaN"', () => {
  assert.equal(fmt('abc'), 'N/A');
});

test('fmt форматує число із заданою точністю', () => {
  assert.equal(fmt(53.926, 2), '53.93');
});

test('renderSocBar не падає на SOC понад 100', () => {
  // Збої BMS з виходом SOC за діапазон — звичайна річ, а '░'.repeat(-1)
  // це RangeError, тобто /status падає замість відповіді.
  assert.equal(renderSocBar(105), '[██████████]');
});

test('renderSocBar не падає на відʼємному SOC', () => {
  assert.equal(renderSocBar(-5), '[░░░░░░░░░░]');
});

test('redact вирізає токен бота з тексту помилки', () => {
  // node-fetch вкладає повний URL у текст FetchError, а console.error цього
  // тексту стоїть у циклі, що б'ється в Telegram щосекунди. Один DNS-збій —
  // і токен бота лежить у логах Fly назавжди.
  const err = 'request to https://api.telegram.org/bot8123456:AAF-xY_z9Q/getUpdates?offset=1 failed';
  assert.equal(
    redact(err),
    'request to https://api.telegram.org/bot<REDACTED>/getUpdates?offset=1 failed'
  );
});

test('redact не чіпає текст без токена', () => {
  assert.equal(redact('Grafana query failed: 500'), 'Grafana query failed: 500');
});

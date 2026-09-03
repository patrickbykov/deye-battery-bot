import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthStatus } from './health.js';

const LIMIT = 180_000;

test('нездоровий, поки жодного успішного полінгу не було', () => {
  // Саме тут стара версія віддавала 200: HTTP-сервер піднімався поза main(),
  // тож Fly бачив OK навіть коли polling не стартував узагалі.
  assert.deepEqual(healthStatus(null, LIMIT, 1_000_000), { healthy: false, ageMs: null });
});

test('здоровий одразу після успішного полінгу', () => {
  assert.deepEqual(healthStatus(1_000_000, LIMIT, 1_000_000), { healthy: true, ageMs: 0 });
});

test('здоровий, поки не вичерпано поріг', () => {
  assert.equal(healthStatus(1_000_000, LIMIT, 1_000_000 + LIMIT - 1).healthy, true);
});

test('нездоровий, коли останній успіх старший за поріг', () => {
  const status = healthStatus(1_000_000, LIMIT, 1_000_000 + LIMIT);
  assert.equal(status.healthy, false);
  assert.equal(status.ageMs, LIMIT);
});

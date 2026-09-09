import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelayMs } from './schedule.js';

test('без збоїв цикл ходить рівно за інтервалом', () => {
  assert.equal(nextDelayMs({ intervalMs: 90_000, failures: 0 }), 90_000);
});

test('кожен наступний збій поспіль подвоює паузу', () => {
  assert.equal(nextDelayMs({ intervalMs: 90_000, failures: 1 }), 180_000);
  assert.equal(nextDelayMs({ intervalMs: 90_000, failures: 2 }), 360_000);
});

test('пауза не росте нескінченно — інакше колектор не оживе сам', () => {
  assert.equal(nextDelayMs({ intervalMs: 90_000, failures: 99 }), 600_000);
});

test('стеля не робить паузу коротшою за власний інтервал', () => {
  assert.equal(nextDelayMs({ intervalMs: 1_800_000, failures: 3 }), 1_800_000);
});

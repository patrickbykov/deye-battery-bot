import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGridContext, isGridAlert } from './grid-context.js';

const frame = (names, vals) => ({ results: { A: { frames: [{ schema: { fields: names.map(name => ({ name })) }, data: { values: vals.map(v => [v]) } }] } } });

test('збирає soc/power/мережу з двох запитів', async () => {
  const q = async flux => flux.includes('"grid"')
    ? frame(['_time', 'voltage', 'frequency', 'power'], [1000, 224, 50, 970])
    : frame(['_time', 'soc', 'power'], [2000, 96, 511]);
  const ctx = await fetchGridContext('X', q);
  assert.deepEqual(ctx, { soc: 96, batteryPower: 511, batteryTime: 2000, grid: { voltage: 224, frequency: 50, power: 970, time: 1000 } });
});

test('порожні кадри → null-поля, збій запиту → null', async () => {
  const empty = await fetchGridContext('X', async () => ({ results: { A: { frames: [] } } }));
  assert.equal(empty.soc, null);
  assert.equal(empty.grid, null);
  assert.equal(await fetchGridContext('X', async () => { throw new Error('boom'); }), null);
  assert.equal(await fetchGridContext(null, async () => ({})), null);
});

test('isGridAlert впізнає лише правило мережі', () => {
  assert.ok(isGridAlert({ alertname: '⚡ Немає живлення від мережі' }));
  assert.ok(!isGridAlert({ alertname: '🔌 Інвертор відʼєднався' }));
});

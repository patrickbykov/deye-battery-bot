import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGridContext, isGridAlert } from './grid-context.js';

const frame = (names, vals) => ({ results: { A: { frames: [{ schema: { fields: names.map(name => ({ name })) }, data: { values: vals.map(v => [v]) } }] } } });

const loadFrame = (n, sum, first, last) => frame(['n', 'sum', 'first', 'last'], [n, sum, first, last]);
const HOUR = 3600_000;

const router = (over = {}) => async flux => {
  if (flux.includes('union(')) return over.load ?? loadFrame(2, 820, 0, 3 * HOUR);
  if (flux.includes('"battery_info"')) return over.info ?? frame(['_time', 'capacity_ah'], [5, 200]);
  if (flux.includes('"grid"')) return frame(['_time', 'voltage', 'frequency', 'power'], [1000, 224, 50, 970]);
  return frame(['_time', 'soc', 'power'], [2000, 96, 511]);
};

test('збирає soc, середнє навантаження, ємність і мережу', async () => {
  const ctx = await fetchGridContext('X', router());
  assert.deepEqual(ctx, { soc: 96, avgPower: 410, capacityAh: 200, batteryTime: 2000, grid: { voltage: 224, frequency: 50, power: 970, time: 1000 } });
});

test('середнє: менше 2 год історії або немає ємності → null', async () => {
  const short = await fetchGridContext('X', router({ load: loadFrame(2, 820, 0, HOUR), info: { results: { A: { frames: [] } } } }));
  assert.equal(short.avgPower, null);
  assert.equal(short.capacityAh, null);
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

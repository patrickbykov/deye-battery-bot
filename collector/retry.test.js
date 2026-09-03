import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './retry.js';

const noSleep = () => Promise.resolve();

test('повертає результат, не повторюючи, якщо спроба вдала', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; }, { sleep: noSleep });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('повторює після помилки і повертає результат', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('мережа впала');
    return 'ok';
  }, { sleep: noSleep });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('кидає останню помилку, вичерпавши спроби', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error(`збій ${calls}`); },
                    { attempts: 3, sleep: noSleep }),
    /збій 3/
  );
  assert.equal(calls, 3);
});

test('збільшує паузу експоненційно', async () => {
  const delays = [];
  await assert.rejects(() => withRetry(
    async () => { throw new Error('нема'); },
    { attempts: 4, baseDelayMs: 500, sleep: ms => { delays.push(ms); return Promise.resolve(); } }
  ));
  assert.deepEqual(delays, [500, 1000, 2000]);
});

test('не повторює, якщо shouldRetry відхилив помилку', async () => {
  let calls = 0;
  await assert.rejects(() => withRetry(
    async () => { calls++; throw Object.assign(new Error('назавжди'), { permanent: true }); },
    { attempts: 5, sleep: noSleep, shouldRetry: err => !err.permanent }
  ), /назавжди/);
  assert.equal(calls, 1);
});

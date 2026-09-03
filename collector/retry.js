const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// Пауза між спробами росте як baseDelayMs * 2^n. Після останньої спроби
// не спимо — одразу кидаємо помилку нагору, хай вирішує цикл.
export async function withRetry(fn, {
  attempts = 3, baseDelayMs = 500, sleep = defaultSleep, shouldRetry = () => true,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts - 1 || !shouldRetry(err)) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

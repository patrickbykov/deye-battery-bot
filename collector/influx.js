import { withRetry } from './retry.js';

const REQUEST_TIMEOUT_MS = 20_000;

// 4xx означає, що рядок не стане валідним від повторення (найчастіше —
// конфлікт типів у схемі). Ретраїмо лише мережу й 5xx.
class PermanentWriteError extends Error {
  permanent = true;
}

export function createInfluxWriter({ url, org, bucket, token, fetchFn = globalThis.fetch, sleep }) {
  const endpoint = `${url}/api/v2/write?org=${encodeURIComponent(org)}` +
                   `&bucket=${encodeURIComponent(bucket)}&precision=s`;

  async function attempt(lineProtocol) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchFn(endpoint, {
        method: 'POST',
        headers: { Authorization: `Token ${token}`, 'Content-Type': 'text/plain; charset=utf-8' },
        body: lineProtocol,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return;

    // Тіло від Influx безпечне: воно описує рядок, а не креденшели.
    const body = (await res.text()).slice(0, 500);
    const message = `InfluxDB write: HTTP ${res.status} ${body}`;
    throw res.status >= 400 && res.status < 500
      ? new PermanentWriteError(message)
      : new Error(message);
  }

  async function write(lineProtocol) {
    if (!lineProtocol) return;
    await withRetry(() => attempt(lineProtocol), {
      sleep,
      shouldRetry: err => !err.permanent,
    });
  }

  return { write };
}

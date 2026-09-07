import fetch from 'node-fetch';
import { GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID, DASHBOARD_UID } from './config.js';

const TIMEOUT_MS = 20_000;

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// Одна 5xx від Grafana не має ставати видимою користувачу помилкою. Але
// ретраїти все підряд теж не можна: протухлий токен від повторення не оживе,
// а зайві спроби палять квоту метрованого рендера на Free-плані.
export async function withGrafanaRetry(fn, { attempts = 3, baseDelayMs = 400, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts - 1 || err.retryable === false) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

// Жоден fetch не має лишатись без таймаута: зависла сесія блокує цикл бота.
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function queryGrafanaOnce(fluxQuery) {
  const res = await fetchWithTimeout(`${GRAFANA_URL}/api/ds/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GRAFANA_SA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      queries: [{
        refId: 'A',
        datasource: { uid: GRAFANA_DS_UID, type: 'influxdb' },
        query: fluxQuery,
        maxDataPoints: 1
      }],
      from: 'now-1h',
      to: 'now'
    })
  });

  if (!res.ok) {
    // Сире тіло Grafana містить uid датасорсів, помилки парсингу Flux
    // і внутрішні хости — воно йде в лог, а не користувачу.
    console.error(`Grafana query failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    throw Object.assign(new Error('grafana-query-failed'), { retryable: res.status >= 500 });
  }
  return res.json();
}

export const queryGrafana = flux => withGrafanaRetry(() => queryGrafanaOnce(flux));

// Панель SOC — та, яку рендерить /graph. Число зашите в дашборді, тож
// живе тут іменованою константою, а не магічною шісткою в тілі функції.
export const SOC_PANEL_ID = 6;

// Чиста частина рендера: вибір дашборда, панелі й вікна. Винесена окремо,
// бо саме тут ховається пастка задачі 08 — без var-inverter Grafana мовчки
// віддає ту саму картинку для всіх об'єктів, і помилки при цьому немає.
export function panelRenderUrl(inverter, {
  baseUrl, defaultDashboardUid, panelId, from = 'now-24h', to = 'now', width = 800, height = 400,
} = {}) {
  const dashUid = inverter.dashboard_uid || defaultDashboardUid;
  // Явний panelId має перекривати panel_id об'єкта: у БД він вказує на
  // панель SOC саме цього об'єкта, а теплокарта — спільна для всіх.
  const panel = panelId ?? inverter.panel_id ?? SOC_PANEL_ID;
  const params = new URLSearchParams({
    orgId: '1',
    panelId: String(panel),
    width: String(width),
    height: String(height),
    from,
    to,
    'var-inverter': inverter.id,
  });
  return `${baseUrl}/render/d-solo/${dashUid}/?${params}`;
}

export async function renderGrafanaPanel(inverter, options = {}) {
  const renderUrl = panelRenderUrl(inverter, {
    baseUrl: GRAFANA_URL, defaultDashboardUid: DASHBOARD_UID, ...options,
  });
  const res = await fetchWithTimeout(renderUrl, {
    headers: { 'Authorization': `Bearer ${GRAFANA_SA_TOKEN}` }
  });

  if (!res.ok) throw Object.assign(new Error(`Render failed: ${res.status}`), { retryable: res.status >= 500 });

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

export function getDashboardLink(inverter) {
  const dashUid = inverter.dashboard_uid || DASHBOARD_UID;
  return `${GRAFANA_URL}/d/${dashUid}`;
}

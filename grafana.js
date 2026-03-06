import fetch from 'node-fetch';
import { GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID, DASHBOARD_UID } from './config.js';

export async function queryGrafana(fluxQuery) {
  const res = await fetch(`${GRAFANA_URL}/api/ds/query`, {
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
    const text = await res.text();
    throw new Error(`Grafana query failed: ${res.status} ${text}`);
  }
  return res.json();
}

export async function renderGrafanaPanel() {
  const renderUrl = `${GRAFANA_URL}/render/d-solo/${DASHBOARD_UID}/deye-sun-15k-battery-monitor?orgId=1&panelId=6&width=800&height=400&from=now-24h&to=now`;
  const res = await fetch(renderUrl, {
    headers: { 'Authorization': `Bearer ${GRAFANA_SA_TOKEN}` }
  });

  if (!res.ok) throw new Error(`Render failed: ${res.status}`);

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

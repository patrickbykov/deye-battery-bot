import fetch from 'node-fetch';

// --- Config from environment ---
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GRAFANA_URL = process.env.GRAFANA_URL;
const GRAFANA_SA_TOKEN = process.env.GRAFANA_SA_TOKEN;
const GRAFANA_DS_UID = process.env.GRAFANA_DS_UID;
const DASHBOARD_UID = process.env.GRAFANA_DASHBOARD_UID;
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || 'monitoring';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000');

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
let lastUpdateId = 0;

// --- Helper: format value ---
function fmt(v, decimals = 1) {
  if (v === null || v === undefined || isNaN(v)) return 'N/A';
  return Number(v).toFixed(decimals);
}

// --- Query Grafana (InfluxDB via Grafana proxy) ---
async function queryGrafana(fluxQuery) {
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

// --- /status command ---
async function handleStatus(chatId) {
  try {
    const flux = `from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "battery")
  |> filter(fn: (r) => r.inverter == "Deye-SUN-15K")
  |> last()
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;

    const data = await queryGrafana(flux);
    const frames = data?.results?.A?.frames;

    if (!frames || frames.length === 0) {
      await sendMessage(chatId, '\u26a0\ufe0f \u041d\u0435\u043c\u0430\u0454 \u0434\u0430\u043d\u0438\u0445 \u0437\u0430 \u043e\u0441\u0442\u0430\u043d\u043d\u044e \u0433\u043e\u0434\u0438\u043d\u0443.');
      return;
    }

    const schema = frames[0].schema?.fields || [];
    const values = frames[0].data?.values || [];

    const fieldMap = {};
    schema.forEach((f, i) => {
      fieldMap[f.name] = values[i]?.[values[i].length - 1];
    });

    const soc = fieldMap['soc'];
    const voltage = fieldMap['voltage'];
    const current = fieldMap['current'];
    const temperature = fieldMap['temperature'];
    const power = fieldMap['power'];
    const state = fieldMap['state'];
    const time = fieldMap['_time'] || fieldMap['Time'];

    let socStatus = '\ud83d\udfe2 \u041d\u043e\u0440\u043c\u0430';
    if (soc !== null && soc !== undefined) {
      if (soc < 10) socStatus = '\ud83d\udd34 \u041a\u0420\u0418\u0422\u0418\u0427\u041d\u041e';
      else if (soc < 20) socStatus = '\ud83d\udfe0 \u041d\u0438\u0437\u044c\u043a\u0438\u0439';
      else if (soc < 50) socStatus = '\ud83d\udfe1 \u0421\u0435\u0440\u0435\u0434\u043d\u0456\u0439';
    }

    const timeStr = time ? new Date(typeof time === 'number' ? time : time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) : 'N/A';

    const msg = `\ud83d\udd0b <b>Deye SUN-15K — \u0421\u0442\u0430\u043d \u0431\u0430\u0442\u0430\u0440\u0435\u0457</b>

\u26a1 SOC: <b>${fmt(soc)}%</b> ${socStatus}
\ud83d\udd0c \u041d\u0430\u043f\u0440\u0443\u0433\u0430: <b>${fmt(voltage)}V</b>
\u26a1 \u0421\u0442\u0440\u0443\u043c: <b>${fmt(current)}A</b>
\ud83c\udf21 \u0422\u0435\u043c\u043f\u0435\u0440\u0430\u0442\u0443\u0440\u0430: <b>${fmt(temperature)}\u00b0C</b>
\ud83d\udca1 \u041f\u043e\u0442\u0443\u0436\u043d\u0456\u0441\u0442\u044c: <b>${fmt(power)}W</b>
\ud83d\udcca \u0421\u0442\u0430\u043d: <b>${state ?? 'N/A'}</b>

\ud83d\udd50 \u041e\u043d\u043e\u0432\u043b\u0435\u043d\u043e: ${timeStr}`;

    await sendMessage(chatId, msg);
  } catch (err) {
    console.error('/status error:', err);
    await sendMessage(chatId, `\u274c \u041f\u043e\u043c\u0438\u043b\u043a\u0430 \u043e\u0442\u0440\u0438\u043c\u0430\u043d\u043d\u044f \u0434\u0430\u043d\u0438\u0445: ${err.message}`);
  }
}

// --- /graph command ---
async function handleGraph(chatId) {
  try {
    const renderUrl = `${GRAFANA_URL}/render/d-solo/${DASHBOARD_UID}/deye-sun-15k-battery-monitor?orgId=1&panelId=6&width=800&height=400&from=now-24h&to=now`;

    const res = await fetch(renderUrl, {
      headers: { 'Authorization': `Bearer ${GRAFANA_SA_TOKEN}` }
    });

    if (!res.ok) {
      throw new Error(`Render failed: ${res.status}`);
    }

    const buffer = await res.arrayBuffer();
    const blob = Buffer.from(buffer);

    const FormData = (await import('node-fetch')).FormData;
    const { Blob: NodeBlob } = await import('buffer');

    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('caption', '\ud83d\udcca SOC \u0437\u0430 \u043e\u0441\u0442\u0430\u043d\u043d\u0456 24 \u0433\u043e\u0434\u0438\u043d\u0438');
    formData.append('photo', new NodeBlob([blob], { type: 'image/png' }), 'soc_graph.png');

    const tgRes = await fetch(`${TG_API}/sendPhoto`, {
      method: 'POST',
      body: formData
    });

    if (!tgRes.ok) {
      const dashLink = `${GRAFANA_URL}/d/${DASHBOARD_UID}/deye-sun-15k-battery-monitor`;
      await sendMessage(chatId, `\ud83d\udcca <a href="${dashLink}">\u0412\u0456\u0434\u043a\u0440\u0438\u0442\u0438 \u0434\u0430\u0448\u0431\u043e\u0440\u0434 Grafana</a>\n\n\u26a0\ufe0f \u0420\u0435\u043d\u0434\u0435\u0440\u0438\u043d\u0433 \u0433\u0440\u0430\u0444\u0456\u043a\u0443 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0438\u0439. \u041f\u0435\u0440\u0435\u0433\u043b\u044f\u043d\u044c\u0442\u0435 \u0434\u0430\u0448\u0431\u043e\u0440\u0434 \u0437\u0430 \u043f\u043e\u0441\u0438\u043b\u0430\u043d\u043d\u044f\u043c.`);
    }
  } catch (err) {
    console.error('/graph error:', err);
    const dashLink = `${GRAFANA_URL}/d/${DASHBOARD_UID}/deye-sun-15k-battery-monitor`;
    await sendMessage(chatId, `\ud83d\udcca <a href="${dashLink}">\u0412\u0456\u0434\u043a\u0440\u0438\u0442\u0438 \u0434\u0430\u0448\u0431\u043e\u0440\u0434 Grafana</a>\n\n\u26a0\ufe0f \u0413\u0440\u0430\u0444\u0456\u043a \u0442\u0438\u043c\u0447\u0430\u0441\u043e\u0432\u043e \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0438\u0439: ${err.message}`);
  }
}

// --- /help command ---
async function handleHelp(chatId) {
  const msg = `\ud83e\udd16 <b>Deye Battery Monitor Bot</b>

\u0414\u043e\u0441\u0442\u0443\u043f\u043d\u0456 \u043a\u043e\u043c\u0430\u043d\u0434\u0438:

/status — \ud83d\udd0b \u041f\u043e\u0442\u043e\u0447\u043d\u0438\u0439 \u0441\u0442\u0430\u043d \u0431\u0430\u0442\u0430\u0440\u0435\u0457
/graph — \ud83d\udcca \u0413\u0440\u0430\u0444\u0456\u043a SOC \u0437\u0430 24 \u0433\u043e\u0434\u0438\u043d\u0438
/help — \u2139\ufe0f \u0421\u043f\u0438\u0441\u043e\u043a \u043a\u043e\u043c\u0430\u043d\u0434

<i>\u0406\u043d\u0432\u0435\u0440\u0442\u043e\u0440: Deye SUN-15K-SG05LP3-EU-SM2
\u041c\u043e\u043d\u0456\u0442\u043e\u0440\u0438\u043d\u0433: InfluxDB Cloud + Grafana
\u0410\u043b\u0435\u0440\u0442: SOC &lt; 20% \u2192 \u0430\u0432\u0442\u043e\u043c\u0430\u0442\u0438\u0447\u043d\u0435 \u0441\u043f\u043e\u0432\u0456\u0449\u0435\u043d\u043d\u044f</i>`;

  await sendMessage(chatId, msg);
}

// --- Send Telegram message ---
async function sendMessage(chatId, text) {
  try {
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('sendMessage failed:', errText);
    }
  } catch (err) {
    console.error('sendMessage error:', err);
  }
}

// --- Poll for Telegram updates ---
async function pollUpdates() {
  try {
    const res = await fetch(`${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    if (!res.ok) return;

    const data = await res.json();
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const chatId = msg.chat.id;
      const text = msg.text.trim().toLowerCase();

      console.log(`Received: ${text} from ${msg.from?.first_name || 'unknown'}`);

      if (text === '/start' || text === '/help') {
        await handleHelp(chatId);
      } else if (text === '/status') {
        await handleStatus(chatId);
      } else if (text === '/graph') {
        await handleGraph(chatId);
      }
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

// --- Main loop ---
async function main() {
  console.log('\ud83e\udd16 Deye Battery Bot starting...');
  console.log(`\ud83d\udce1 Grafana: ${GRAFANA_URL}`);
  console.log(`\ud83d\udcac Telegram Chat: ${TG_CHAT_ID}`);

  // Validate config
  if (!TG_TOKEN || !GRAFANA_URL || !GRAFANA_SA_TOKEN || !GRAFANA_DS_UID) {
    console.error('\u274c Missing required environment variables!');
    console.error('Required: TELEGRAM_BOT_TOKEN, GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID');
    process.exit(1);
  }

  // Clear old updates
  try {
    await fetch(`${TG_API}/getUpdates?offset=-1`);
  } catch (e) {}

  console.log('\u2705 Bot is running! Polling for messages...');

  // Long polling loop
  while (true) {
    await pollUpdates();
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(console.error);

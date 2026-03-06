import fetch from 'node-fetch';
import http from 'http';

// --- Config from environment ---
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GRAFANA_URL = process.env.GRAFANA_URL;
const GRAFANA_SA_TOKEN = process.env.GRAFANA_SA_TOKEN;
const GRAFANA_DS_UID = process.env.GRAFANA_DS_UID;
const DASHBOARD_UID = process.env.GRAFANA_DASHBOARD_UID;
const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || 'monitoring';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000');
const PORT = process.env.PORT || 8080;

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
let lastUpdateId = 0;

// --- Health check HTTP server for Fly.io ---
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Health check server listening on port ${PORT}`);
});

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
      await sendMessage(chatId, '❌ Немає даних за останню годину');
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

    let socStatus = '🟢 Норма';
    if (soc !== null && soc !== undefined) {
      if (soc < 10) socStatus = '🔴 КРИТИЧНО';
      else if (soc < 20) socStatus = '🟠 Низький';
      else if (soc < 50) socStatus = '🟡 Середній';
    }

    const timeStr = time ? new Date(typeof time === 'number' ? time : time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) : 'N/A';

    const socBar = soc !== null && soc !== undefined ? (() => {
      const filled = Math.round(soc / 10);
      return '[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + ']';
    })() : '';

    const msg = `🔋 <b>Deye SUN-15K Battery Status</b>

🔋 SOC: <b>${fmt(soc, 0)}%</b> ${soc < 20 ? '⚠️ КРИТИЧНО!' : ''}
<code>${socBar}</code>

⚡ Напруга: <b>${fmt(voltage)} V</b>
⚡ Струм: <b>${fmt(current)} A</b>
⚡ Потужність: <b>${fmt(power)} W</b>
🌡️ Температура: <b>${fmt(temperature)} °C</b>
📊 Стан: <b>${state ?? 'N/A'}</b>

🟢 Оновлено: ${timeStr}
📊 <a href="${GRAFANA_URL}/d/${DASHBOARD_UID}">Відкрити дашборд</a>`;

    await sendMessage(chatId, msg);
  } catch (err) {
    console.error('/status error:', err);
    await sendMessage(chatId, `❌ Помилка отримання даних: ${err.message}`);
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

    const { FormData, Blob: FetchBlob } = await import('node-fetch');
    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('caption', '📊 SOC за останні 24 години');
    formData.append('photo', new FetchBlob([blob], { type: 'image/png' }), 'soc_graph.png');

    const tgRes = await fetch(`${TG_API}/sendPhoto`, {
      method: 'POST',
      body: formData
    });

    if (!tgRes.ok) {
      const dashLink = `${GRAFANA_URL}/d/${DASHBOARD_UID}/deye-sun-15k-battery-monitor`;
      await sendMessage(chatId, `📊 <a href="${dashLink}">Відкрити дашборд Grafana</a>\n\n⚠️ Рендеринг графіку недоступний. Перегляньте дашборд за посиланням.`);
    }
  } catch (err) {
    console.error('/graph error:', err);
    const dashLink = `${GRAFANA_URL}/d/${DASHBOARD_UID}/deye-sun-15k-battery-monitor`;
    await sendMessage(chatId, `📊 <a href="${dashLink}">Відкрити дашборд Grafana</a>\n\n⚠️ Графік тимчасово недоступний: ${err.message}`);
  }
}

// --- /help command ---
async function handleHelp(chatId) {
  const msg = `🤖 <b>Deye Battery Monitor Bot</b>

Доступні команди:

/status — 🔋 Поточний стан батареї
/graph — 📊 Графік SOC за 24 години
/help — ℹ️ Список команд

<i>Інвертор: Deye SUN-15K-SG05LP3-EU-SM2
Моніторинг: InfluxDB Cloud + Grafana
Алерт: SOC &lt; 20% → автоматичне сповіщення</i>`;

  await sendMessage(chatId, msg, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔋 Статус батареї', callback_data: '/status' }],
        [{ text: '📊 Графік SOC', callback_data: '/graph' }]
      ]
    }
  });
}

// --- Send Telegram message ---
async function sendMessage(chatId, text, options = {}) {
  try {
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        ...options
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

      // Handle callback queries (inline button presses)
      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message.chat.id;
        const command = cb.data;

        console.log(`Callback: ${command} from ${cb.from?.first_name || 'unknown'}`);

        if (command === '/status') {
          await handleStatus(chatId);
        } else if (command === '/graph') {
          await handleGraph(chatId);
        }

        // Answer callback to remove loading indicator
        await fetch(`${TG_API}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cb.id })
        });
        continue;
      }

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
  console.log('🤖 Deye Battery Bot starting...');
  console.log(`📡 Grafana: ${GRAFANA_URL}`);
  console.log(`💬 Telegram Chat: ${TG_CHAT_ID}`);

  // Validate config
  if (!TG_TOKEN || !GRAFANA_URL || !GRAFANA_SA_TOKEN || !GRAFANA_DS_UID) {
    console.error('❌ Missing required environment variables!');
    console.error('Required: TELEGRAM_BOT_TOKEN, GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID');
    process.exit(1);
  }

  // Clear old updates
  try {
    await fetch(`${TG_API}/getUpdates?offset=-1`);
  } catch (e) {}

  // Register bot menu commands
  await fetch(`${TG_API}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'status', description: '🔋 Поточний стан батареї' },
        { command: 'graph', description: '📊 Графік SOC за 24 години' },
        { command: 'help', description: 'ℹ️ Список команд' }
      ]
    })
  });

  console.log('✅ Bot is running! Polling for messages...');

  // Long polling loop
  while (true) {
    await pollUpdates();
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(console.error);

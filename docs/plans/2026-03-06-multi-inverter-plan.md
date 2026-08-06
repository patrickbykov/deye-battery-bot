# Multi-Inverter Subscriptions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add multi-inverter support with per-user subscriptions, auto-discovery, admin role, and SOC alerts.

**Architecture:** SQLite stores inverters/subscriptions/alert state. Auto-discovery polls InfluxDB for new inverter tags. All existing commands become subscription-aware. Background alert loop monitors SOC.

**Tech Stack:** Node.js ESM, better-sqlite3, node-fetch, Fly.io with volume mount.

---

### Task 1: Add better-sqlite3 dependency and data directory

**Files:**
- Modify: `package.json`
- Modify: `fly.toml`
- Modify: `Dockerfile`
- Create: `data/.gitkeep`

**Step 1: Install better-sqlite3**

Run: `npm install better-sqlite3`

**Step 2: Add volume mount to fly.toml**

Add after `[[vm]]` block in `fly.toml`:

```toml
[mounts]
  source = "bot_data"
  destination = "/app/data"
```

**Step 3: Update Dockerfile for native module build**

Replace Dockerfile content:

```dockerfile
FROM node:18-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY . .

CMD ["node", "index.js"]
```

**Step 4: Create data directory**

Run: `mkdir -p data && touch data/.gitkeep`

**Step 5: Commit**

```bash
git add package.json package-lock.json fly.toml Dockerfile data/.gitkeep
git commit -m "feat: add better-sqlite3, volume mount, native build deps"
```

---

### Task 2: Create db.js — SQLite initialization and CRUD

**Files:**
- Create: `db.js`

**Step 1: Create db.js with schema init and all CRUD functions**

```js
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'bot.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS inverters (
    id TEXT PRIMARY KEY,
    name TEXT,
    dashboard_uid TEXT,
    panel_id INTEGER DEFAULT 6,
    discovered_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    chat_id INTEGER NOT NULL,
    inverter_id TEXT NOT NULL REFERENCES inverters(id) ON DELETE CASCADE,
    subscribed_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, inverter_id)
  );

  CREATE TABLE IF NOT EXISTS alert_state (
    inverter_id TEXT NOT NULL REFERENCES inverters(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL,
    active INTEGER DEFAULT 0,
    last_triggered_at TEXT,
    PRIMARY KEY (inverter_id, alert_type)
  );
`);

// --- Inverters ---

export function getAllInverters() {
  return db.prepare('SELECT * FROM inverters ORDER BY id').all();
}

export function getInverter(id) {
  return db.prepare('SELECT * FROM inverters WHERE id = ?').get(id);
}

export function upsertInverter(id, name = null, dashboardUid = null, panelId = 6) {
  return db.prepare(`
    INSERT INTO inverters (id, name, dashboard_uid, panel_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(id, name || id, dashboardUid, panelId);
}

export function removeInverter(id) {
  return db.prepare('DELETE FROM inverters WHERE id = ?').run(id);
}

// --- Subscriptions ---

export function subscribe(chatId, inverterId) {
  return db.prepare(`
    INSERT OR IGNORE INTO subscriptions (chat_id, inverter_id)
    VALUES (?, ?)
  `).run(chatId, inverterId);
}

export function unsubscribe(chatId, inverterId) {
  return db.prepare(
    'DELETE FROM subscriptions WHERE chat_id = ? AND inverter_id = ?'
  ).run(chatId, inverterId);
}

export function getSubscriptions(chatId) {
  return db.prepare(
    'SELECT inverter_id FROM subscriptions WHERE chat_id = ?'
  ).all(chatId).map(r => r.inverter_id);
}

export function getSubscribers(inverterId) {
  return db.prepare(
    'SELECT chat_id FROM subscriptions WHERE inverter_id = ?'
  ).all(inverterId).map(r => r.chat_id);
}

export function getAllSubscriptions() {
  return db.prepare(`
    SELECT s.chat_id, s.inverter_id, i.name
    FROM subscriptions s JOIN inverters i ON s.inverter_id = i.id
    ORDER BY s.chat_id, s.inverter_id
  `).all();
}

// --- Alert State ---

export function getAlertState(inverterId, alertType) {
  return db.prepare(
    'SELECT * FROM alert_state WHERE inverter_id = ? AND alert_type = ?'
  ).get(inverterId, alertType);
}

export function setAlertActive(inverterId, alertType) {
  db.prepare(`
    INSERT INTO alert_state (inverter_id, alert_type, active, last_triggered_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(inverter_id, alert_type)
    DO UPDATE SET active = 1, last_triggered_at = datetime('now')
  `).run(inverterId, alertType);
}

export function clearAlert(inverterId, alertType) {
  db.prepare(`
    UPDATE alert_state SET active = 0 WHERE inverter_id = ? AND alert_type = ?
  `).run(inverterId, alertType);
}

export default db;
```

**Step 2: Verify it loads without errors**

Run: `node -e "import('./db.js').then(() => console.log('OK'))"`
Expected: `OK` and `data/bot.db` file created.

**Step 3: Commit**

```bash
git add db.js
git commit -m "feat: add SQLite database layer with inverters, subscriptions, alerts"
```

---

### Task 3: Update config.js — add ADMIN_CHAT_ID

**Files:**
- Modify: `config.js`

**Step 1: Add ADMIN_CHAT_ID and remove hardcoded DASHBOARD_LINK**

In `config.js`, add after `PORT` line:

```js
export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;
```

Remove the `DASHBOARD_LINK` line (it will be built per-inverter now).

**Step 2: Commit**

```bash
git add config.js
git commit -m "feat: add ADMIN_CHAT_ID config, remove hardcoded dashboard link"
```

---

### Task 4: Update grafana.js — parameterize by inverter

**Files:**
- Modify: `grafana.js`

**Step 1: Update renderGrafanaPanel to accept inverter object**

Replace `renderGrafanaPanel` function:

```js
export async function renderGrafanaPanel(inverter) {
  const dashUid = inverter.dashboard_uid || DASHBOARD_UID;
  const panelId = inverter.panel_id || 6;
  const renderUrl = `${GRAFANA_URL}/render/d-solo/${dashUid}/?orgId=1&panelId=${panelId}&width=800&height=400&from=now-24h&to=now&var-inverter=${encodeURIComponent(inverter.id)}`;
  const res = await fetch(renderUrl, {
    headers: { 'Authorization': `Bearer ${GRAFANA_SA_TOKEN}` }
  });

  if (!res.ok) throw new Error(`Render failed: ${res.status}`);

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}
```

**Step 2: Add helper to build dashboard link**

Add at bottom of `grafana.js`:

```js
export function getDashboardLink(inverter) {
  const dashUid = inverter.dashboard_uid || DASHBOARD_UID;
  return `${GRAFANA_URL}/d/${dashUid}`;
}
```

**Step 3: Commit**

```bash
git add grafana.js
git commit -m "feat: parameterize Grafana queries by inverter"
```

---

### Task 5: Create discovery.js — auto-discovery loop

**Files:**
- Create: `discovery.js`

**Step 1: Create discovery.js**

```js
import { INFLUXDB_BUCKET, ADMIN_CHAT_ID } from './config.js';
import { queryGrafana } from './grafana.js';
import { getAllInverters, upsertInverter } from './db.js';
import { sendMessage } from './telegram.js';

const DISCOVERY_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function discoverInverters() {
  try {
    const flux = `import "influxdata/influxdb/schema"
schema.tagValues(bucket: "${INFLUXDB_BUCKET}", tag: "inverter")`;

    const data = await queryGrafana(flux);
    const frames = data?.results?.A?.frames;
    if (!frames || frames.length === 0) return;

    const values = frames[0].data?.values?.[0] || [];
    const existing = new Set(getAllInverters().map(i => i.id));

    for (const inverterId of values) {
      if (!existing.has(inverterId)) {
        upsertInverter(inverterId);
        console.log(`Discovered new inverter: ${inverterId}`);
        if (ADMIN_CHAT_ID) {
          await sendMessage(ADMIN_CHAT_ID,
            `🔍 Знайдено новий інвертор: <b>${inverterId}</b>\nВін доступний для підписки через /subscribe ${inverterId}`
          );
        }
      }
    }
  } catch (err) {
    console.error('Discovery error:', err);
  }
}

export function startDiscovery() {
  discoverInverters();
  setInterval(discoverInverters, DISCOVERY_INTERVAL);
}
```

**Step 2: Commit**

```bash
git add discovery.js
git commit -m "feat: add auto-discovery of inverters from InfluxDB"
```

---

### Task 6: Create alerts.js — background SOC monitoring

**Files:**
- Create: `alerts.js`

**Step 1: Create alerts.js**

```js
import { INFLUXDB_BUCKET } from './config.js';
import { queryGrafana } from './grafana.js';
import { getAllInverters, getSubscribers, getAlertState, setAlertActive, clearAlert } from './db.js';
import { sendMessage } from './telegram.js';
import { fmt } from './helpers.js';

const ALERT_INTERVAL = 60 * 1000; // 60 seconds
const SOC_THRESHOLD = 20;

async function checkAlerts() {
  const inverters = getAllInverters();

  for (const inverter of inverters) {
    try {
      const flux = `from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -10m)
  |> filter(fn: (r) => r._measurement == "battery")
  |> filter(fn: (r) => r.inverter == "${inverter.id}")
  |> filter(fn: (r) => r._field == "soc")
  |> last()`;

      const data = await queryGrafana(flux);
      const frames = data?.results?.A?.frames;
      if (!frames || frames.length === 0) continue;

      const values = frames[0].data?.values;
      const soc = values?.[1]?.[values[1].length - 1];
      if (soc === null || soc === undefined) continue;

      const alertState = getAlertState(inverter.id, 'soc_low');
      const subscribers = getSubscribers(inverter.id);
      if (subscribers.length === 0) continue;

      if (soc < SOC_THRESHOLD && (!alertState || !alertState.active)) {
        setAlertActive(inverter.id, 'soc_low');
        const msg = `🔴 <b>АЛЕРТ: Низький заряд!</b>\n\n🏭 Інвертор: <b>${inverter.name || inverter.id}</b>\n🔋 SOC: <b>${fmt(soc, 0)}%</b>\n\n⚠️ Рівень заряду нижче ${SOC_THRESHOLD}%!`;
        for (const chatId of subscribers) {
          await sendMessage(chatId, msg);
        }
      } else if (soc >= SOC_THRESHOLD && alertState?.active) {
        clearAlert(inverter.id, 'soc_low');
        const msg = `🟢 <b>Заряд відновлено</b>\n\n🏭 Інвертор: <b>${inverter.name || inverter.id}</b>\n🔋 SOC: <b>${fmt(soc, 0)}%</b>\n\n✅ Рівень заряду повернувся вище ${SOC_THRESHOLD}%.`;
        for (const chatId of subscribers) {
          await sendMessage(chatId, msg);
        }
      }
    } catch (err) {
      console.error(`Alert check error for ${inverter.id}:`, err);
    }
  }
}

export function startAlerts() {
  checkAlerts();
  setInterval(checkAlerts, ALERT_INTERVAL);
}
```

**Step 2: Commit**

```bash
git add alerts.js
git commit -m "feat: add background SOC alert monitoring with deduplication"
```

---

### Task 7: Rewrite commands.js — subscription-aware commands + admin

**Files:**
- Modify: `commands.js`

**Step 1: Rewrite commands.js entirely**

```js
import fetch from 'node-fetch';
import { TG_API, INFLUXDB_BUCKET, DASHBOARD_UID, ADMIN_CHAT_ID } from './config.js';
import { fmt, renderSocBar, formatKyivTime, parseGrafanaFields } from './helpers.js';
import { sendMessage } from './telegram.js';
import { queryGrafana, renderGrafanaPanel, getDashboardLink } from './grafana.js';
import {
  getAllInverters, getInverter,
  subscribe, unsubscribe, getSubscriptions, getAllSubscriptions
} from './db.js';

// --- /status: show status for all subscribed inverters ---

async function handleStatus(chatId) {
  const subs = getSubscriptions(chatId);
  if (subs.length === 0) {
    await sendMessage(chatId, '⚠️ Ви не підписані на жоден інвертор.\nВикористайте /list для перегляду доступних та /subscribe <id> для підписки.');
    return;
  }

  for (const inverterId of subs) {
    const inverter = getInverter(inverterId);
    if (!inverter) continue;

    try {
      const flux = `from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "battery")
  |> filter(fn: (r) => r.inverter == "${inverter.id}")
  |> last()
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;

      const data = await queryGrafana(flux);
      const frames = data?.results?.A?.frames;

      if (!frames || frames.length === 0) {
        await sendMessage(chatId, `❌ <b>${inverter.name || inverter.id}</b>: немає даних за останню годину`);
        continue;
      }

      const f = parseGrafanaFields(frames);
      const timeStr = formatKyivTime(f['_time'] || f['Time']);
      const dashLink = getDashboardLink(inverter);

      const msg = `🔋 <b>${inverter.name || inverter.id}</b>

🔋 SOC: <b>${fmt(f.soc, 0)}%</b> ${f.soc < 20 ? '⚠️ КРИТИЧНО!' : ''}
<code>${renderSocBar(f.soc)}</code>

⚡ Напруга: <b>${fmt(f.voltage)} V</b>
⚡ Струм: <b>${fmt(f.current)} A</b>
⚡ Потужність: <b>${fmt(f.power)} W</b>
🌡️ Температура: <b>${fmt(f.temperature)} °C</b>
📊 Стан: <b>${f.state ?? 'N/A'}</b>

🟢 Оновлено: ${timeStr}
📊 <a href="${dashLink}">Відкрити дашборд</a>`;

      await sendMessage(chatId, msg);
    } catch (err) {
      console.error(`/status error for ${inverter.id}:`, err);
      await sendMessage(chatId, `❌ <b>${inverter.name || inverter.id}</b>: ${err.message}`);
    }
  }
}

// --- /graph: send graph for all subscribed inverters ---

async function handleGraph(chatId) {
  const subs = getSubscriptions(chatId);
  if (subs.length === 0) {
    await sendMessage(chatId, '⚠️ Ви не підписані на жоден інвертор.\nВикористайте /list для перегляду доступних та /subscribe <id> для підписки.');
    return;
  }

  for (const inverterId of subs) {
    const inverter = getInverter(inverterId);
    if (!inverter) continue;

    try {
      const imageBuffer = await renderGrafanaPanel(inverter);

      const { FormData, Blob: FetchBlob } = await import('node-fetch');
      const formData = new FormData();
      formData.append('chat_id', chatId.toString());
      formData.append('caption', `📊 ${inverter.name || inverter.id} — SOC за 24 години`);
      formData.append('photo', new FetchBlob([imageBuffer], { type: 'image/png' }), 'soc_graph.png');

      const tgRes = await fetch(`${TG_API}/sendPhoto`, {
        method: 'POST',
        body: formData
      });

      if (!tgRes.ok) {
        const dashLink = getDashboardLink(inverter);
        await sendMessage(chatId, `📊 <a href="${dashLink}">${inverter.name || inverter.id} — дашборд</a>\n\n⚠️ Рендеринг графіку недоступний.`);
      }
    } catch (err) {
      console.error(`/graph error for ${inverter.id}:`, err);
      const dashLink = getDashboardLink(inverter);
      await sendMessage(chatId, `📊 <a href="${dashLink}">${inverter.name || inverter.id} — дашборд</a>\n\n⚠️ Графік недоступний: ${err.message}`);
    }
  }
}

// --- /list: show all available inverters ---

async function handleList(chatId) {
  const inverters = getAllInverters();
  if (inverters.length === 0) {
    await sendMessage(chatId, '📭 Інверторів поки немає. Вони з\'являться автоматично при виявленні.');
    return;
  }

  const subs = new Set(getSubscriptions(chatId));
  const lines = inverters.map(inv => {
    const marker = subs.has(inv.id) ? '✅' : '⬜';
    return `${marker} <code>${inv.id}</code> — ${inv.name || inv.id}`;
  });

  const msg = `📋 <b>Доступні інвертори:</b>\n\n${lines.join('\n')}\n\n✅ = підписка активна\nПідписатись: /subscribe <code>id</code>\nВідписатись: /unsubscribe <code>id</code>`;
  await sendMessage(chatId, msg);
}

// --- /mysubs: show user's subscriptions ---

async function handleMySubs(chatId) {
  const subs = getSubscriptions(chatId);
  if (subs.length === 0) {
    await sendMessage(chatId, '📭 Ви не підписані на жоден інвертор.\nВикористайте /list для перегляду доступних.');
    return;
  }

  const lines = subs.map(id => {
    const inv = getInverter(id);
    return `🔋 <code>${id}</code> — ${inv?.name || id}`;
  });

  await sendMessage(chatId, `📋 <b>Ваші підписки:</b>\n\n${lines.join('\n')}\n\nВідписатись: /unsubscribe <code>id</code>`);
}

// --- /help ---

async function handleHelp(chatId) {
  const msg = `🤖 <b>Deye Battery Monitor Bot</b>

<b>Підписки:</b>
/list — 📋 Всі доступні інвертори
/subscribe <code>id</code> — ✅ Підписатись на інвертор
/unsubscribe <code>id</code> — ❌ Відписатись
/mysubs — 📋 Мої підписки

<b>Моніторинг:</b>
/status — 🔋 Стан підписаних інверторів
/graph — 📊 Графіки SOC за 24 години
/help — ℹ️ Список команд

<i>Моніторинг: InfluxDB Cloud + Grafana
Алерт: SOC &lt; 20% → автоматичне сповіщення</i>`;

  await sendMessage(chatId, msg, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Інвертори', callback_data: '/list' }],
        [{ text: '🔋 Статус', callback_data: '/status' }, { text: '📊 Графік', callback_data: '/graph' }],
        [{ text: '📋 Мої підписки', callback_data: '/mysubs' }]
      ]
    }
  });
}

// --- Admin commands ---

async function handleRemoveInverter(chatId, args) {
  if (chatId !== ADMIN_CHAT_ID) return;
  const inverterId = args.trim();
  if (!inverterId) {
    await sendMessage(chatId, '⚠️ Використання: /remove_inverter <code>id</code>');
    return;
  }
  const inv = getInverter(inverterId);
  if (!inv) {
    await sendMessage(chatId, `❌ Інвертор <code>${inverterId}</code> не знайдено.`);
    return;
  }
  const { changes } = require('./db.js').removeInverter ? removeInverter(inverterId) : { changes: 0 };
  // Inline removal:
  const result = (await import('./db.js')).removeInverter(inverterId);
  await sendMessage(chatId, `🗑️ Інвертор <code>${inverterId}</code> видалено (підписки каскадно видалені).`);
}

async function handleUsers(chatId) {
  if (chatId !== ADMIN_CHAT_ID) return;
  const allSubs = getAllSubscriptions();
  if (allSubs.length === 0) {
    await sendMessage(chatId, '📭 Підписок немає.');
    return;
  }

  const grouped = {};
  for (const s of allSubs) {
    if (!grouped[s.chat_id]) grouped[s.chat_id] = [];
    grouped[s.chat_id].push(s.name || s.inverter_id);
  }

  const lines = Object.entries(grouped).map(
    ([chatId, invs]) => `👤 <code>${chatId}</code>: ${invs.join(', ')}`
  );

  await sendMessage(chatId, `👥 <b>Користувачі та підписки:</b>\n\n${lines.join('\n')}`);
}

// --- Command routing ---

// Commands that take arguments (text after command)
function parseCommand(text) {
  const match = text.match(/^(\/\w+)(?:\s+(.+))?$/);
  if (!match) return { cmd: text, args: '' };
  return { cmd: match[1], args: match[2] || '' };
}

async function handleSubscribe(chatId, args) {
  const inverterId = args.trim();
  if (!inverterId) {
    await sendMessage(chatId, '⚠️ Використання: /subscribe <code>id</code>\nПерегляньте доступні: /list');
    return;
  }
  const inv = getInverter(inverterId);
  if (!inv) {
    await sendMessage(chatId, `❌ Інвертор <code>${inverterId}</code> не знайдено.\nПерегляньте доступні: /list`);
    return;
  }
  subscribe(chatId, inverterId);
  await sendMessage(chatId, `✅ Підписка на <b>${inv.name || inv.id}</b> активована!`);
}

async function handleUnsubscribe(chatId, args) {
  const inverterId = args.trim();
  if (!inverterId) {
    await sendMessage(chatId, '⚠️ Використання: /unsubscribe <code>id</code>\nПерегляньте підписки: /mysubs');
    return;
  }
  const result = unsubscribe(chatId, inverterId);
  if (result.changes === 0) {
    await sendMessage(chatId, `⚠️ Ви не були підписані на <code>${inverterId}</code>.`);
  } else {
    await sendMessage(chatId, `❌ Підписку на <code>${inverterId}</code> скасовано.`);
  }
}

// Simple commands (no args)
const simpleCommands = {
  '/start': handleHelp,
  '/help': handleHelp,
  '/status': handleStatus,
  '/graph': handleGraph,
  '/list': handleList,
  '/mysubs': handleMySubs,
};

// Commands with arguments
const argCommands = {
  '/subscribe': handleSubscribe,
  '/unsubscribe': handleUnsubscribe,
  '/remove_inverter': handleRemoveInverter,
  '/users': handleUsers,
};

export { simpleCommands, argCommands, parseCommand };
```

**Step 2: Commit**

```bash
git add commands.js
git commit -m "feat: rewrite commands for multi-inverter subscriptions and admin"
```

---

### Task 8: Update index.js — new routing, start discovery + alerts

**Files:**
- Modify: `index.js`

**Step 1: Rewrite index.js**

```js
import fetch from 'node-fetch';
import http from 'http';
import { TG_TOKEN, TG_CHAT_ID, GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID, TG_API, PORT } from './config.js';
import { answerCallbackQuery } from './telegram.js';
import { simpleCommands, argCommands, parseCommand } from './commands.js';
import { startDiscovery } from './discovery.js';
import { startAlerts } from './alerts.js';
import './db.js'; // ensure DB is initialized

let lastUpdateId = 0;

async function processUpdate(update) {
  if (update.callback_query) {
    const { message, data, id, from } = update.callback_query;
    console.log(`Callback: ${data} from ${from?.first_name || 'unknown'}`);

    const handler = simpleCommands[data];
    if (handler) await handler(message.chat.id);
    await answerCallbackQuery(id);
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;

  const text = msg.text.trim();
  const chatId = msg.chat.id;
  console.log(`Received: ${text} from ${msg.from?.first_name || 'unknown'}`);

  const { cmd, args } = parseCommand(text.toLowerCase());

  if (simpleCommands[cmd] && !args) {
    await simpleCommands[cmd](chatId);
  } else if (argCommands[cmd]) {
    await argCommands[cmd](chatId, args);
  }
}

async function pollUpdates() {
  try {
    const res = await fetch(`${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    if (!res.ok) return;

    const data = await res.json();
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      await processUpdate(update);
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

// Health check
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Health check server listening on port ${PORT}`);
});

async function main() {
  console.log('Deye Battery Bot starting...');
  console.log(`Grafana: ${GRAFANA_URL}`);
  console.log(`Telegram Chat: ${TG_CHAT_ID}`);

  if (!TG_TOKEN || !GRAFANA_URL || !GRAFANA_SA_TOKEN || !GRAFANA_DS_UID) {
    console.error('Missing required environment variables!');
    console.error('Required: TELEGRAM_BOT_TOKEN, GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID');
    process.exit(1);
  }

  try {
    await fetch(`${TG_API}/getUpdates?offset=-1`);
  } catch (e) {}

  await fetch(`${TG_API}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'status', description: '🔋 Стан підписаних інверторів' },
        { command: 'graph', description: '📊 Графіки SOC за 24 години' },
        { command: 'list', description: '📋 Доступні інвертори' },
        { command: 'subscribe', description: '✅ Підписатись на інвертор' },
        { command: 'unsubscribe', description: '❌ Відписатись від інвертора' },
        { command: 'mysubs', description: '📋 Мої підписки' },
        { command: 'help', description: 'ℹ️ Список команд' }
      ]
    })
  });

  // Start background tasks
  startDiscovery();
  startAlerts();

  console.log('Bot is running! Polling for messages...');

  while (true) {
    await pollUpdates();
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(console.error);
```

**Step 2: Verify syntax**

Run: `node --check index.js && node --check commands.js && node --check discovery.js && node --check alerts.js && node --check db.js`

**Step 3: Commit**

```bash
git add index.js
git commit -m "feat: update main loop with new routing, discovery and alerts"
```

---

### Task 9: Fix handleRemoveInverter bug and final cleanup

**Files:**
- Modify: `commands.js`

**Step 1: Fix the broken handleRemoveInverter function**

The `handleRemoveInverter` in Task 7 has a bug (leftover require + double import). Replace it with:

```js
async function handleRemoveInverter(chatId, args) {
  if (chatId !== ADMIN_CHAT_ID) return;
  const inverterId = args.trim();
  if (!inverterId) {
    await sendMessage(chatId, '⚠️ Використання: /remove_inverter <code>id</code>');
    return;
  }
  const inv = getInverter(inverterId);
  if (!inv) {
    await sendMessage(chatId, `❌ Інвертор <code>${inverterId}</code> не знайдено.`);
    return;
  }
  removeInverter(inverterId);
  await sendMessage(chatId, `🗑️ Інвертор <code>${inverterId}</code> видалено (підписки каскадно видалені).`);
}
```

Also add `removeInverter` to the import from `./db.js` at the top:

```js
import {
  getAllInverters, getInverter, removeInverter,
  subscribe, unsubscribe, getSubscriptions, getAllSubscriptions
} from './db.js';
```

**Step 2: Run syntax check on all files**

Run: `node --check config.js && node --check db.js && node --check helpers.js && node --check telegram.js && node --check grafana.js && node --check commands.js && node --check discovery.js && node --check alerts.js && node --check index.js`

Expected: All pass, no errors.

**Step 3: Commit**

```bash
git add commands.js
git commit -m "fix: fix handleRemoveInverter, add missing import"
```

---

### Task 10: Update package.json description and .gitignore

**Files:**
- Modify: `package.json`

**Step 1: Update description**

Change `description` to: `"Telegram bot for multi-inverter battery monitoring via Grafana & InfluxDB"`

**Step 2: Add data/bot.db to .gitignore**

Create or update `.gitignore`:

```
node_modules/
data/*.db
data/*.db-wal
data/*.db-shm
.env
```

**Step 3: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: update description, add gitignore for SQLite"
```
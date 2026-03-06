import fetch from 'node-fetch';
import http from 'http';
import { TG_TOKEN, TG_CHAT_ID, GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID, TG_API, PORT } from './config.js';
import { answerCallbackQuery } from './telegram.js';
import { commands } from './commands.js';

let lastUpdateId = 0;

// --- Polling ---

async function processUpdate(update) {
  if (update.callback_query) {
    const { message, data, id, from } = update.callback_query;
    console.log(`Callback: ${data} from ${from?.first_name || 'unknown'}`);

    const handler = commands[data];
    if (handler) await handler(message.chat.id);
    await answerCallbackQuery(id);
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;

  const text = msg.text.trim().toLowerCase();
  console.log(`Received: ${text} from ${msg.from?.first_name || 'unknown'}`);

  const handler = commands[text];
  if (handler) await handler(msg.chat.id);
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

// --- Health check server ---

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Health check server listening on port ${PORT}`);
});

// --- Main ---

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
        { command: 'status', description: '🔋 Поточний стан батареї' },
        { command: 'graph', description: '📊 Графік SOC за 24 години' },
        { command: 'help', description: 'ℹ️ Список команд' }
      ]
    })
  });

  console.log('Bot is running! Polling for messages...');

  while (true) {
    await pollUpdates();
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(console.error);

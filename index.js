import fetch from 'node-fetch';
import http from 'http';
import { TG_TOKEN, TG_CHAT_ID, GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID, DASHBOARD_UID, DEFAULT_INVERTER_ID, TG_API, PORT } from './config.js';
import { answerCallbackQuery } from './telegram.js';
import { commands } from './commands.js';
import { healthStatus } from './health.js';
import { redact } from './helpers.js';

let lastUpdateId = 0;
let lastPollSuccessAt = null;

// Long-poll триває 30 с, тож таймаут має бути більшим — інакше рвали б
// власні здорові запити. Але він мусить бути: без нього зависла TCP-сесія
// блокує однопотоковий цикл назавжди, і це головний підозрюваний у тому,
// чому бот замовк 6 березня.
const POLL_TIMEOUT_MS = 45_000;

// Здоровий цикл торкається лічильника щонайменше раз на ~31 с.
const STALENESS_LIMIT_MS = 180_000;

// Поріг вотчдога свідомо більший за health: 503 робить збій видимим, але
// сам нічого не лікує — Fly перезапускає машину на вихід процесу, а не на
// провалену перевірку. Тож якщо цикл стоїть 10 хвилин, виходимо самі.
const WATCHDOG_LIMIT_MS = 600_000;

// --- Polling ---

async function processUpdate(update) {
  if (update.callback_query) {
    const { message, data, id } = update.callback_query;
    console.log(`Callback ${data} from chat ${message.chat.id}`);

    const handler = commands[data];
    if (handler) await handler(message.chat.id);
    await answerCallbackQuery(id);
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;

  const text = msg.text.trim().toLowerCase();
  const handler = commands[text];

  // Логуємо лише розпізнану команду й chat id. Текст повідомлень і імена
  // користувачів у логи Fly не пишемо — почистити їх потім не можна.
  console.log(`Command ${handler ? text : '(unknown)'} from chat ${msg.chat.id}`);

  if (handler) await handler(msg.chat.id);
}

async function pollUpdates() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${TG_API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`,
      { signal: controller.signal }
    );

    if (!res.ok) {
      // Мовчазний `return` тут ховав би 409 Conflict (два інстанси на одному
      // токені) і 401 — бот виглядав би живим, не обробляючи нічого.
      console.error(`getUpdates: HTTP ${res.status}`);
      return;
    }

    const data = await res.json();
    if (!data.ok || !data.result) {
      console.error(`getUpdates: ${redact(JSON.stringify(data).slice(0, 200))}`);
      return;
    }

    // Успішний обмін з Telegram — саме це означає «цикл живий».
    lastPollSuccessAt = Date.now();

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      await processUpdate(update);
    }
  } catch (err) {
    console.error('Poll error:', redact(err.message));
  } finally {
    clearTimeout(timer);
  }
}

// --- Health check ---

http.createServer((req, res) => {
  const { healthy, ageMs } = healthStatus(lastPollSuccessAt, STALENESS_LIMIT_MS, Date.now());

  res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'text/plain' });
  res.end(healthy
    ? `OK (останній полінг ${Math.round(ageMs / 1000)}с тому)`
    : `STALE (${ageMs === null ? 'полінгу ще не було' : Math.round(ageMs / 1000) + 'с без відповіді Telegram'})`);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Health check server listening on port ${PORT}`);
});

// --- Main ---

async function main() {
  console.log('Deye Battery Bot starting...');
  console.log(`Grafana: ${GRAFANA_URL}`);
  console.log(`Chat: ${TG_CHAT_ID ?? '(не задано)'}, інвертор: ${DEFAULT_INVERTER_ID}`);

  const missing = Object.entries({
    TELEGRAM_BOT_TOKEN: TG_TOKEN,
    GRAFANA_URL,
    GRAFANA_SA_TOKEN,
    GRAFANA_DS_UID,
    // Без нього в render-URL і в посиланні на дашборд піде літеральне `undefined`.
    GRAFANA_DASHBOARD_UID: DASHBOARD_UID,
    // Мусить збігатися з тегом `inverter`, який пише колектор, інакше
    // /status мовчки не знайде даних.
    DEFAULT_INVERTER_ID,
  }).filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    console.error(`Не задані обов'язкові змінні: ${missing.join(', ')}`);
    process.exit(1);
  }

  try {
    await fetch(`${TG_API}/getUpdates?offset=-1`);
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
  } catch (err) {
    // Раніше виняток тут виносило в main().catch(), polling не стартував,
    // а HTTP-сервер тримав процес живим і далі рапортував 200.
    console.error('Стартова ініціалізація не вдалась:', redact(err.message));
  }

  console.log('Bot is running! Polling for messages...');

  lastPollSuccessAt = Date.now();
  setInterval(() => {
    const { healthy, ageMs } = healthStatus(lastPollSuccessAt, WATCHDOG_LIMIT_MS, Date.now());
    if (!healthy) {
      console.error(`Watchdog: полінг стоїть ${Math.round(ageMs / 1000)}с, виходжу для рестарту`);
      process.exit(1);
    }
  }, 60_000).unref();

  while (true) {
    await pollUpdates();
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(err => {
  console.error('Fatal:', redact(err.message));
  process.exit(1);
});

import fetch from 'node-fetch';
import { TG_TOKEN, TG_CHAT_ID, GRAFANA_URL, GRAFANA_SA_TOKEN, GRAFANA_DS_UID, DASHBOARD_UID, DEFAULT_INVERTER_ID, INFLUXDB_BUCKET, ADMIN_CHAT_ID, GRAFANA_WEBHOOK_TOKEN, ADMIN_PASSWORD_HASH, TG_API, PORT } from './config.js';
import { answerCallbackQuery, sendMessage, sendPhoto, sendAlert, sendDocument, editMessageReplyMarkup, editMessageText } from './telegram.js';
import { parseCommand, createCommands, createCallbacks } from './commands.js';
import { parseCallback } from './subs-keyboard.js';
import { webhookAuthorized, parseGrafanaWebhook } from './webhook-grafana.js';
import { createAlertQueue } from './alerts-queue.js';
import { createAdminRoutes } from './admin-routes.js';
import { createBackup, BACKUP_INTERVAL_MS } from './backup.js';
import path from 'node:path';
import { healthStatus } from './health.js';
import { redact } from './helpers.js';
import { createHttpServer, readBody } from './http-server.js';
import { createDb, DEFAULT_DB_PATH } from './db.js';
import { createDiscovery, DISCOVERY_INTERVAL_MS } from './discovery.js';
import { queryGrafana, renderGrafanaPanel, getDashboardLink } from './grafana.js';

const store = createDb(DEFAULT_DB_PATH);

const commands = createCommands({
  store,
  telegram: { sendMessage, sendPhoto },
  grafana: { queryGrafana, renderGrafanaPanel, getDashboardLink },
  log: console,
});

const notifyAdmin = (msg, options) => (ADMIN_CHAT_ID ? sendMessage(ADMIN_CHAT_ID, msg, options) : Promise.resolve());

const callbacks = createCallbacks({
  store,
  telegram: { editMessageReplyMarkup, editMessageText, answerCallbackQuery, sendMessage },
  notifyAdmin,
  log: console,
  adminChatId: ADMIN_CHAT_ID,
});

const alertQueue = createAlertQueue({
  store,
  send: sendAlert,
  log: console,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  adminChatId: ADMIN_CHAT_ID,
});

// Адмінські команди — окрема мапа. Не-адміну вони відповідають так само, як
// невідома команда: повідомлення «доступ заборонено» лише підтверджує, що
// команда існує.
const adminCommands = new Map([
  ['/remove_inverter', async ({ chatId, arg }) => {
    if (!arg || !store.getInverter(arg)) {
      await sendMessage(chatId, `❌ Об’єкт <code>${arg ?? ''}</code> не знайдено.`);
      return;
    }
    store.removeInverter(arg);
    await sendMessage(chatId, `🗑 Об’єкт ${arg} видалено разом з підписками на нього.`);
  }],
  ['/export', async ({ chatId }) => {
    // Telegram як позасмугове сховище бекапів: волюм прив'язаний до одного
    // хоста, і його втрата означає, що всі знову pending.
    const dump = Buffer.from(JSON.stringify(store.exportAll(), null, 2));
    await sendDocument(chatId, dump, `deye-backup-${new Date().toISOString().slice(0, 10)}.json`,
      '💾 Дамп користувачів, підписок і об’єктів');
  }],
  ['/users', async ({ chatId }) => {
    const users = store.listUsersWithSubscriptions();
    await sendMessage(chatId, users.length === 0
      ? 'Користувачів ще немає.'
      : users.map(u =>
          `${u.username ? '@' + u.username : u.first_name ?? u.chat_id} — ${u.status}\n` +
          `  ${u.inverters.map(i => i.id).join(', ') || '—'}`).join('\n'));
  }],
]);

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
    const { message, data, id, from } = update.callback_query;
    if (message?.chat?.type !== 'private') return;

    const parsed = parseCallback(data);
    // Окрема мапа для callback-ів і перевірка typeof: callback_data приходить
    // від клієнта, тобто там може бути будь-що, включно з __proto__.
    const handler = parsed && callbacks.get(parsed.action);
    console.log(`Callback ${typeof handler === 'function' ? parsed.action : '(unknown)'} from chat ${message.chat.id}`);

    if (typeof handler !== 'function') {
      await answerCallbackQuery(id);
      return;
    }
    await handler({
      chatId: message.chat.id,
      messageId: message.message_id,
      callbackId: id,
      value: parsed.value,
      from,
      replyMarkup: message.reply_markup,
    });
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;

  // Тільки приватні чати. У групі chat.id належить групі, а from.id — людині;
  // без цієї перевірки id групи потрапив би в users як «користувач», і вся
  // логіка підписок поїхала б.
  if (msg.chat.type !== 'private') return;

  const parsed = parseCommand(msg.text);
  if (!parsed) return;

  const isAdmin = ADMIN_CHAT_ID !== null && msg.from?.id === ADMIN_CHAT_ID;
  const handler = (isAdmin ? adminCommands.get(parsed.cmd) : undefined)
                ?? commands.get(parsed.cmd);

  // Логуємо лише розпізнану команду й chat id. Текст повідомлень і імена
  // користувачів у логи Fly не пишемо — почистити їх потім не можна.
  console.log(`Command ${typeof handler === 'function' ? parsed.cmd : '(unknown)'} from chat ${msg.chat.id}`);

  // typeof на випадок ключів на кшталт __proto__ чи constructor: текст
  // повідомлення приходить від будь-кого.
  if (typeof handler !== 'function') return;
  await handler({ chatId: msg.chat.id, messageId: msg.message_id, from: msg.from, arg: parsed.arg });
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
      // Кожен апдейт в окремому try: виняток на одному не має забирати
      // решту батча.
      try {
        await processUpdate(update);
      } catch (err) {
        console.error(`Update ${update.update_id}: ${redact(err.message)}`);
      }
    }
  } catch (err) {
    console.error('Poll error:', redact(err.message));
  } finally {
    clearTimeout(timer);
  }
}

// --- HTTP ---

// Поки що єдиний маршрут. Далі сюди стануть вебхук Grafana (задача 19) і
// адмінка (22-23); health лишається поза таблицею й обробляється першим.
const routes = [
  {
    method: 'POST',
    path: '/hooks/grafana',
    handler: async (req, res) => {
      if (!webhookAuthorized(req.headers.authorization, GRAFANA_WEBHOOK_TOKEN)) {
        // Без WWW-Authenticate: не запрошуємо браузер до діалогу й не
        // повідомляємо деталей.
        console.warn('Вебхук: відмова автентифікації');
        res.writeHead(401).end();
        return;
      }

      let payload;
      try {
        payload = JSON.parse((await readBody(req, { limitBytes: 256 * 1024 })).toString());
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad json');
        return;
      }

      const alerts = parseGrafanaWebhook(payload);
      console.log(`Вебхук: ${alerts.length} алерт(ів)` +
        alerts.map(a => ` [${a.status} inverter=${a.inverterId ?? '—'}]`).join(''));

      await alertQueue.deliver(alerts);
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    },
  },
  ...createAdminRoutes({ store, passwordHash: ADMIN_PASSWORD_HASH, log: console }),
  {
    method: 'GET',
    path: '/robots.txt',
    handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /\n');
    },
  },
];

createHttpServer({
  getHealth: () => healthStatus(lastPollSuccessAt, STALENESS_LIMIT_MS, Date.now()),
  routes,
  log: console,
}).listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP на порту ${PORT}`);
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
          { command: 'list', description: '📋 Доступні об’єкти' },
          { command: 'subscribe', description: '➕ Підписатись на об’єкт' },
          { command: 'unsubscribe', description: '➖ Відписатись' },
          { command: 'mysubs', description: '📌 Мої підписки' },
          { command: 'forgetme', description: '🗑 Видалити мої дані' },
          { command: 'status', description: '🔋 Поточний стан' },
          { command: 'graph', description: '📊 Графік за 24 години' },
          { command: 'help', description: 'ℹ️ Список команд' }
        ]
      })
    });
  } catch (err) {
    // Раніше виняток тут виносило в main().catch(), polling не стартував,
    // а HTTP-сервер тримав процес живим і далі рапортував 200.
    console.error('Стартова ініціалізація не вдалась:', redact(err.message));
  }

  // Одна ітерація одразу, далі за інтервалом: інакше після деплою бот 5 хв
  // не знав би жодного інвертора.
  const discovery = createDiscovery({
    store,
    queryGrafana,
    notifyAdmin,
    log: console,
    bucket: INFLUXDB_BUCKET,
    dashboardUid: DASHBOARD_UID,
  });
  discovery.runOnce();
  setInterval(() => discovery.runOnce(), DISCOVERY_INTERVAL_MS).unref();

  const backup = createBackup({
    store, dir: path.dirname(DEFAULT_DB_PATH), keep: 7, log: console,
  });
  backup.runOnce();
  setInterval(() => {
    backup.runOnce();
    store.pruneDeliveries(7);
  }, BACKUP_INTERVAL_MS).unref();

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

// Fly шле SIGTERM на кожному деплої й рестарті машини. Без чекпойнта
// bot.db-wal росте, а на волюмі з жорсткими вбивствами це реальний ризик.
function shutdown(signal) {
  console.log(`${signal}: завершуюсь`);
  try {
    store.raw.pragma('wal_checkpoint(TRUNCATE)');
    store.close();
  } catch (err) {
    console.error('Помилка закриття БД:', err.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', err => console.error('unhandledRejection:', redact(String(err?.message ?? err))));
process.on('uncaughtException', err => console.error('uncaughtException:', redact(err.message)));

main().catch(err => {
  console.error('Fatal:', redact(err.message));
  process.exit(1);
});

import { fmt, renderSocBar, formatKyivTime, parseGrafanaFields } from './helpers.js';
import { INFLUXDB_BUCKET } from './config.js';

// Telegram тримає ~30 msg/s. При кількох підписках /status шле кілька
// повідомлень поспіль, тож між ними — пауза.
const SEND_GAP_MS = 120;

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

// Лоуеркейситься ТІЛЬКИ команда. Аргумент — це id інвертора, а TEXT PRIMARY KEY
// у SQLite має BINARY-колацію: 'deye-sun-15k' не знайде "Deye-SUN-15K", і це
// виглядало б як проблема discovery, а не парсингу.
export function parseCommand(text) {
  const match = String(text ?? '').trim().match(/^(\/\w+)(?:\s+(.+?))?\s*$/);
  if (!match) return null;
  return { cmd: match[1].toLowerCase(), arg: match[2] };
}

export function createCommands({ store, telegram, grafana, log, sleep = defaultSleep }) {
  const { sendMessage, sendPhoto } = telegram;
  const { queryGrafana, renderGrafanaPanel, getDashboardLink } = grafana;

  // Підписка посилається на users(chat_id) зовнішнім ключем, тож рядок
  // користувача мусить існувати ДО запису. Заразом оновлюємо нік: у Telegram
  // його міняють, а застарілий нік робить схвалення в адмінці вгадуванням.
  function ensureUser({ chatId, from }) {
    store.upsertUser(chatId, from?.username ?? null, from?.first_name ?? null);
  }

  async function eachSubscription(chatId, fn) {
    const inverters = store.getSubscriptions(chatId);
    if (inverters.length === 0) {
      await sendMessage(chatId,
        'У вас немає підписок.\n\n/list — доступні об’єкти\n/subscribe &lt;id&gt; — підписатись');
      return;
    }
    for (const [index, inverter] of inverters.entries()) {
      if (index > 0) await sleep(SEND_GAP_MS);
      await fn(inverter);
    }
  }

  async function statusOf(chatId, inverter) {
    const flux = `from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "battery")
  |> filter(fn: (r) => r.inverter == "${inverter.id}")
  |> last()
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;

    const frames = (await queryGrafana(flux))?.results?.A?.frames;
    if (!frames?.length) {
      await sendMessage(chatId, `❌ ${inverter.name}: немає даних за останню годину`);
      return;
    }

    const f = parseGrafanaFields(frames);
    await sendMessage(chatId, `🔋 <b>${inverter.name}</b>

🔋 SOC: <b>${fmt(f.soc, 0)}%</b> ${f.soc < 20 ? '⚠️ КРИТИЧНО!' : ''}
<code>${renderSocBar(f.soc)}</code>

⚡ Напруга: <b>${fmt(f.voltage)} V</b>
⚡ Струм: <b>${fmt(f.current)} A</b>
⚡ Потужність: <b>${fmt(f.power)} W</b>
🌡️ Температура: <b>${fmt(f.temperature)} °C</b>

🟢 Оновлено: ${formatKyivTime(f['_time'] ?? f.Time)}
📊 <a href="${getDashboardLink(inverter)}">Відкрити дашборд</a>`);
  }

  const handlers = new Map();

  handlers.set('/help', async ({ chatId }) => {
    await sendMessage(chatId, `🤖 <b>Моніторинг батарей</b>

/list — доступні об’єкти
/subscribe &lt;id&gt; — підписатись
/unsubscribe &lt;id&gt; — відписатись
/mysubs — мої підписки
/status — поточний стан
/graph — графік за 24 години
/help — ця довідка`);
  });
  handlers.set('/start', handlers.get('/help'));

  handlers.set('/list', async ({ chatId }) => {
    const inverters = store.getAllInverters();
    if (inverters.length === 0) {
      await sendMessage(chatId, 'Поки жодного об’єкта не виявлено.');
      return;
    }
    await sendMessage(chatId, '📋 <b>Доступні об’єкти</b>\n\n' +
      inverters.map(i => `• <code>${i.id}</code> — ${i.name}`).join('\n'));
  });

  handlers.set('/subscribe', async ({ chatId, arg, from }) => {
    const inverter = arg && store.getInverter(arg);
    if (!inverter) {
      await sendMessage(chatId, `❌ Об’єкт <code>${arg ?? ''}</code> не знайдено. /list — перелік.`);
      return;
    }
    ensureUser({ chatId, from });
    const current = store.getSubscriptions(chatId).map(i => i.id);
    store.replaceSubscriptions(chatId, [...new Set([...current, inverter.id])]);
    await sendMessage(chatId, `✅ Підписано на ${inverter.name}`);
  });

  handlers.set('/unsubscribe', async ({ chatId, arg, from }) => {
    ensureUser({ chatId, from });
    const current = store.getSubscriptions(chatId).map(i => i.id);
    if (!arg || !current.includes(arg)) {
      await sendMessage(chatId, `❌ Ви не підписані на <code>${arg ?? ''}</code>. /mysubs — перелік.`);
      return;
    }
    store.replaceSubscriptions(chatId, current.filter(id => id !== arg));
    await sendMessage(chatId, `✅ Відписано від ${arg}`);
  });

  handlers.set('/mysubs', async ({ chatId }) => {
    const inverters = store.getSubscriptions(chatId);
    await sendMessage(chatId, inverters.length === 0
      ? 'У вас немає підписок. /list — доступні об’єкти.'
      : '📌 <b>Ваші підписки</b>\n\n' + inverters.map(i => `• ${i.name} (<code>${i.id}</code>)`).join('\n'));
  });

  handlers.set('/status', async ({ chatId }) => {
    await eachSubscription(chatId, async inverter => {
      try {
        await statusOf(chatId, inverter);
      } catch (err) {
        // Деталі — в лог: у тілі помилки Grafana бувають uid датасорсів
        // і внутрішні хости.
        log.error(`/status ${inverter.id}: ${err.message}`);
        await sendMessage(chatId, `❌ ${inverter.name}: дані тимчасово недоступні.`);
      }
    });
  });

  handlers.set('/graph', async ({ chatId }) => {
    await eachSubscription(chatId, async inverter => {
      try {
        const image = await renderGrafanaPanel(inverter);
        await sendPhoto(chatId, image, `📊 ${inverter.name} — SOC за 24 години`);
      } catch (err) {
        log.error(`/graph ${inverter.id}: ${err.message}`);
        await sendMessage(chatId,
          `📊 <a href="${getDashboardLink(inverter)}">${inverter.name} — відкрити дашборд</a>\n\n⚠️ Графік тимчасово недоступний.`);
      }
    });
  });

  return handlers;
}

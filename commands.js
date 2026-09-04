import { fmt, renderSocBar, formatKyivTime, parseGrafanaFields, escapeHtml, batteryState } from './helpers.js';
import { buildKeyboard, readChecked } from './subs-keyboard.js';
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

  // Гейт доступу. Закриває дірку задачі 13 §5: рендер /render/d-solo —
  // метрована операція на Free-плані Grafana, і до неї не має дотягнутись
  // ніхто, кого адмін не схвалив.
  function accessDenial(chatId) {
    const user = store.getUser(chatId);
    if (user?.status === 'approved') return null;
    if (user?.status === 'pending') {
      return 'Ваша заявка на розгляді. Щойно адміністратор її схвалить, надійде сповіщення.';
    }
    if (user?.status === 'rejected') {
      return 'Заявку відхилено. Можна спробувати пізніше — /subscribe.';
    }
    return 'Щоб отримати доступ, оберіть об’єкти й надішліть заявку: /subscribe';
  }

  function gated(handler) {
    return async ctx => {
      const denial = accessDenial(ctx.chatId);
      if (denial) {
        await sendMessage(ctx.chatId, denial);
        return;
      }
      await handler(ctx);
    };
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
⚡ Потужність: <b>${fmt(f.power)} W</b>${batteryState(f.power) ? ` — ${batteryState(f.power)}` : ''}
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
    // Без аргументу — клавіатура з чекбоксами. Текстовий шлях лишається для
    // тих, хто знає id, і для скриптів.
    if (!arg) {
      const inverters = store.getAllInverters();
      const keyboard = buildKeyboard(inverters, store.getSubscriptions(chatId).map(i => i.id));
      if (!keyboard) {
        await sendMessage(chatId, 'Поки жодного об’єкта не виявлено.');
        return;
      }
      const isApproved = store.getUser(chatId)?.status === 'approved';
      await sendMessage(chatId,
        'Оберіть об’єкти, за якими хочете отримувати сповіщення:' +
        (isApproved ? '\n\n⚠️ Зміна набору поверне заявку на розгляд, і до схвалення сповіщення не надходитимуть.' : ''),
        { reply_markup: keyboard });
      return;
    }

    const inverter = store.getInverter(arg);
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

  handlers.set('/status', gated(async ({ chatId }) => {
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
  }));

  handlers.set('/graph', gated(async ({ chatId }) => {
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
  }));

  handlers.set('/forgetme', async ({ chatId }) => {
    // Незворотна дія — тільки з підтвердженням окремою кнопкою.
    await sendMessage(chatId,
      '⚠️ Це видалить ваш запис і всі підписки. Відновити не можна.\n\nПідтверджуєте?',
      { reply_markup: { inline_keyboard: [[
        { text: '🗑 Так, видалити', callback_data: 'fg:yes' },
        { text: 'Скасувати', callback_data: 'fg:no' },
      ]] } });
  });

  handlers.set('a', async ({ messageId, chatId, callbackId, from, value }) => {
    // Перевірка тут, а не лише при показі кнопок: callback_data може
    // надіслати будь-хто, хто вгадає формат.
    if (adminChatId === null || from?.id !== adminChatId) {
      await telegram.answerCallbackQuery(callbackId);
      return;
    }
    const [decision, target] = String(value ?? '').split(':');
    const targetId = Number(target);
    const user = store.getUser(targetId);
    if (!user) {
      await telegram.answerCallbackQuery(callbackId, 'Користувача вже немає');
      return;
    }

    const approved = decision === 'ok';
    // Відхилення НЕ видаляє підписки: людину можуть схвалити пізніше, і
    // змушувати обирати заново — марна робота.
    store.setUserStatus(targetId, approved ? 'approved' : 'rejected', `tg:${from.id}`);

    const who = user.username ? '@' + escapeHtml(user.username) : escapeHtml(user.first_name ?? targetId);
    await telegram.editMessageText(chatId, messageId,
      `${approved ? '✅ Схвалено' : '🚫 Відхилено'} ${who}`);
    await telegram.answerCallbackQuery(callbackId, approved ? 'Схвалено' : 'Відхилено');
    await telegram.sendMessage(targetId, approved
      ? '✅ Доступ відкрито. /status — поточний стан, /graph — графік.'
      : '🚫 Заявку відхилено. Можна спробувати пізніше — /subscribe.');
    log.info(`Рішення ${approved ? 'approve' : 'reject'} для chat:${targetId}`);
  });

  handlers.set('fg', async ({ chatId, messageId, callbackId, value }) => {
    if (value !== 'yes') {
      await telegram.editMessageText(chatId, messageId, 'Скасовано.');
      await telegram.answerCallbackQuery(callbackId);
      return;
    }
    store.deleteUser(chatId);
    await telegram.editMessageText(chatId, messageId,
      '🗑 Ваш запис і підписки видалено. /subscribe — почати спочатку.');
    await telegram.answerCallbackQuery(callbackId, 'Видалено');
    log.info(`Видалення за запитом chat:${chatId}`);
  });

  return handlers;
}

// --- Обробники натискань на inline-клавіатурі ---

export function createCallbacks({ store, telegram, notifyAdmin, log, adminChatId = null }) {
  const handlers = new Map();

  function idsFromRowids(rowids) {
    const wanted = new Set(rowids);
    return store.getAllInverters().filter(i => wanted.has(i.rowid));
  }

  handlers.set('t', async ({ chatId, messageId, callbackId, value, replyMarkup }) => {
    const rowid = Number(value);
    const checked = new Set(readChecked(replyMarkup));
    const added = !checked.has(rowid);
    if (added) checked.add(rowid); else checked.delete(rowid);

    const inverters = store.getAllInverters();
    const checkedIds = inverters.filter(i => checked.has(i.rowid)).map(i => i.id);
    await telegram.editMessageReplyMarkup(chatId, messageId, buildKeyboard(inverters, checkedIds));
    await telegram.answerCallbackQuery(callbackId, added ? 'Додано' : 'Прибрано');
  });

  handlers.set('req', async ({ chatId, messageId, callbackId, from, replyMarkup }) => {
    const chosen = idsFromRowids(readChecked(replyMarkup));
    if (chosen.length === 0) {
      await telegram.answerCallbackQuery(callbackId, 'Оберіть хоча б один об’єкт');
      return;
    }

    // Користувач мусить існувати до підписки (FOREIGN KEY), а нік оновлюємо
    // при кожному зверненні — люди їх міняють.
    store.upsertUser(chatId, from?.username ?? null, from?.first_name ?? null);
    // Транзакція всередині: набір і скидання статусу в pending нероздільні.
    store.replaceSubscriptions(chatId, chosen.map(i => i.id));

    await telegram.editMessageText(chatId, messageId,
      `📨 Заявку надіслано на розгляд.\n\nОбрані об’єкти:\n${chosen.map(i => `• ${escapeHtml(i.name)}`).join('\n')}\n\nСповіщення надходитимуть після схвалення.`);
    await telegram.answerCallbackQuery(callbackId, 'Заявку надіслано');

    // Ім'я обирає сама людина, тож воно може містити '<' — і тоді Telegram
    // відхилив би повідомлення адміну цілком з 400.
    const who = from?.username ? '@' + escapeHtml(from.username) : escapeHtml(from?.first_name ?? chatId);
    await notifyAdmin(
      `🆕 <b>Нова заявка</b>\n\n${who} (${escapeHtml(from?.first_name ?? '')})\nОб’єкти: ${chosen.map(i => escapeHtml(i.name)).join(', ')}`,
      { reply_markup: { inline_keyboard: [[
        { text: '✅ Схвалити', callback_data: `a:ok:${chatId}` },
        { text: '🚫 Відхилити', callback_data: `a:no:${chatId}` },
      ]] } });
    log.info(`Заявка від chat:${chatId} на ${chosen.length} об’єкт(ів)`);
  });

  handlers.set('a', async ({ messageId, chatId, callbackId, from, value }) => {
    // Перевірка тут, а не лише при показі кнопок: callback_data може
    // надіслати будь-хто, хто вгадає формат.
    if (adminChatId === null || from?.id !== adminChatId) {
      await telegram.answerCallbackQuery(callbackId);
      return;
    }
    const [decision, target] = String(value ?? '').split(':');
    const targetId = Number(target);
    const user = store.getUser(targetId);
    if (!user) {
      await telegram.answerCallbackQuery(callbackId, 'Користувача вже немає');
      return;
    }

    const approved = decision === 'ok';
    // Відхилення НЕ видаляє підписки: людину можуть схвалити пізніше, і
    // змушувати обирати заново — марна робота.
    store.setUserStatus(targetId, approved ? 'approved' : 'rejected', `tg:${from.id}`);

    const who = user.username ? '@' + escapeHtml(user.username) : escapeHtml(user.first_name ?? targetId);
    await telegram.editMessageText(chatId, messageId,
      `${approved ? '✅ Схвалено' : '🚫 Відхилено'} ${who}`);
    await telegram.answerCallbackQuery(callbackId, approved ? 'Схвалено' : 'Відхилено');
    await telegram.sendMessage(targetId, approved
      ? '✅ Доступ відкрито. /status — поточний стан, /graph — графік.'
      : '🚫 Заявку відхилено. Можна спробувати пізніше — /subscribe.');
    log.info(`Рішення ${approved ? 'approve' : 'reject'} для chat:${targetId}`);
  });

  handlers.set('fg', async ({ chatId, messageId, callbackId, value }) => {
    if (value !== 'yes') {
      await telegram.editMessageText(chatId, messageId, 'Скасовано.');
      await telegram.answerCallbackQuery(callbackId);
      return;
    }
    store.deleteUser(chatId);
    await telegram.editMessageText(chatId, messageId,
      '🗑 Ваш запис і підписки видалено. /subscribe — почати спочатку.');
    await telegram.answerCallbackQuery(callbackId, 'Видалено');
    log.info(`Видалення за запитом chat:${chatId}`);
  });

  return handlers;
}

import { selectRecipients, formatAlert } from './alerts-fanout.js';
import { dedupKey } from './webhook-grafana.js';

// Telegram тримає ~30 msg/s глобально. 120 мс дає ~8/s — з великим запасом.
const SEND_GAP_MS = 120;
// Стеля на один алерт: 100 × 120 мс = 12 с, у межах будь-якого таймаута.
const MAX_RECIPIENTS = 100;
// Трохи більше за group_interval Grafana (5 хв): ловить справжні ретраї,
// але пропускає навмисні повтори по repeat_interval (типово 4 год).
const DEDUP_WINDOW_MS = 15 * 60_000;

export function createAlertQueue({ store, send, log, sleep, adminChatId = null }) {
  async function deliverOne(chatId, text, key) {
    // Дедуп на пару (алерт, адресат): різні люди підписані на різне.
    if (store.wasDelivered(key, chatId, DEDUP_WINDOW_MS)) return false;

    let result = await send(chatId, text);

    if (!result.ok && result.retryAfter) {
      // Зараз повідомлення в такому разі просто губилось (задача 13 §2).
      log.warn(`Telegram 429 для chat:${chatId}, чекаю ${result.retryAfter}с`);
      await sleep(result.retryAfter * 1000);
      result = await send(chatId, text);
    }

    if (!result.ok && result.blocked) {
      // Людина видалила бота. Ретраї тут марні, і кожен наступний алерт
      // витрачав би на неї спроби.
      log.warn(`chat:${chatId} заблокував бота — позначаю`);
      store.setUserStatus(chatId, 'rejected', 'telegram-blocked');
      return false;
    }

    if (!result.ok) return false;

    // Позначаємо ПІСЛЯ успішної відправки: якщо процес помре посеред
    // розсилки, при повторі Grafana дошле решті. Зайвий дубль дешевший за
    // пропущений алерт про розряд.
    store.markDelivered(key, chatId);
    return true;
  }

  async function deliver(alerts) {
    for (const alert of alerts) {
      const known = alert.inverterId ? !!store.getInverter(alert.inverterId) : false;
      const { chatIds, reason } = selectRecipients({
        inverterId: alert.inverterId,
        inverterKnown: known,
        subscribers: alert.inverterId ? store.getSubscribers(alert.inverterId) : [],
        adminChatId,
      });

      if (reason !== 'subscribers') {
        log.warn(`Алерт «${alert.alertname}» без адресації по інверторах: ${reason}`);
      }

      const text = formatAlert(alert);
      const key = dedupKey(alert);
      const targets = chatIds.slice(0, MAX_RECIPIENTS);
      if (chatIds.length > MAX_RECIPIENTS) {
        log.error(`Адресатів ${chatIds.length}, обрізано до ${MAX_RECIPIENTS}`);
      }

      let delivered = 0;
      for (const [index, chatId] of targets.entries()) {
        if (index > 0) await sleep(SEND_GAP_MS);
        if (await deliverOne(chatId, text, key)) delivered++;
      }
      if (delivered > 0) log.info(`Алерт «${alert.alertname}» → ${delivered} адресат(ів)`);
    }
  }

  return { deliver };
}

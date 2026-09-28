import { selectRecipients, formatAlert } from './alerts-fanout.js';
import { dedupKey } from './webhook-grafana.js';

// Telegram тримає ~30 msg/s глобально. 120 мс дає ~8/s — з великим запасом.
const SEND_GAP_MS = 120;
// Стеля на один алерт: 100 × 120 мс = 12 с, у межах будь-якого таймаута.
const MAX_RECIPIENTS = 100;
// Трохи більше за group_interval Grafana (5 хв): ловить справжні ретраї,
// але пропускає навмисні повтори по repeat_interval (типово 4 год).
const DEDUP_WINDOW_MS = 15 * 60_000;

// Позначка для адміна: під час паузи він отримує алерт один, і має бачити,
// що підписникам цей текст не пішов.
const PAUSED_PREFIX = '⏸ <i>Пауза сповіщень — підписникам не надіслано</i>\n\n';

export function createAlertQueue({ store, send, log, sleep, adminChatId = null, isPaused = () => false }) {
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
    // Одне читання на вебхук: пауза, знята посеред розсилки, не мусить
    // розрізати один алерт на «комусь пішов, комусь ні».
    const paused = isPaused();
    for (const alert of alerts) {
      const inverter = alert.inverterId ? store.getInverter(alert.inverterId) : null;
      const { chatIds, reason } = selectRecipients({
        inverterId: alert.inverterId,
        inverterKnown: !!inverter,
        subscribers: alert.inverterId ? store.getSubscribers(alert.inverterId) : [],
        adminChatId,
      });

      if (reason !== 'subscribers') {
        log.warn(`Алерт «${alert.alertname}» без адресації по інверторах: ${reason}`);
      }

      // Адмін лишається на звʼязку: пауза глушить людей, а не моніторинг.
      // Алерт, пропущений підписниками, повториться після паузи з наступним
      // repeat_interval Grafana, якщо проблема ще триває.
      const recipients = paused ? chatIds.filter(id => id === adminChatId) : chatIds;
      if (paused) log.info(`Пауза: алерт «${alert.alertname}» підписникам не надіслано`);

      const text = (paused ? PAUSED_PREFIX : '') + formatAlert(alert, inverter?.name);
      const key = dedupKey(alert);
      const targets = recipients.slice(0, MAX_RECIPIENTS);
      if (recipients.length > MAX_RECIPIENTS) {
        log.error(`Адресатів ${recipients.length}, обрізано до ${MAX_RECIPIENTS}`);
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

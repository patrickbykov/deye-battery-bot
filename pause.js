import { escapeHtml, formatKyivTime } from './helpers.js';

// Та сама пауза між повідомленнями, що й у розсилці алертів: ~8 msg/s.
const SEND_GAP_MS = 120;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

// `/pause [30m|2h|1d] [причина]`. Тривалість — лише перше слово строго у
// форматі число+одиниця. «2 години» лишається причиною: мовчки прочитати його
// як «2 хвилини» гірше, ніж безстрокова пауза, яку адмін зніме сам.
export function parsePauseArg(arg, now) {
  const text = String(arg ?? '').trim();
  const match = text.match(/^(\d+)([mhd])(?:\s+(.*))?$/i);
  if (!match) return { until: null, reason: text || null };

  const ms = Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
  if (ms <= 0) return null;
  return { until: new Date(now + ms).toISOString(), reason: match[3]?.trim() || null };
}

export function isPauseActive(pause, now) {
  if (!pause) return false;
  return pause.until === null || Date.parse(pause.until) > now;
}

function untilText(until) {
  return until ? `до ${formatKyivTime(until)}` : 'до окремого повідомлення';
}

export function pauseAnnouncement({ reason, until }) {
  return '⏸ Сповіщення тимчасово призупинено' +
    (reason ? `: ${escapeHtml(reason)}` : '') + '.\n' +
    `Пауза триватиме ${untilText(until)}. ` +
    'Поки вона діє, відсутність сповіщень не означає, що все гаразд — перевіряйте /status.';
}

// Меню на голу `/pause` — те, що шле пункт меню Telegram. Кнопки, а не
// миттєва пауза: випадковий тап інакше розіслав би оголошення всім.
const DURATIONS = ['1h', '2h', '4h', '12h'];

export function pauseMenu(pause, now) {
  if (isPauseActive(pause, now)) {
    return {
      text: '⏸ <b>Сповіщення на паузі</b>' +
        (pause.reason ? `\nПричина: ${escapeHtml(pause.reason)}` : '') +
        `\nТриватиме ${untilText(pause.until)}.` +
        '\n\nЗмінити строк — кнопкою нижче.',
      reply_markup: { inline_keyboard: [
        [{ text: '▶️ Відновити зараз', callback_data: 'p:resume' }],
        DURATIONS.map(d => ({ text: d.replace('h', ' год'), callback_data: `p:${d}` })),
        [{ text: '∞ Без строку', callback_data: 'p:inf' }, { text: 'Закрити', callback_data: 'p:cancel' }],
      ] },
    };
  }
  return {
    text: '▶️ Сповіщення не на паузі.\n\nНа скільки поставити паузу? Усі схвалені отримають оголошення.' +
      '\nЗ причиною: <code>/pause 2h планові роботи</code>',
    reply_markup: { inline_keyboard: [
      DURATIONS.map(d => ({ text: d.replace('h', ' год'), callback_data: `p:${d}` })),
      [{ text: '∞ Без строку', callback_data: 'p:inf' }, { text: 'Скасувати', callback_data: 'p:cancel' }],
    ] },
  };
}

export const RESUME_ANNOUNCEMENT =
  '▶️ Сповіщення знову працюють. Якщо проблема досі триває, нагадування прийде з наступним циклом перевірки.';

export function createPauseControl({ store, send, sleep, log, now = Date.now }) {
  // Людям, а не лише адміну: інакше тиша під час паузи читається як «світло є».
  async function broadcast(text) {
    let delivered = 0;
    for (const [index, chatId] of store.getApprovedChatIds().entries()) {
      if (index > 0) await sleep(SEND_GAP_MS);
      const result = await send(chatId, text);
      if (result?.ok) delivered++;
    }
    return delivered;
  }

  const isActive = () => isPauseActive(store.getPause(), now());

  async function pause({ reason, until, by }) {
    const wasActive = isActive();
    store.setPause({ reason, until, by });
    // Уточнення причини чи строку — не привід будити всіх удруге.
    const announced = wasActive ? 0 : await broadcast(pauseAnnouncement({ reason, until }));
    log.info(`Пауза сповіщень ${untilText(until)}, повідомлено: ${announced}`);
    return { announced, updated: wasActive };
  }

  async function resume() {
    const previous = store.clearPause();
    // Прострочена пауза вже нічого не глушила — повідомляти про її кінець
    // означало б сказати людям про паузу, якої для них не було.
    if (!isPauseActive(previous, now())) return { wasPaused: false, announced: 0 };
    const announced = await broadcast(RESUME_ANNOUNCEMENT);
    log.info(`Пауза сповіщень знята, повідомлено: ${announced}`);
    return { wasPaused: true, announced };
  }

  // Строк без тику нічого б не оголосив: пауза тихо перестала б діяти, а
  // люди так і не дізнались би, що сповіщення знову йдуть.
  async function tick() {
    const current = store.getPause();
    if (!current || isPauseActive(current, now())) return { resumed: false };
    store.clearPause();
    const announced = await broadcast(RESUME_ANNOUNCEMENT);
    log.info(`Пауза сповіщень скінчилась за строком, повідомлено: ${announced}`);
    return { resumed: true, announced };
  }

  return { isActive, pause, resume, tick, current: () => store.getPause() };
}

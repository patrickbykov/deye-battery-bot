export function fmt(value, decimals = 1) {
  // Number.isNaN('abc') це false, тож стара перевірка пропускала рядки
  // і друкувала користувачу «NaN». Перевіряємо результат перетворення.
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) {
    return 'N/A';
  }
  return number.toFixed(decimals);
}

export function renderSocBar(soc) {
  if (soc === null || soc === undefined) return '';
  // Заклампити обовʼязково: '░'.repeat(-1) кидає RangeError, тобто збій BMS
  // з SOC поза діапазоном валив би відповідь на /status цілком.
  const filled = Math.min(10, Math.max(0, Math.round(soc / 10)));
  return '[' + '█'.repeat(filled) + '░'.repeat(10 - filled) + ']';
}

export function formatKyivTime(time) {
  if (!time) return 'N/A';
  return new Date(time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
}

// Назви місяців зашиті, а не взяті з Intl: month:'short' дає різний рядок на
// різних збірках ICU (з крапкою й без), а це текст, який читає людина.
// З Intl береться лише зсув київського поясу — числами, тобто стабільно.
const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];

export function formatKyivDate(time) {
  if (!time) return 'N/A';
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return 'N/A';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', day: 'numeric', month: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${Number(parts.day)} ${MONTHS_SHORT[Number(parts.month) - 1]} ${parts.hour}:${parts.minute}`;
}

export function parseGrafanaFields(frames) {
  const schema = frames[0].schema?.fields || [];
  const values = frames[0].data?.values || [];

  const fields = {};
  schema.forEach((field, i) => {
    fields[field.name] = values[i]?.[values[i].length - 1];
  });
  return fields;
}

// Вирізає токен бота з будь-якого тексту перед логуванням. node-fetch кладе
// повний URL запиту в текст FetchError, а URL Telegram містить токен.
export function redact(text) {
  return String(text).replace(/\/bot[^/\s]+/g, '/bot<REDACTED>');
}

// Один інструмент для двох проблем: у HTML адмінки він закриває XSS, у
// повідомленні Telegram з parse_mode HTML — помилку 400 can't parse entities,
// через яку алерти мовчали два місяці.
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Знак BatteryPower у Deye обернений до інтуїції: відʼємне значення означає
// ЗАРЯД. Підтверджено трьома незалежними спостереженнями 3-4 вер 2026:
// балансом потужностей (мережа 742 Вт при навантаженні 239 Вт і батареї
// -405 Вт сходиться лише як заряд), стрибком напруги 54.2 → 56.2 V за шість
// хвилин при -400 Вт, і статистикою за 20 годин — напруга на клемах на
// 0.51 V вища на ділянках з відʼємною потужністю при незмінному SOC.
const IDLE_WATTS = 5;

export function batteryState(power) {
  const watts = Number(power);
  if (power === null || power === undefined || !Number.isFinite(watts)) return null;
  if (Math.abs(watts) < IDLE_WATTS) return 'у спокої';
  return watts < 0 ? 'заряджається' : 'розряджається';
}

// Той самий поріг, що в правилі «⚡ Немає живлення від мережі» (docs/grafana-alerting.md).
// Якщо вони розійдуться, бот казатиме «мережа є» саме тоді, коли надходить
// сповіщення про її зникнення.
export const GRID_PRESENT_VOLTS = 50;

export function gridPresent(voltage) {
  const volts = Number(voltage);
  if (voltage === null || voltage === undefined || !Number.isFinite(volts)) return null;
  return volts >= GRID_PRESENT_VOLTS;
}

// Ніки в Telegram регістронезалежні, а зберігаємо ми їх як TEXT PRIMARY KEY
// з BINARY-колацією: без зведення до нижнього регістру '@Petro' і 'petro'
// стали б різними записами, і запрошення не спрацювало б.
// Правила самого Telegram: 5-32 символи, літери/цифри/підкреслення,
// починається з літери. null означає «це не нік» — рішення про текст
// помилки лишається за викликачем.
export function normalizeUsername(value) {
  const clean = String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  return /^[a-z][a-z0-9_]{4,31}$/.test(clean) ? clean : null;
}

// Одне джерело текстів рішення на обидва шляхи — кнопку в Telegram і
// перемикач у веб-адмінці. Тримати їх окремо означало б, що людина отримує
// різні формулювання залежно від того, звідки натиснув адмін, а розійдуться
// вони при першій же правці.
//
// Статус `rejected` покриває дві різні події, і плутати їх не можна:
// відмову за новою заявкою і зняття вже наданого доступу. Друга — це коли
// підписник просто перестає отримувати попередження про розряд; без окремого
// тексту він вважатиме це поломкою, а не рішенням.
export function decisionMessage(before, after) {
  if (before === after) return null;
  if (after === 'approved') {
    return '✅ Доступ відкрито. /status — поточний стан, /graph — графік.';
  }
  if (after === 'rejected') {
    return before === 'approved'
      ? '🔒 Доступ закрито — сповіщення більше не надходитимуть. /subscribe — подати заявку знову.'
      : '🚫 Заявку відхилено. Можна спробувати пізніше — /subscribe.';
  }
  return null;
}

// Той самий текст на обидва шляхи видалення — кнопку в адмінці і
// /remove_inverter. Людина інакше просто перестає отримувати попередження
// й не має підстав запідозрити, що це рішення, а не поломка.
export function objectRemoved(name) {
  return `🗑 Обʼєкт «${name}» більше не відстежується. Підписку на нього знято.`;
}

// «год» і «хв» не відмінюються, а «доба» — відмінюється, і машинне «3 доба»
// підриває довіру рівно до тієї цифри, заради якої віджет робиться.
function pluralUk(n, one, few, many) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// Від доби і вище хвилини відкидаються навмисно: «3 доби 11 год 59 хв» —
// точність, якої ніхто не читає, а вікно спостережень потрібне для масштабу.
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const days = Math.floor(total / 1440);
  if (days > 0) {
    const hours = Math.floor((total - days * 1440) / 60);
    return `${days} ${pluralUk(days, 'доба', 'доби', 'діб')}` + (hours ? ` ${hours} год` : '');
  }
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins} хв`;
  return `${hours} год` + (mins ? ` ${mins} хв` : '');
}

// Три різні відповіді, які легко злити в одну й тим збрехати:
// «нічого не вимикали», «вимикали стільки-то» і «ми ще нічого не знаємо».
// Третій випадок — головний: «без світла 0 хв» при порожньому бакеті
// неможливо відрізнити від справжнього нуля, а це рівно той тип тихої
// неправди, через який алерти мовчали два місяці (docs/grafana-alerting.md).
export function formatOutageSummary({ observedMinutes, outageMinutes, since }) {
  const observed = Math.max(0, Number(observedMinutes) || 0);
  if (observed === 0) return 'Даних за цей період ще немає — рахувати нема за чим.';

  const outage = Math.max(0, Number(outageMinutes) || 0);
  // Без розмітки: підпис до фото йде через sendPhoto, який не встановлює
  // parse_mode, тож <b> показався б літерами.
  const head = outage === 0
    ? 'Відключень не було.'
    : `Без світла: ${formatDuration(outage)}`;
  return `${head}\nСпостереження: ${formatDuration(observed)}, з ${formatKyivDate(since)}`;
}

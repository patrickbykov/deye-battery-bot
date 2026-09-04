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

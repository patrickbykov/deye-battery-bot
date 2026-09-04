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

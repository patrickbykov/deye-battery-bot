import { escapeHtml, formatKyivDate } from './helpers.js';

// Адресація рахується на кожен елемент alerts[] окремо, не на конверт:
// в одному вебхуку можуть приїхати алерти по різних інверторах.
export function selectRecipients({ inverterId, inverterKnown, subscribers, adminChatId }) {
  if (!inverterId || !inverterKnown) {
    // Алерт без інвертора (застій даних) або з невідомим — це інцидент
    // моніторингу, а не конкретного будинку. Полагодити може лише адмін.
    return {
      chatIds: adminChatId ? [adminChatId] : [],
      reason: inverterId ? 'unknown-inverter' : 'no-label',
    };
  }

  const recipients = new Set(subscribers);
  if (adminChatId) recipients.add(adminChatId);   // Set, щоб адмін-підписник не отримав дубль
  return { chatIds: [...recipients], reason: 'subscribers' };
}

// Grafana підставляє в анотації {{ $labels.inverter }} — тобто серійник.
// Людині, яка живе в тому будинку, він не каже нічого, тож підміняємо його
// назвою, яку задав адмін.
function humanize(text, inverterId, name) {
  if (!name || !inverterId || name === inverterId) return text;
  return String(text ?? '').replaceAll(inverterId, name);
}

function kyivHm(time) {
  if (!time) return null;
  const d = new Date(time);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false });
}

// Math.round, а не toFixed: (-0.4).toFixed(0) дає «-0».
const num = v => String(Math.round(Number(v)) + 0);
// Точки старші за годину не видаємо за поточні (інвертор міг замовкнути в блекаут).
const FRESH_MS = 60 * 60_000;
const isFresh = (time, now) => time != null && now - new Date(time).getTime() <= FRESH_MS;

// Правило «Немає живлення від мережі»: короткий текст з живих показників.
// ctx може бути null (Influx недоступний) — тоді лишаються лише заголовок і рядки, що відомі.
// Споживання = мережа + розряд батареї, усереднене за 24 год (без PV це все навантаження).
const NOMINAL_V = 51.2;
export function formatGridAlert(alert, name, ctx, now = Date.now()) {
  const title = escapeHtml(humanize(alert.inverterId, alert.inverterId, name));
  const lines = [];
  if (alert.status === 'resolved') lines.push(`✅ ${title}: мережа повернулась`);
  else lines.push(`⚡ ${title}: немає мережі`);

  if (ctx?.soc != null && isFresh(ctx.batteryTime, now)) lines.push(`🔋 Заряд: ${num(ctx.soc)}%`);

  const g = ctx?.grid;
  if (alert.status === 'resolved') {
    if (g?.voltage != null) {
      const parts = [`${num(g.voltage)} В`];
      if (g.frequency != null) parts.push(`${num(g.frequency)} Гц`);
      if (g.power != null) parts.push(`${num(g.power)} Вт`);
      lines.push(`🔌 Мережа: ${parts.join(', ')}`);
    }
  } else if (ctx?.avgPower != null && ctx.avgPower >= 1) {
    // Відсотки — частка заряду цього інвертора за годину; без ємності лише Вт.
    const pct = ctx.capacityAh > 0 ? ` (${num(ctx.avgPower / (ctx.capacityAh * NOMINAL_V) * 100)}%)` : '';
    lines.push(`💡 Середнє споживання за 24 год: ~${num(ctx.avgPower)} Вт/год${pct}`);
  }

  const t = isFresh(g?.time, now) ? kyivHm(g.time) : (g?.time ? formatKyivDate(g.time) : null);
  if (t) lines.push(`🕒 Дані про мережу: ${t}`);
  return lines.join('\n');
}

export function formatAlert(alert, name, ctx = null, now = Date.now()) {
  const id = alert.inverterId;
  if (alert.alertname && String(alert.alertname).includes('Немає живлення від мережі') && alert.stateReason !== 'NoData') {
    return formatGridAlert(alert, name, ctx, now);
  }
  if (alert.status === 'resolved') {
    return `✅ Все гаразд — ${escapeHtml(humanize(alert.resolved || 'стан нормалізувався', id, name))}`;
  }

  // NoData — це «правило не змогло оцінити стан», а не «стан поганий».
  // Видавати одне за інше означає вчити людей ігнорувати сповіщення.
  if (alert.stateReason === 'NoData') {
    return `📡 Немає даних для перевірки: ${escapeHtml(humanize(alert.alertname, id, name))}\n\n` +
      'Показники не надійшли, тож правило не змогло оцінити стан. Це не означає, що щось не так.';
  }

  return `${escapeHtml(humanize(alert.summary, id, name))}\n\n${escapeHtml(humanize(alert.description, id, name))}`.trim();
}

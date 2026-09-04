import { escapeHtml } from './helpers.js';

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

export function formatAlert(alert, name) {
  const id = alert.inverterId;
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

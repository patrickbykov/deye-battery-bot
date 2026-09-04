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

export function formatAlert(alert) {
  if (alert.status === 'resolved') {
    return `✅ Все гаразд — ${escapeHtml(alert.resolved || 'стан нормалізувався')}`;
  }

  // NoData — це «правило не змогло оцінити стан», а не «стан поганий».
  // Видавати одне за інше означає вчити людей ігнорувати сповіщення.
  if (alert.stateReason === 'NoData') {
    return `📡 Немає даних для перевірки: ${escapeHtml(alert.alertname)}\n\n` +
      'Показники не надійшли, тож правило не змогло оцінити стан. Це не означає, що щось не так.';
  }

  return `${escapeHtml(alert.summary)}\n\n${escapeHtml(alert.description)}`.trim();
}

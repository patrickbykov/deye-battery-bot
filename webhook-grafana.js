import { createHash, timingSafeEqual } from 'node:crypto';

// Ендпойнт вебхука — це множник: один HTTP-запит перетворюється на N
// повідомлень у приватні чати від імені бота, якому люди довіряють. Без
// перевірки будь-хто, хто вгадає шлях, розсилає підписникам що завгодно.
export function webhookAuthorized(header, expectedToken) {
  if (!expectedToken) return false;                 // забутий секрет ≠ відкритий вхід
  const match = /^Bearer\s+(\S+)$/.exec(String(header ?? ''));
  if (!match) return false;

  // Порівнюємо дайджести, а не сирі рядки: timingSafeEqual кидає на різній
  // довжині, і сама наявність винятку злила б довжину токена.
  const got = createHash('sha256').update(match[1]).digest();
  const want = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(got, want);
}

// Telegram відхиляє повідомлення понад 4096 символів. Одне довге description
// втратило б увесь алерт, а не лише свій хвіст.
const MAX_SUMMARY = 400;
const MAX_DESCRIPTION = 900;

export function parseGrafanaWebhook(payload) {
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];

  return alerts.map((alert, index) => {
    const labels = alert?.labels ?? {};
    const annotations = alert?.annotations ?? {};
    const inverter = labels.inverter;

    return {
      status: alert?.status === 'resolved' ? 'resolved' : 'firing',
      // Правило застою робить group(), теги схлопуються — мітки не буде.
      // Це не помилка, а окрема гілка адресації.
      inverterId: typeof inverter === 'string' && inverter ? inverter : null,
      alertname: String(labels.alertname ?? 'Сповіщення'),
      summary: String(annotations.summary ?? '').slice(0, MAX_SUMMARY),
      description: String(annotations.description ?? '').slice(0, MAX_DESCRIPTION),
      resolved: String(annotations.resolved ?? '').slice(0, MAX_SUMMARY),
      stateReason: String(annotations.grafana_state_reason ?? labels.grafana_state_reason ?? ''),
      startsAt: String(alert?.startsAt ?? ''),
      // Фолбек обов'язковий: у ручному тесті з UI Grafana fingerprint може
      // бути відсутній, і без нього всі алерти схлопнулись би в один ключ.
      fingerprint: String(alert?.fingerprint ?? `${labels.alertname}|${inverter}|${index}`),
    };
  });
}

export function dedupKey(alert) {
  return `${alert.fingerprint}|${alert.status}|${alert.startsAt}`;
}

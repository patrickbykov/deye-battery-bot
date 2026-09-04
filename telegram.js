import fetch from 'node-fetch';
import { TG_API } from './config.js';
import { redact } from './helpers.js';

const TIMEOUT_MS = 15_000;

async function post(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${TG_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function sendMessage(chatId, text, options = {}) {
  try {
    const res = await post('/sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...options
    });

    if (!res.ok) {
      console.error(`sendMessage failed: ${res.status} ${redact(await res.text())}`);
    }
  } catch (err) {
    console.error('sendMessage error:', redact(err.message));
  }
}

// Окремо від sendMessage: розсилці потрібно РОЗРІЗНЯТИ причини відмови.
// 429 означає «почекай і повтори», 403 — «людина видалила бота, більше не
// намагайся». sendMessage обидва випадки просто ковтає в лог.
export async function sendAlert(chatId, text) {
  try {
    const res = await post('/sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    });
    if (res.ok) return { ok: true };

    const body = await res.json().catch(() => ({}));
    if (res.status === 429) return { ok: false, retryAfter: body?.parameters?.retry_after ?? 5 };
    if (res.status === 403) return { ok: false, blocked: true };
    console.error(`sendAlert: HTTP ${res.status} ${redact(JSON.stringify(body).slice(0, 200))}`);
    return { ok: false };
  } catch (err) {
    console.error('sendAlert error:', redact(err.message));
    return { ok: false };
  }
}

export async function sendPhoto(chatId, imageBuffer, caption) {
  const { FormData, Blob } = await import('node-fetch');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'graph.png');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${TG_API}/sendPhoto`, {
      method: 'POST', body: form, signal: controller.signal,
    });
    if (!res.ok) throw new Error(`sendPhoto: HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendDocument(chatId, buffer, filename, caption) {
  const { FormData, Blob } = await import('node-fetch');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([buffer], { type: 'application/json' }), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${TG_API}/sendDocument`, {
      method: 'POST', body: form, signal: controller.signal,
    });
    if (!res.ok) throw new Error(`sendDocument: HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function answerCallbackQuery(callbackQueryId, text) {
  // Єдина функція без try/catch — виняток звідси вилітав у processUpdate.
  try {
    await post('/answerCallbackQuery', { callback_query_id: callbackQueryId, text });
  } catch (err) {
    console.error('answerCallbackQuery error:', redact(err.message));
  }
}

export async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const res = await post('/editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: replyMarkup,
  });
  if (!res.ok) console.error(`editMessageReplyMarkup: HTTP ${res.status}`);
}

export async function editMessageText(chatId, messageId, text) {
  const res = await post('/editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
  });
  if (!res.ok) console.error(`editMessageText: HTTP ${res.status}`);
}

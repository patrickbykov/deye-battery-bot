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

export async function answerCallbackQuery(callbackQueryId) {
  // Єдина функція без try/catch — виняток звідси вилітав у processUpdate.
  try {
    await post('/answerCallbackQuery', { callback_query_id: callbackQueryId });
  } catch (err) {
    console.error('answerCallbackQuery error:', redact(err.message));
  }
}

import fetch from 'node-fetch';
import { TG_API } from './config.js';

export async function sendMessage(chatId, text, options = {}) {
  try {
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...options
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('sendMessage failed:', errText);
    }
  } catch (err) {
    console.error('sendMessage error:', err);
  }
}

export async function answerCallbackQuery(callbackQueryId) {
  await fetch(`${TG_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId })
  });
}

export const CHECK = '☑️';
export const UNCHECK = '⬜';

// Текст кнопки Telegram обмежений, а дуже довгі назви ламають верстку.
const MAX_LABEL = 40;

// У callback_data їде rowid, а не id інвертора. Ліміт Telegram — 64 байти, і
// перевищення відхиляє клавіатуру ЦІЛКОМ, тихо. id — це серійник: сьогодні
// короткий, завтра ні. Заразом знімається питання регістру з задачі 10.
export function buildKeyboard(inverters, checkedIds) {
  if (!inverters?.length) return null;

  const checked = new Set(checkedIds ?? []);
  const rows = inverters.map(inverter => {
    const label = inverter.name?.length > MAX_LABEL
      ? inverter.name.slice(0, MAX_LABEL - 1) + '…'
      : (inverter.name ?? inverter.id);
    return [{
      text: `${checked.has(inverter.id) ? CHECK : UNCHECK} ${label}`,
      callback_data: `t:${inverter.rowid}`,
    }];
  });

  rows.push([{ text: '📨 Надіслати заявку', callback_data: 'req' }]);
  return { inline_keyboard: rows };
}

export function parseCallback(data) {
  const text = String(data ?? '');
  if (!text) return null;
  const separator = text.indexOf(':');
  return separator < 0
    ? { action: text, value: undefined }
    : { action: text.slice(0, separator), value: text.slice(separator + 1) };
}

// Стан галочок живе в самому повідомленні: callback_query приносить
// reply_markup, і зчитати позначені можна звідти. Отже поки заявку не
// надіслано, ні підписки, ні статус у БД не змінюються.
export function readChecked(replyMarkup) {
  const rows = replyMarkup?.inline_keyboard ?? [];
  const checked = [];
  for (const row of rows) {
    for (const button of row) {
      const parsed = parseCallback(button.callback_data);
      if (parsed?.action === 't' && button.text.startsWith(CHECK)) {
        checked.push(Number(parsed.value));
      }
    }
  }
  return checked;
}

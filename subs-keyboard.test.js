import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyboard, parseCallback, readChecked, CHECK, UNCHECK } from './subs-keyboard.js';

const inverters = [
  { rowid: 1, id: 'INV1', name: 'Будинок на Лесі Українки' },
  { rowid: 2, id: 'INV2', name: 'Склад' },
];

test('позначає обрані й лишає решту порожніми', () => {
  const kb = buildKeyboard(inverters, ['INV1']);
  assert.ok(kb.inline_keyboard[0][0].text.startsWith(CHECK));
  assert.ok(kb.inline_keyboard[1][0].text.startsWith(UNCHECK));
});

test('останнім рядком — кнопка заявки', () => {
  const kb = buildKeyboard(inverters, []);
  assert.equal(kb.inline_keyboard.at(-1)[0].callback_data, 'req');
});

test('callback_data вкладається в 64 байти навіть на довгих даних', () => {
  // Ліміт Telegram — 64 байти. Перевищення відхиляє клавіатуру ЦІЛКОМ, і збій
  // тихий. Саме тому в callback_data їде rowid, а не id інвертора.
  const many = Array.from({ length: 50 }, (_, i) => ({
    rowid: 100000 + i, id: 'X'.repeat(80), name: 'Довжелезна назва об’єкта '.repeat(4),
  }));
  for (const row of buildKeyboard(many, []).inline_keyboard) {
    for (const button of row) {
      assert.ok(Buffer.byteLength(button.callback_data) <= 64,
        `${button.callback_data} = ${Buffer.byteLength(button.callback_data)} байт`);
    }
  }
});

test('parseCallback розбирає префікс і значення', () => {
  assert.deepEqual(parseCallback('t:7'), { action: 't', value: '7' });
  assert.deepEqual(parseCallback('req'), { action: 'req', value: undefined });
  assert.deepEqual(parseCallback('a:ok:123'), { action: 'a', value: 'ok:123' });
  assert.equal(parseCallback(''), null);
});

test('стан читається назад із клавіатури — круговий рейс', () => {
  // Вибір живе в самому повідомленні, а не в БД: інакше схвалений користувач
  // втрачав би доступ уже за те, що відкрив екран.
  const kb = buildKeyboard(inverters, ['INV2']);
  assert.deepEqual(readChecked(kb), [2]);
});

test('порожній перелік не дає клавіатури без кнопок', () => {
  const kb = buildKeyboard([], []);
  assert.equal(kb, null);
});

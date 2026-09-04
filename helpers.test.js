import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, renderSocBar, redact, escapeHtml, batteryState, gridPresent, normalizeUsername, decisionMessage } from './helpers.js';

test('fmt повертає N/A для нечислового рядка, а не "NaN"', () => {
  assert.equal(fmt('abc'), 'N/A');
});

test('fmt форматує число із заданою точністю', () => {
  assert.equal(fmt(53.926, 2), '53.93');
});

test('renderSocBar не падає на SOC понад 100', () => {
  // Збої BMS з виходом SOC за діапазон — звичайна річ, а '░'.repeat(-1)
  // це RangeError, тобто /status падає замість відповіді.
  assert.equal(renderSocBar(105), '[██████████]');
});

test('renderSocBar не падає на відʼємному SOC', () => {
  assert.equal(renderSocBar(-5), '[░░░░░░░░░░]');
});

test('redact вирізає токен бота з тексту помилки', () => {
  // node-fetch вкладає повний URL у текст FetchError, а console.error цього
  // тексту стоїть у циклі, що б'ється в Telegram щосекунди. Один DNS-збій —
  // і токен бота лежить у логах Fly назавжди.
  const err = 'request to https://api.telegram.org/bot8123456:AAF-xY_z9Q/getUpdates?offset=1 failed';
  assert.equal(
    redact(err),
    'request to https://api.telegram.org/bot<REDACTED>/getUpdates?offset=1 failed'
  );
});

test('redact не чіпає текст без токена', () => {
  assert.equal(redact('Grafana query failed: 500'), 'Grafana query failed: 500');
});

test('escapeHtml знешкоджує кутові дужки й амперсанд', () => {
  // Ім'я користувача приходить з Telegram довільним Unicode: воно потрапляє
  // і в HTML адмінки, і в повідомлення з parse_mode HTML.
  assert.equal(escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('A & B'), 'A &amp; B');
  assert.equal(escapeHtml(null), '');
});

test('batteryState: мінус — заряд, плюс — розряд', () => {
  // Підтверджено вимірами 4 вер 2026: при незмінному SOC напруга на клемах
  // на 0.51 V вища на ділянках з відʼємною потужністю. Це падіння на
  // внутрішньому опорі при струмі, що тече В батарею. Початкове припущення
  // задачі 03 було оберненим.
  assert.equal(batteryState(-405), 'заряджається');
  assert.equal(batteryState(96), 'розряджається');
});

test('batteryState: близьке до нуля — не рух, а плавання', () => {
  // BMS постійно тримає малий трикл; називати ±3 Вт зарядом чи розрядом
  // означало б блимати підписом щоп'ять хвилин.
  assert.equal(batteryState(0), 'у спокої');
  assert.equal(batteryState(4), 'у спокої');
  assert.equal(batteryState(-4), 'у спокої');
});

test('batteryState: без значення — нічого не вигадуємо', () => {
  assert.equal(batteryState(null), null);
  assert.equal(batteryState('abc'), null);
});

test('gridPresent: 230 В — мережа є, нуль — немає', () => {
  assert.equal(gridPresent(237.3), true);
  assert.equal(gridPresent(0), false);
});

test('gridPresent: поріг той самий, що в правилі алерту', () => {
  // Якби поріг тут і в Grafana розійшлись, бот казав би «мережа є», поки
  // приходило б сповіщення про її зникнення.
  assert.equal(gridPresent(49), false);
  assert.equal(gridPresent(51), true);
});

test('gridPresent: без даних — не вигадуємо відповідь', () => {
  assert.equal(gridPresent(null), null);
  assert.equal(gridPresent(undefined), null);
  assert.equal(gridPresent('abc'), null);
});

test('normalizeUsername зрізає @ і зводить до нижнього регістру', () => {
  // Ніки в Telegram регістронезалежні, а зберігаємо ми їх як PRIMARY KEY
  // з BINARY-колацією: без нормалізації '@Petro' і 'petro' були б різними
  // записами, і запрошення не спрацювало б.
  assert.equal(normalizeUsername('@Petro_Bykov'), 'petro_bykov');
});

test('normalizeUsername терпить пробіли навколо', () => {
  assert.equal(normalizeUsername('  volunteer  '), 'volunteer');
});

test('normalizeUsername відхиляє нік, коротший за 5 символів', () => {
  assert.equal(normalizeUsername('abcd'), null);
});

test('normalizeUsername відхиляє нік, довший за 32 символи', () => {
  assert.equal(normalizeUsername('a'.repeat(33)), null);
});

test('normalizeUsername відхиляє нік, що починається не з літери', () => {
  assert.equal(normalizeUsername('1volunteer'), null);
});

test('normalizeUsername відхиляє недозволені символи', () => {
  // Порожній рядок і посилання: адмін цілком може вставити t.me/nick.
  assert.equal(normalizeUsername('t.me/volunteer'), null);
  assert.equal(normalizeUsername(''), null);
  assert.equal(normalizeUsername(null), null);
});

test('схвалення каже, що робити далі', () => {
  assert.match(decisionMessage('pending', 'approved'), /Доступ відкрито/);
  assert.match(decisionMessage('pending', 'approved'), /\/status/);
});

test('відмова новому лишає двері прочиненими', () => {
  // rejected означає «не зараз», а не «ніколи» — і людина має це чути.
  assert.match(decisionMessage('pending', 'rejected'), /відхилено/i);
  assert.match(decisionMessage('pending', 'rejected'), /\/subscribe/);
});

test('зняття доступу не плутають із відмовою за заявкою', () => {
  // Найважливіший випадок: підписник просто перестає отримувати попередження
  // про розряд. Без окремого тексту він вважатиме це поломкою, а не рішенням.
  const revoked = decisionMessage('approved', 'rejected');
  assert.match(revoked, /Доступ закрито/);
  assert.doesNotMatch(revoked, /Заявку відхилено/);
});

test('текст той самий незалежно від того, звідки натиснув адмін', () => {
  // Одне джерело на веб і на Telegram: інакше формулювання розійдуться,
  // і людина отримає різне за однакове рішення.
  assert.equal(decisionMessage('pending', 'approved'), decisionMessage('rejected', 'approved'));
});

test('рішення без зміни статусу не має тексту — писати нема про що', () => {
  assert.equal(decisionMessage('approved', 'approved'), null);
  assert.equal(decisionMessage('rejected', 'rejected'), null);
});

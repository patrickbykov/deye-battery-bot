import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePasswordHash, hashPassword, verifyPassword,
  signSession, verifySession, csrfToken, csrfValid, throttleDecision, deriveKeys,
} from './admin-auth.js';

test('розбирає валідний рядок хеша', () => {
  const parsed = parsePasswordHash('scrypt$16384$8$1$c2FsdA$aGFzaA');
  assert.equal(parsed.N, 16384);
  assert.equal(parsed.r, 8);
});

test('битий або відсутній хеш → null, а не виняток', () => {
  assert.equal(parsePasswordHash(''), null);
  assert.equal(parsePasswordHash(undefined), null);
  assert.equal(parsePasswordHash('scrypt$16384$8$c2FsdA$aGFzaA'), null, 'бракує сегмента');
  assert.equal(parsePasswordHash('bcrypt$16384$8$1$c2FsdA$aGFzaA'), null);
});

test('N поза межами відхиляється — інакше виняток у рантаймі', () => {
  // scrypt рахує 128·N·r; при N=32768 це 33.5 MB проти дефолтного maxmem 32 MB,
  // і crypto.scrypt кидає. На машині з 256 MB піднімати maxmem не варіант.
  assert.equal(parsePasswordHash('scrypt$32768$8$1$c2FsdA$aGFzaA'), null);
  assert.equal(parsePasswordHash('scrypt$512$8$1$c2FsdA$aGFzaA'), null);
});

test('правильний пароль проходить, неправильний — ні', async () => {
  const hash = await hashPassword('таємниця');
  assert.equal(await verifyPassword('таємниця', hash), true);
  assert.equal(await verifyPassword('інше', hash), false);
});

test('порожній ADMIN_PASSWORD_HASH нікого не пускає', async () => {
  // Забутий секрет не має відкривати адмінку «бо перевіряти нічим».
  assert.equal(await verifyPassword('що завгодно', undefined), false);
  assert.equal(await verifyPassword('що завгодно', ''), false);
});

const keys = deriveKeys('scrypt$16384$8$1$c2FsdA$aGFzaA');

test('сесійна cookie: круговий рейс', () => {
  const cookie = signSession({ sid: 'abc', exp: 2_000_000 }, keys.session);
  assert.deepEqual(verifySession(cookie, keys.session, 1_000_000_000), { sid: 'abc', exp: 2_000_000 });
});

test('зіпсована сигнатура не проходить', () => {
  const cookie = signSession({ sid: 'abc', exp: 2_000_000 }, keys.session);
  assert.equal(verifySession(cookie.slice(0, -2) + 'xx', keys.session, 1_000_000_000), null);
});

test('сигнатура іншої довжини дає null, а не виняток', () => {
  // timingSafeEqual кидає на різній довжині — підроблена cookie інакше
  // повертала б 500 замість 401.
  const cookie = signSession({ sid: 'abc', exp: 2_000_000 }, keys.session);
  assert.equal(verifySession(cookie.split('.')[0] + '.abc', keys.session, 1_000_000_000), null);
});

test('протермінована cookie не проходить', () => {
  const cookie = signSession({ sid: 'abc', exp: 1000 }, keys.session);
  assert.equal(verifySession(cookie, keys.session, 2_000_000), null);
});

test('cookie, підписана іншим ключем, не проходить', () => {
  const other = deriveKeys('scrypt$16384$8$1$aW5zaGU$aGFzaA');
  const cookie = signSession({ sid: 'abc', exp: 2_000_000 }, other.session);
  assert.equal(verifySession(cookie, keys.session, 1_000_000_000), null);
});

test('сміття замість cookie не валить перевірку', () => {
  for (const junk of ['', 'абв', '.', 'a.b.c', null]) {
    assert.equal(verifySession(junk, keys.session, 1000), null);
  }
});

test('CSRF: свій токен проходить, чужий — ні', () => {
  const token = csrfToken('sid-1', keys.csrf);
  assert.equal(csrfValid('sid-1', token, keys.csrf), true);
  assert.equal(csrfValid('sid-2', token, keys.csrf), false);
  assert.equal(csrfValid('sid-1', 'коротко', keys.csrf), false);
  assert.equal(csrfValid('sid-1', undefined, keys.csrf), false);
});

test('тротлінг: 5 спроб з адреси, шоста — ні', () => {
  const state = {};
  let now = 0;
  for (let i = 0; i < 5; i++) {
    assert.equal(throttleDecision(state, '1.1.1.1', now, {}).allowed, true, `спроба ${i + 1}`);
  }
  assert.equal(throttleDecision(state, '1.1.1.1', now, {}).allowed, false);
});

test('після вікна спроби знову дозволені', () => {
  const state = {};
  for (let i = 0; i < 6; i++) throttleDecision(state, '1.1.1.1', 0, {});
  assert.equal(throttleDecision(state, '1.1.1.1', 16 * 60_000, {}).allowed, true);
});

test('глобальний ліміт ловить перебір з різних адрес', () => {
  // Fly-Client-IP теоретично підмінний; без глобального лічильника ботнет
  // обходив би перший шар.
  const state = {};
  for (let i = 0; i < 20; i++) throttleDecision(state, `10.0.0.${i}`, 0, {});
  assert.equal(throttleDecision(state, '10.0.99.99', 0, {}).allowed, false);
});

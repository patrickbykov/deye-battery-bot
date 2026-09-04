import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute } from './http-router.js';

const h = name => () => name;
const routes = [
  { method: 'POST', path: '/hooks/grafana',    handler: h('hook') },
  { method: 'GET',  path: '/admin/users',      handler: h('users') },
  { method: 'POST', path: '/admin/users',      handler: h('save') },
  { method: 'GET',  path: '/admin/users/:id',  handler: h('one') },
];

test('знаходить точний збіг за методом і шляхом', () => {
  assert.equal(matchRoute(routes, 'GET', '/admin/users').handler(), 'users');
  assert.equal(matchRoute(routes, 'POST', '/admin/users').handler(), 'save');
});

test('витягує :param', () => {
  const m = matchRoute(routes, 'GET', '/admin/users/42');
  assert.equal(m.handler(), 'one');
  assert.deepEqual(m.params, { id: '42' });
});

test('невідомий шлях → null', () => {
  assert.equal(matchRoute(routes, 'GET', '/nope'), null);
});

test('відомий шлях з іншим методом → 405, а не 404', () => {
  // Різниця не косметична: 404 сказав би, що ендпойнта немає, і сховав
  // помилку в методі під виглядом помилки в адресі.
  assert.deepEqual(matchRoute(routes, 'DELETE', '/admin/users'), { methodMismatch: true });
});

test('корінь не матчиться жодним маршрутом', () => {
  // Health обробляється ДО роутера. Якби '/' сюди потрапляв, помилка в
  // таблиці маршрутів зробила б health не-200, і Fly почав би рестартити
  // єдину машину — а рестарт нічого не лікує.
  assert.equal(matchRoute(routes, 'GET', '/'), null);
});

test('слеш у кінці не впливає', () => {
  assert.equal(matchRoute(routes, 'GET', '/admin/users/').handler(), 'users');
});

test('зайвий сегмент не матчиться', () => {
  assert.equal(matchRoute(routes, 'GET', '/admin/users/42/extra'), null);
});

test('відхиляє . і .. у шляху', () => {
  assert.equal(matchRoute(routes, 'GET', '/admin/../admin/users'), null);
  assert.equal(matchRoute(routes, 'GET', '/admin/./users'), null);
});

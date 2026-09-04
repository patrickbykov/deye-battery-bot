import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginPage, usersPage } from './admin-views.js';

test('сторінка логіну не має JavaScript', () => {
  const html = loginPage({});
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /type="password"/);
});

test('сторінка логіну не приймає параметр next — open redirect не вартий зручності', () => {
  assert.doesNotMatch(loginPage({}), /next/i);
});

const users = [{
  chat_id: 42, username: 'petro', first_name: '<img src=x onerror=alert(1)>',
  status: 'pending', requested_at: '2026-09-04T06:00:00Z',
  inverters: [{ id: 'INV1', name: 'Перший & головний' }],
}];

test('ім’я з тегом рендериться як текст, а не виконується', () => {
  // Ім'я приходить з Telegram довільним Unicode: людина сама його обирає.
  const html = usersPage({ users, csrf: 'tok' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('амперсанд у назві об’єкта екранується', () => {
  assert.match(usersPage({ users, csrf: 'tok' }), /Перший &amp; головний/);
});

test('у розмітці немає жодного script', () => {
  assert.doesNotMatch(usersPage({ users, csrf: 'tok' }), /<script/i);
});

test('CSRF-токен присутній у формі', () => {
  assert.match(usersPage({ users, csrf: 'tok-123' }), /name="csrf" value="tok-123"/);
});

test('приховане known на кожен відрендерений рядок', () => {
  // Невідмічені чекбокси браузер не надсилає взагалі. Без known[] адмін, що
  // відкрив сторінку вчора й натиснув «Зберегти» сьогодні, зняв би схвалення
  // з усіх, кого схвалили за цей час.
  const html = usersPage({ users, csrf: 'tok' });
  assert.match(html, /name="known" value="42"/);
});

test('схвалений має відмічений чекбокс', () => {
  const approved = [{ ...users[0], status: 'approved' }];
  assert.match(usersPage({ users: approved, csrf: 't' }), /name="approve" value="42" checked/);
});

test('порожній список не ламає сторінку', () => {
  const html = usersPage({ users: [], csrf: 't' });
  assert.match(html, /Користувачів|немає/i);
});

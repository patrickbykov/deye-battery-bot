import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_MENU, ADMIN_MENU } from './menu.js';

test('меню адміна містить усе меню користувача', () => {
  // Меню зі scope chat ЗАМІНЮЄ типове для цього чату, а не доповнює:
  // без цього адмін втратив би /status у своєму меню.
  const admin = new Set(ADMIN_MENU.map(c => c.command));
  for (const { command } of USER_MENU) assert.ok(admin.has(command), command);
});

test('меню адміна має паузу й відновлення', () => {
  const admin = ADMIN_MENU.map(c => c.command);
  assert.ok(admin.includes('pause'));
  assert.ok(admin.includes('resume'));
});

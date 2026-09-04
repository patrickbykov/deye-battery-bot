import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginPage, usersPage, objectsPage } from './admin-views.js';

const users = [{
  chat_id: 42, username: 'petro', first_name: '<img src=x onerror=alert(1)>',
  status: 'pending', requested_at: '2026-09-04T06:00:00Z',
  inverters: [{ id: 'INV1', name: 'Перший & головний' }],
}];
const inverters = [
  { id: '2512151417', name: 'Клочківська 117' },
  { id: 'SN-2', name: 'SN-2' },
];

// --- Вхід ---

test('сторінка логіну не має JavaScript', () => {
  const html = loginPage({});
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /type="password"/);
});

test('сторінка логіну не приймає параметр next — open redirect не вартий зручності', () => {
  assert.doesNotMatch(loginPage({}), /next/i);
});

test('на сторінці логіну навігації немає — показувати нікуди', () => {
  assert.doesNotMatch(loginPage({}), /href="\/admin\/objects"/);
});

// --- Навігація ---

test('обидві сторінки ведуть одна до одної', () => {
  for (const html of [usersPage({ users, csrf: 't' }), objectsPage({ inverters, csrf: 't' })]) {
    assert.match(html, /href="\/admin\/users"/);
    assert.match(html, /href="\/admin\/objects"/);
  }
});

test('поточний розділ позначено, і він не посилається сам на себе', () => {
  assert.match(usersPage({ users, csrf: 't' }), /aria-current="page"[^>]*>\s*Користувачі/);
  assert.match(objectsPage({ inverters, csrf: 't' }), /aria-current="page"[^>]*>\s*Об/);
});

test('лічильник заявок видно і зі сторінки обʼєктів', () => {
  // Інакше адмін, що зайшов перейменувати обʼєкт, не побачить, що хтось чекає.
  const html = objectsPage({ inverters, csrf: 't', waiting: 3 });
  assert.match(html, /3/);
});

test('нуль заявок не малює порожній лічильник', () => {
  assert.doesNotMatch(objectsPage({ inverters, csrf: 't', waiting: 0 }), /class="badge"/);
});

test('вихід є на обох сторінках і захищений CSRF', () => {
  for (const html of [usersPage({ users, csrf: 'tok-9' }), objectsPage({ inverters, csrf: 'tok-9' })]) {
    assert.match(html, /action="\/admin\/logout"/);
    for (const form of html.split('<form').slice(1)) {
      assert.match(form, /name="csrf" value="tok-9"/);
    }
  }
});

// --- Користувачі ---

test('ім’я з тегом рендериться як текст, а не виконується', () => {
  const html = usersPage({ users, csrf: 'tok' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('амперсанд у назві обʼєкта екранується', () => {
  assert.match(usersPage({ users, csrf: 'tok' }), /Перший &amp; головний/);
});

test('у розмітці немає жодного script', () => {
  assert.doesNotMatch(usersPage({ users, csrf: 'tok' }), /<script/i);
  assert.doesNotMatch(objectsPage({ inverters, csrf: 'tok' }), /<script/i);
});

test('CSRF-токен присутній у формі', () => {
  assert.match(usersPage({ users, csrf: 'tok-123' }), /name="csrf" value="tok-123"/);
});

test('приховане known на кожен відрендерений рядок', () => {
  assert.match(usersPage({ users, csrf: 'tok' }), /name="known" value="42"/);
});

test('схвалений має відмічений чекбокс', () => {
  const approved = [{ ...users[0], status: 'approved' }];
  assert.match(usersPage({ users: approved, csrf: 't' }), /name="approve" value="42" checked/);
});

test('порожній список користувачів не ламає сторінку', () => {
  assert.match(usersPage({ users: [], csrf: 't' }), /Користувачів|немає/i);
});

// --- Обʼєкти ---

test('обʼєкти мають поле для назви з поточним значенням', () => {
  assert.match(objectsPage({ inverters, csrf: 'tok' }),
    /name="name:2512151417" value="Клочківська 117"/);
});

test('серійник видно поруч — за ним обʼєкт шукають у логах і в Grafana', () => {
  assert.match(objectsPage({ inverters, csrf: 'tok' }), /2512151417/);
});

test('назва обʼєкта екранується', () => {
  const evil = [{ id: 'X', name: '"><script>alert(1)</script>' }];
  const html = objectsPage({ inverters: evil, csrf: 'tok' });
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('без обʼєктів сторінка пояснює, звідки вони беруться', () => {
  const html = objectsPage({ inverters: [], csrf: 'tok' });
  assert.doesNotMatch(html, /name="name:/);
  assert.match(html, /колектор|InfluxDB|зʼявля/i);
});

// --- Запрошені ---

const invited = [{ username: 'volunteer', note: 'Клочківська, сусід' }];

test('форма запрошення є на сторінці користувачів', () => {
  const html = usersPage({ users, invited, csrf: 'tok' });
  assert.match(html, /action="\/admin\/invites"/);
  assert.match(html, /name="username"/);
});

test('запрошення видно разом із приміткою — щоб адмін памʼятав, кого кликав', () => {
  const html = usersPage({ users, invited, csrf: 'tok' });
  assert.match(html, /volunteer/);
  assert.match(html, /Клочківська, сусід/);
});

test('кожен запрошений має відмічений чекбокс — знятий прибирає його', () => {
  assert.match(usersPage({ users, invited, csrf: 'tok' }),
    /name="keep" value="volunteer" checked/);
});

test('форма запрошення є і тоді, коли користувачів ще немає', () => {
  // Саме тоді вона потрібна найбільше: кликати нікого, бо ніхто не писав.
  assert.match(usersPage({ users: [], invited: [], csrf: 'tok' }),
    /action="\/admin\/invites"/);
});

test('нік і примітка запрошеного екрануються', () => {
  const evil = [{ username: '<script>alert(1)</script>', note: '"><b>' }];
  const html = usersPage({ users, invited: evil, csrf: 'tok' });
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
});

test('помилка розбору ніка показується на самій сторінці', () => {
  const html = usersPage({ users, invited, csrf: 'tok', inviteError: 'Це не схоже на нік.' });
  assert.match(html, /Це не схоже на нік\./);
});

test('без запрошень секція пояснює, навіщо вона', () => {
  const html = usersPage({ users, invited: [], csrf: 'tok' });
  assert.doesNotMatch(html, /name="keep"/);
  assert.match(html, /автоматично/i);
});

test('сторінка користувачів лишається без JavaScript із секцією запрошень', () => {
  assert.doesNotMatch(usersPage({ users, invited, csrf: 'tok' }), /<script/i);
});

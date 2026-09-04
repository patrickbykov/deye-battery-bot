import { escapeHtml as esc, formatKyivTime } from './helpers.js';

// Нуль JavaScript і жодних CDN: сторінка має відкриватись із телефона в
// дорозі. Нуль JS заодно дозволяє CSP default-src 'none'.
const CSS = `
  body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:1rem;background:#111;color:#eee}
  h1{font-size:1.2rem;margin:0 0 1rem}
  table{border-collapse:collapse;width:100%}
  th,td{padding:.5rem;border-bottom:1px solid #333;text-align:left;vertical-align:top}
  th{font-size:.8rem;color:#999;text-transform:uppercase}
  .muted{color:#888;font-size:.85rem}
  .pending{color:#fb0} .approved{color:#5c5} .rejected{color:#c66}
  button{padding:.6rem 1rem;font-size:1rem;background:#25d;color:#fff;border:0;border-radius:6px}
  input[type=password]{padding:.6rem;font-size:1rem;width:100%;max-width:20rem;box-sizing:border-box}
`;

const page = (title, body) => `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>${body}</body></html>`;

export function loginPage({ error } = {}) {
  // Без параметра next: open redirect на публічному ендпойнті не вартий
  // зручності. Після входу — завжди /admin/users.
  return page('Вхід', `
    <h1>Адміністрування</h1>
    ${error ? `<p class="rejected">${esc(error)}</p>` : ''}
    <form method="post" action="/admin/login">
      <p><input type="password" name="password" autocomplete="current-password"
                placeholder="Пароль" autofocus required></p>
      <p><button type="submit">Увійти</button></p>
    </form>`);
}

export function usersPage({ users, csrf }) {
  if (!users.length) {
    return page('Користувачі', '<h1>Користувачі</h1><p class="muted">Користувачів ще немає.</p>');
  }

  const rows = users.map(user => {
    const label = user.username ? '@' + esc(user.username) : esc(user.first_name ?? user.chat_id);
    const objects = user.inverters.map(i => esc(i.name ?? i.id)).join(', ') || '—';
    return `<tr>
      <td><input type="checkbox" name="approve" value="${user.chat_id}"${user.status === 'approved' ? ' checked' : ''}></td>
      <td>${label}<div class="muted">${esc(user.first_name ?? '')} · ${user.chat_id}</div></td>
      <td>${objects}</td>
      <td class="muted">${esc(formatKyivTime(user.requested_at))}</td>
      <td class="${esc(user.status)}">${esc(user.status)}</td>
      <input type="hidden" name="known" value="${user.chat_id}">
    </tr>`;
  }).join('');

  return page('Користувачі', `
    <h1>Користувачі</h1>
    <form method="post" action="/admin/users">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <table>
        <tr><th></th><th>Користувач</th><th>Об’єкти</th><th>Заявка</th><th>Статус</th></tr>
        ${rows}
      </table>
      <p><button type="submit">Зберегти</button></p>
    </form>
    <form method="post" action="/admin/logout">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button type="submit">Вийти</button>
    </form>`);
}

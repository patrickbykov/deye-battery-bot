import { escapeHtml as esc } from './helpers.js';

// Нуль JavaScript і жодних зовнішніх ресурсів: сторінку відкривають з
// телефона, іноді під час відключення світла. Нуль JS заодно дозволяє
// тримати CSP на default-src 'none'.
const CSS = `
  :root{
    --paper:#eef1ec; --panel:#fff; --ink:#1e2621; --ink-2:#5a655e;
    --rule:#cfd6ce; --live:#1c7a4a; --wait:#a96a00; --off:#7e8a84;
    --focus:#1c5f7a;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --paper:#171c19; --panel:#1e2521; --ink:#e6ebe6; --ink-2:#9aa79f;
      --rule:#2f3a34; --live:#4cbb84; --wait:#d9a13c; --off:#7e8a84;
      --focus:#7cc6e6;
    }
  }
  *{box-sizing:border-box}
  body{
    margin:0;padding:1.5rem 1rem 4rem;background:var(--paper);color:var(--ink);
    font:16px/1.5 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;
  }
  .wrap{max-width:52rem;margin:0 auto}
  header{display:flex;align-items:baseline;justify-content:space-between;
    gap:1rem;flex-wrap:wrap;margin-bottom:1.75rem}
  h1{font-size:1.5rem;font-weight:650;letter-spacing:-.01em;margin:0}
  .tally{color:var(--ink-2);font-size:.95rem}
  .tally b{color:var(--wait);font-weight:650}

  .board{list-style:none;margin:0;padding:0;
    border:1px solid var(--rule);border-radius:10px;background:var(--panel);overflow:hidden}
  .line{display:grid;gap:.25rem .9rem;padding:.9rem 1rem;
    grid-template-columns:auto 1fr auto;align-items:start}
  .line + .line{border-top:1px solid var(--rule)}

  /* Лампа — індикатор стану, а не прикраса: колір несе інформацію. */
  .lamp{width:.6rem;height:.6rem;border-radius:50%;margin-top:.45rem;
    background:var(--off);box-shadow:0 0 0 3px color-mix(in srgb,var(--off) 18%,transparent)}
  .pending .lamp{background:var(--wait);box-shadow:0 0 0 3px color-mix(in srgb,var(--wait) 20%,transparent)}
  .approved .lamp{background:var(--live);box-shadow:0 0 0 3px color-mix(in srgb,var(--live) 20%,transparent)}

  .who{min-width:0}
  .nick{font-weight:600}
  .meta{color:var(--ink-2);font-size:.875rem}
  /* Моноширинний лише для ідентифікаторів: там важливе вирівнювання цифр. */
  .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;color:var(--ink-2)}
  .objects{grid-column:2;margin:.15rem 0 0;padding:0;list-style:none;
    display:flex;flex-wrap:wrap;gap:.3rem}
  .objects li{border:1px solid var(--rule);border-radius:999px;
    padding:.1rem .55rem;font-size:.8rem;color:var(--ink-2)}
  .state{grid-column:2;font-size:.8rem;margin-top:.25rem;
    display:flex;flex-wrap:wrap;gap:.1rem 1rem;color:var(--ink-2)}
  .state .now{color:var(--off)}
  .pending .state .now{color:var(--wait)}
  .approved .state .now{color:var(--live)}

  /* Перемикач — справжній checkbox: без JS він мусить лишатись доступним
     з клавіатури, тож фокус видно завжди. */
  .sw{grid-row:1/span 4;align-self:center;display:inline-flex;align-items:center;
    gap:.5rem;cursor:pointer;font-size:.85rem;color:var(--ink-2);white-space:nowrap}
  .sw input{appearance:none;-webkit-appearance:none;margin:0;
    width:2.6rem;height:1.5rem;border-radius:999px;border:1px solid var(--rule);
    background:color-mix(in srgb,var(--off) 22%,transparent);position:relative;
    transition:background .12s ease}
  .sw input::after{content:"";position:absolute;top:.15rem;left:.18rem;
    width:1.05rem;height:1.05rem;border-radius:50%;background:var(--panel);
    box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .12s ease}
  .sw input:checked{background:var(--live);border-color:var(--live)}
  .sw input:checked::after{transform:translateX(1.05rem)}
  .sw input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){.sw input,.sw input::after{transition:none}}

  .actions{display:flex;gap:.75rem;align-items:center;margin-top:1.25rem;flex-wrap:wrap}
  button{font:inherit;font-weight:600;padding:.65rem 1.1rem;border-radius:8px;
    border:1px solid var(--live);background:var(--live);color:#fff;cursor:pointer}
  button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
  .ghost button{background:transparent;color:var(--ink-2);border-color:var(--rule)}
  .empty{border:1px dashed var(--rule);border-radius:10px;padding:2rem 1.25rem;
    color:var(--ink-2);text-align:center}

  .login{max-width:22rem;margin:12vh auto 0}
  .login p{margin:0 0 1rem}
  input[type=password]{font:inherit;width:100%;padding:.7rem .8rem;border-radius:8px;
    border:1px solid var(--rule);background:var(--panel);color:var(--ink)}
  input[type=password]:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
  .error{color:var(--wait)}
  @media (max-width:34rem){
    .line{grid-template-columns:auto 1fr}
    .sw{grid-row:auto;grid-column:2;justify-self:start;margin-top:.5rem}
  }
`;

const page = (title, body) => `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;

// Дата без секунд і без року: рішення ухвалюють за свіжістю заявки, а не
// за точним часом.
function whenApplied(value) {
  if (!value) return 'заявки ще не було';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'заявки ще не було';
  return 'заявка ' + date.toLocaleString('uk-UA', {
    timeZone: 'Europe/Kyiv', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
}

const STATE_LABEL = { pending: 'чекає рішення', approved: 'має доступ', rejected: 'без доступу' };

export function loginPage({ error } = {}) {
  // Без параметра next: open redirect на публічному ендпойнті не вартий
  // зручності. Після входу — завжди /admin/users.
  return page('Вхід', `<div class="login">
    <h1>Доступ до об’єктів</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : '<p class="tally">Введіть пароль адміністратора.</p>'}
    <form method="post" action="/admin/login">
      <p><input type="password" name="password" autocomplete="current-password"
                aria-label="Пароль" autofocus required></p>
      <p><button type="submit">Увійти</button></p>
    </form>
  </div>`);
}

export function usersPage({ users, csrf }) {
  const waiting = users.filter(u => u.status === 'pending').length;

  const tally = users.length === 0 ? ''
    : waiting > 0
      ? `<p class="tally"><b>${waiting}</b> ${waiting === 1 ? 'заявка чекає' : 'заявок чекає'} рішення</p>`
      : '<p class="tally">Усі заявки розглянуті</p>';

  if (users.length === 0) {
    return page('Доступ', `
      <header><h1>Доступ до об’єктів</h1></header>
      <p class="empty">Користувачів ще немає.<br>Вони з’являються тут, щойно надішлють заявку боту.</p>`);
  }

  const lines = users.map(user => {
    const nick = user.username ? '@' + esc(user.username) : esc(user.first_name ?? 'без імені');
    const objects = user.inverters.length
      ? `<ul class="objects">${user.inverters.map(i => `<li>${esc(i.name ?? i.id)}</li>`).join('')}</ul>`
      : '<ul class="objects"><li>об’єктів не обрано</li></ul>';

    return `<li class="line ${esc(user.status)}">
      <span class="lamp" aria-hidden="true"></span>
      <div class="who">
        <div class="nick">${nick}</div>
        <div class="meta">${esc(user.first_name ?? '')} <span class="id">${user.chat_id}</span></div>
      </div>
      <label class="sw">
        <input type="checkbox" name="approve" value="${user.chat_id}"${user.status === 'approved' ? ' checked' : ''}>
        <span>Доступ</span>
      </label>
      ${objects}
      <div class="state">
        <span class="now">${esc(STATE_LABEL[user.status] ?? user.status)}</span>
        <span>${esc(whenApplied(user.requested_at))}</span>
      </div>
      <input type="hidden" name="known" value="${user.chat_id}">
    </li>`;
  }).join('');

  return page('Доступ', `
    <header>
      <h1>Доступ до об’єктів</h1>
      ${tally}
    </header>
    <form method="post" action="/admin/users">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <ul class="board">${lines}</ul>
      <div class="actions">
        <button type="submit">Зберегти рішення</button>
        <span class="tally">Вимкнений перемикач знімає доступ.</span>
      </div>
    </form>
    <form class="actions ghost" method="post" action="/admin/logout">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button type="submit">Вийти</button>
    </form>`);
}

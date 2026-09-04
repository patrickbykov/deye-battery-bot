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
  /* Flex, а не grid: рядок має рівно три частини й жодних вимог до
     вирівнювання по колонках між рядками. Grid тут лише плутав розкладку. */
  .line{display:flex;align-items:flex-start;gap:.9rem;padding:.95rem 1rem}
  .line + .line{border-top:1px solid var(--rule)}
  .body{flex:1 1 auto;min-width:0}

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
  .objects{margin:.4rem 0 0;padding:0;list-style:none;
    display:flex;flex-wrap:wrap;gap:.3rem}
  .objects li{border:1px solid var(--rule);border-radius:999px;
    padding:.1rem .55rem;font-size:.8rem;color:var(--ink-2)}
  .when{font-size:.8rem;margin-top:.35rem;color:var(--ink-2)}

  /* Перемикач — справжній checkbox: без JS він мусить лишатись доступним
     з клавіатури, тож фокус видно завжди. */
  /* Стан і рішення — одне й те саме, тож підпис перемикача і є станом.
     Окремий рядок «чекає рішення» лише дублював би лампу. */
  .sw{flex:0 0 auto;align-self:center;display:flex;flex-direction:column;
    align-items:center;gap:.35rem;cursor:pointer;font-size:.75rem;
    color:var(--off);white-space:nowrap}
  .pending .sw{color:var(--wait)}
  .approved .sw{color:var(--live)}
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

  /* Навігація на два розділи: вкладки, не бічна панель. Сайдбар на дві
     сторінки — це меблі заради меблів, і на телефоні він лише відбирає місце. */
  nav{display:flex;align-items:center;gap:1.25rem;margin:0 0 1.75rem;
    border-bottom:1px solid var(--rule);padding-bottom:.6rem;flex-wrap:wrap}
  nav a{color:var(--ink-2);text-decoration:none;padding:.15rem 0;
    border-bottom:2px solid transparent;display:inline-flex;align-items:center;gap:.4rem}
  nav a:hover{color:var(--ink)}
  nav a[aria-current]{color:var(--ink);font-weight:600;border-bottom-color:var(--live)}
  nav a:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
  nav .spacer{flex:1 1 auto}
  nav form{margin:0}
  nav button{background:transparent;color:var(--ink-2);border-color:var(--rule);
    padding:.35rem .7rem;font-size:.85rem;font-weight:500}
  .badge{background:var(--wait);color:#1b1300;border-radius:999px;
    padding:0 .4rem;font-size:.75rem;font-weight:650;line-height:1.35}

  h2{font-size:1.05rem;font-weight:650;margin:2.5rem 0 .35rem}
  .hint{color:var(--ink-2);font-size:.875rem;margin:0 0 .9rem}
  .obj{display:flex;align-items:center;gap:.9rem;padding:.75rem 1rem}
  .obj + .obj{border-top:1px solid var(--rule)}
  .obj input[type=text]{font:inherit;flex:1 1 auto;min-width:0;padding:.5rem .65rem;
    border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)}
  .obj input[type=text]:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
  .obj .id{flex:0 0 auto}

  /* Запрошення: чекбокс «лишити» замість окремої кнопки видалення на
     кожен рядок. Той самий жест, що й перемикач доступу вище на сторінці. */
  .keep{display:flex;align-items:center;gap:.55rem;cursor:pointer;flex:0 0 auto}
  .keep input{appearance:auto;width:1.1rem;height:1.1rem;margin:0;accent-color:var(--live)}
  .keep input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
  .obj .note{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;
    color:var(--ink-2);font-size:.875rem}
  .obj.new{gap:.6rem;flex-wrap:wrap}
  .obj.new input[type=text]{flex:1 1 9rem}

  .login{max-width:22rem;margin:12vh auto 0}
  .login h1{margin-bottom:1.5rem}
  .login label{display:block;font-size:.85rem;color:var(--ink-2);margin-bottom:.35rem}
  .login p{margin:0 0 1rem}
  input[type=password]{font:inherit;width:100%;padding:.7rem .8rem;border-radius:8px;
    border:1px solid var(--rule);background:var(--panel);color:var(--ink)}
  input[type=password]:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
  .error{color:var(--wait)}
  @media (max-width:34rem){
    /* width:100% змушує перемикач переноситись на власний рядок завжди.
       Без цього він втискався збоку у вузьких рядках і з'їжджав під низ
       у широких — сусідні рядки виглядали по-різному. */
    .line{flex-wrap:wrap}
    .sw{flex-direction:row;align-self:flex-start;width:100%;
        justify-content:flex-start;margin-left:1.5rem;gap:.6rem}
  }
`;

const page = (title, body) => `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`;

// Лічильник заявок висить у навігації, а не лише на сторінці користувачів:
// адмін, що зайшов перейменувати обʼєкт, інакше не побачив би, що хтось чекає.
function nav(current, csrf, waiting = 0) {
  const link = (href, label, extra = '') =>
    `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>
       ${label}${extra}</a>`;
  const badge = waiting > 0 ? ` <span class="badge">${waiting}</span>` : '';

  return `<nav>
    ${link('/admin/users', 'Користувачі', badge)}
    ${link('/admin/objects', 'Обʼєкти')}
    <span class="spacer"></span>
    <form method="post" action="/admin/logout">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <button type="submit">Вийти</button>
    </form>
  </nav>`;
}

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

const STATE_LABEL = { pending: 'чекає', approved: 'має доступ', rejected: 'без доступу' };

// Українська множина: 1 заявка, 2-4 заявки, 5+ заявок.
function plural(n, one, few, many) {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

export function loginPage({ error } = {}) {
  // Без параметра next: open redirect на публічному ендпойнті не вартий
  // зручності. Після входу — завжди /admin/users.
  return page('Вхід', `<div class="login">
    <h1>Доступ до об’єктів</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form method="post" action="/admin/login">
      <p>
        <label for="pw">Пароль адміністратора</label>
        <input id="pw" type="password" name="password" autocomplete="current-password"
               autofocus required>
      </p>
      <p><button type="submit">Увійти</button></p>
    </form>
  </div>`);
}

export function objectsPage({ inverters, csrf, waiting = 0 }) {
  const body = !inverters?.length
    ? `<p class="empty">Обʼєктів ще немає.<br>
         Вони зʼявляються самі, щойно колектор запише перші дані в InfluxDB.</p>`
    : `<p class="hint">Назву бачать користувачі — у списку підписок і в сповіщеннях.
         Порожнє поле поверне серійник.</p>
       <form method="post" action="/admin/inverters">
         <input type="hidden" name="csrf" value="${esc(csrf)}">
         <ul class="board">${inverters.map(inv => `<li class="obj">
           <span class="id">${esc(inv.id)}</span>
           <input type="text" name="name:${esc(inv.id)}" value="${esc(inv.name ?? inv.id)}"
                  aria-label="Назва обʼєкта ${esc(inv.id)}" maxlength="60">
         </li>`).join('')}</ul>
         <div class="actions"><button type="submit">Зберегти назви</button></div>
       </form>`;

  // Серійник лишається видимим: саме за ним обʼєкт шукають у Grafana й у логах.
  return page('Обʼєкти', `
    ${nav('/admin/objects', csrf, waiting)}
    <header><h1>Обʼєкти</h1></header>
    ${body}`);
}

// Секція, а не третя вкладка: кілька ніків не варті власної сторінки, а
// стоять вони там само, де адмін і так вирішує про доступ.
function invitedSection({ invited = [], csrf, error }) {
  const rows = invited.map(inv => `<li class="obj">
    <label class="keep">
      <input type="checkbox" name="keep" value="${esc(inv.username)}" checked
             aria-label="Лишити запрошення для ${esc('@' + inv.username)}">
      <span class="nick">@${esc(inv.username)}</span>
    </label>
    <span class="note">${esc(inv.note ?? '')}</span>
  </li>`).join('');

  return `<h2>Запрошені</h2>
    <p class="hint">Коли людина з таким ніком надішле заявку, її схвалять
      автоматично. Спрацьовує один раз: наступна зміна набору обʼєктів
      піде на розгляд, як у всіх.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form method="post" action="/admin/invites">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      <ul class="board">${rows}<li class="obj new">
        <input type="text" name="username" placeholder="@нік у Telegram"
               aria-label="Нік у Telegram" maxlength="33" autocomplete="off">
        <input type="text" name="note" placeholder="навіщо — щоб не забути"
               aria-label="Примітка" maxlength="60" autocomplete="off">
      </li></ul>
      <div class="actions">
        <button type="submit">Зберегти запрошення</button>
        ${rows ? '<span class="tally">Знятий чекбокс прибирає запрошення.</span>' : ''}
      </div>
    </form>`;
}

export function usersPage({ users, invited = [], csrf, inviteError }) {
  const waiting = users.filter(u => u.status === 'pending').length;
  const invites = invitedSection({ invited, csrf, error: inviteError });

  const tally = users.length === 0 ? ''
    : waiting > 0
      ? `<p class="tally"><b>${waiting}</b> ${plural(waiting, 'заявка чекає', 'заявки чекають', 'заявок чекають')} рішення</p>`
      : '<p class="tally">Усі заявки розглянуті</p>';

  // Запрошення потрібне й тоді, коли користувачів ще немає — власне, тоді
  // найбільше: писати боту нікому, бо про нього ще ніхто не знає.
  if (users.length === 0) {
    return page('Користувачі', `
      ${nav('/admin/users', csrf, 0)}
      <header><h1>Користувачі</h1></header>
      <p class="empty">Користувачів ще немає.<br>Вони з’являються тут, щойно надішлють заявку боту.</p>
      ${invites}`);
  }

  const lines = users.map(user => {
    const nick = user.username ? '@' + esc(user.username) : esc(user.first_name ?? 'без імені');
    const objects = user.inverters.length
      ? `<ul class="objects">${user.inverters.map(i => `<li>${esc(i.name ?? i.id)}</li>`).join('')}</ul>`
      : '<ul class="objects"><li>об’єктів не обрано</li></ul>';

    const plain = user.username ? '@' + user.username : (user.first_name ?? String(user.chat_id));
    // Ім'я в підписі лише тоді, коли заголовок — нік. Інакше воно дублювало б
    // сам заголовок.
    const meta = user.username && user.first_name
      ? `${esc(user.first_name)} <span class="id">${user.chat_id}</span>`
      : `<span class="id">${user.chat_id}</span>`;
    return `<li class="line ${esc(user.status)}">
      <span class="lamp" aria-hidden="true"></span>
      <div class="body">
        <div class="nick">${nick}</div>
        <div class="meta">${meta}</div>
        ${objects}
        <div class="when">${esc(whenApplied(user.requested_at))}</div>
      </div>
      <label class="sw">
        <input type="checkbox" name="approve" value="${user.chat_id}"${user.status === 'approved' ? ' checked' : ''}
               aria-label="Доступ для ${esc(plain)}">
        <span>${esc(STATE_LABEL[user.status] ?? user.status)}</span>
      </label>
      <input type="hidden" name="known" value="${user.chat_id}">
    </li>`;
  }).join('');

  return page('Користувачі', `
    ${/* Бейдж потрібен, щоб побачити заявки з іншої сторінки. Тут їх видно
         й так, а заголовок каже це точніше за голе число. */ ''}
    ${nav('/admin/users', csrf, 0)}
    <header>
      <h1>Користувачі</h1>
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
    ${invites}
`);
}

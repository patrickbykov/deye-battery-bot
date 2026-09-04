import { randomBytes } from 'node:crypto';
import { readBody } from './http-server.js';
import { normalizeUsername } from './helpers.js';
import { loginPage, usersPage, objectsPage } from './admin-views.js';
import {
  verifyPassword, deriveKeys, signSession, verifySession, csrfToken, csrfValid, throttleDecision,
} from './admin-auth.js';

const COOKIE = 'deye_admin';
const SESSION_TTL_S = 8 * 3600;
const FORM_LIMIT = 16 * 1024;
// scrypt тримає ~16.8 MB на виклик. Десять паралельних логінів — це 168 MB
// на машині з 256 MB, тобто OOM-kill і мовчазний бот. Тому по одному.
let scryptBusy = false;

const html = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
};
const redirect = (res, location, headers = {}) => {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
};

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function readForm(req) {
  const body = (await readBody(req, { limitBytes: FORM_LIMIT })).toString();
  const params = new URLSearchParams(body);
  return { get: name => params.get(name), all: name => params.getAll(name) };
}

export function createAdminRoutes({ store, passwordHash, log, now = Date.now }) {
  const keys = deriveKeys(passwordHash);
  const throttle = {};

  const session = req => verifySession(readCookie(req, COOKIE), keys.session, now());

  // Cookie тільки для /admin: у вебхук і health вона не поїде.
  // SameSite=Lax, а не Strict — Strict не шле cookie при переході за
  // посиланням з Telegram, і адмін бачив би форму логіну щоразу.
  const setCookie = value =>
    `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=${SESSION_TTL_S}`;

  function guard(handler) {
    return async (req, res, ctx) => {
      const payload = session(req);
      if (!payload) return redirect(res, '/admin');
      await handler(req, res, { ...ctx, session: payload });
    };
  }

  return [
    { method: 'GET', path: '/admin', handler: async (req, res) => {
      if (session(req)) return redirect(res, '/admin/users');
      html(res, 200, loginPage({}));
    } },

    { method: 'POST', path: '/admin/login', handler: async (req, res) => {
      const ip = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown').split(',').pop().trim();
      const decision = throttleDecision(throttle, ip, now(), {});
      if (!decision.allowed) {
        log.warn('Адмінка: перебір, відмова');
        return html(res, 429, loginPage({ error: 'Забагато спроб. Спробуйте пізніше.' }),
          { 'Retry-After': String(decision.retryAfterSec) });
      }
      if (scryptBusy) return html(res, 503, loginPage({ error: 'Зайнято, спробуйте ще раз.' }));

      const form = await readForm(req);
      scryptBusy = true;
      let ok;
      try {
        ok = await verifyPassword(form.get('password'), passwordHash);
      } finally {
        scryptBusy = false;
      }

      if (!ok) {
        // Пароля в логах не буває: люди промахуються полем.
        log.warn('Адмінка: невдалий вхід');
        return html(res, 401, loginPage({ error: 'Невірний пароль.' }));
      }

      const cookie = signSession(
        { sid: randomBytes(16).toString('base64url'), exp: Math.floor(now() / 1000) + SESSION_TTL_S },
        keys.session
      );
      redirect(res, '/admin/users', { 'Set-Cookie': setCookie(cookie) });
    } },

    { method: 'GET', path: '/admin/users', handler: guard(async (req, res, { session: s }) => {
      html(res, 200, usersPage({
        users: store.listUsersWithSubscriptions(),
        invited: store.listInvited(),
        csrf: csrfToken(s.sid, keys.csrf),
      }));
    }) },

    { method: 'GET', path: '/admin/objects', handler: guard(async (req, res, { session: s }) => {
      html(res, 200, objectsPage({
        inverters: store.getAllInverters(),
        waiting: store.countPendingUsers(),
        csrf: csrfToken(s.sid, keys.csrf),
      }));
    }) },

    { method: 'POST', path: '/admin/inverters', handler: guard(async (req, res, { session: s }) => {
      const form = await readForm(req);
      if (!csrfValid(s.sid, form.get('csrf'), keys.csrf)) {
        return html(res, 403, '<p>Недійсний токен форми. Оновіть сторінку.</p>');
      }
      // Перейменовуємо лише те, що справді змінилось: інакше кожне збереження
      // писало б у всі рядки й забруднювало лог.
      for (const inverter of store.getAllInverters()) {
        const wanted = String(form.get(`name:${inverter.id}`) ?? '').trim() || inverter.id;
        if (wanted !== inverter.name) {
          store.renameInverter(inverter.id, wanted);
          log.info(`Адмінка: обʼєкт ${inverter.id} → «${wanted}»`);
        }
      }
      redirect(res, '/admin/objects');
    }) },

    { method: 'POST', path: '/admin/users', handler: guard(async (req, res, { session: s }) => {
      const form = await readForm(req);
      if (!csrfValid(s.sid, form.get('csrf'), keys.csrf)) {
        return html(res, 403, '<p>Недійсний токен форми. Оновіть сторінку.</p>');
      }

      // Невідмічені чекбокси браузер не надсилає взагалі. Без known[] адмін,
      // що відкрив сторінку вчора, зняв би схвалення з усіх, кого схвалили
      // за цей час.
      const known = new Set(form.all('known').map(Number));
      const approved = new Set(form.all('approve').map(Number));
      for (const chatId of known) {
        const wanted = approved.has(chatId) ? 'approved' : 'rejected';
        if (store.getUser(chatId)?.status !== wanted) {
          store.setUserStatus(chatId, wanted, 'web');
          log.info(`Адмінка: chat:${chatId} → ${wanted}`);
        }
      }
      redirect(res, '/admin/users');
    }) },

    { method: 'POST', path: '/admin/invites', handler: guard(async (req, res, { session: s }) => {
      const form = await readForm(req);
      if (!csrfValid(s.sid, form.get('csrf'), keys.csrf)) {
        return html(res, 403, '<p>Недійсний токен форми. Оновіть сторінку.</p>');
      }

      // Розбір ДО будь-якого запису: інакше сторінка з помилкою показувала б
      // список, у якому зняті чекбокси вже спрацювали, а нік — ні.
      const raw = String(form.get('username') ?? '').trim();
      const username = raw === '' ? null : normalizeUsername(raw);
      if (raw !== '' && !username) {
        return html(res, 400, usersPage({
          users: store.listUsersWithSubscriptions(),
          invited: store.listInvited(),
          csrf: csrfToken(s.sid, keys.csrf),
          inviteError: `«${raw}» не схоже на нік у Telegram: 5–32 символи, `
            + 'літери, цифри й підкреслення, починається з літери.',
        }));
      }

      // Знятий чекбокс прибирає запрошення. Звіряємось із тим, що зараз у БД,
      // а не з прихованим списком: запрошення, витрачене чиєюсь заявкою поки
      // сторінка була відкрита, вже зникло, і прибирати його нема потреби.
      // Нік із цієї ж форми в keep[] відсутній за побудовою, тож додаємо
      // його ПІСЛЯ прибирання — інакше форма з'їдала б власний внесок.
      const keep = new Set(form.all('keep'));
      for (const invite of store.listInvited()) {
        if (keep.has(invite.username)) continue;
        store.removeInvited(invite.username);
        log.info(`Адмінка: запрошення @${invite.username} прибрано`);
      }

      if (username) {
        store.addInvited(username, String(form.get('note') ?? '').trim() || null);
        log.info(`Адмінка: запрошено @${username}`);
      }
      redirect(res, '/admin/users');
    }) },

    { method: 'POST', path: '/admin/logout', handler: guard(async (req, res, { session: s }) => {
      const form = await readForm(req);
      if (!csrfValid(s.sid, form.get('csrf'), keys.csrf)) return html(res, 403, '<p>Недійсний токен.</p>');
      redirect(res, '/admin', { 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0` });
    }) },

    { method: 'GET', path: '/admin/export.json', handler: guard(async (req, res) => {
      // Бекап у один клік: підписки й рішення про доступ — єдиний
      // невідновлюваний стан у системі.
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="deye-backup.json"',
      });
      res.end(JSON.stringify(store.exportAll(), null, 2));
    }) },
  ];
}

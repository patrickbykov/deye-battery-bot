import { createHash } from 'node:crypto';
import { withRetry } from './retry.js';

// Коди, що означають «токен більше не годиться». Приходять з HTTP 200 —
// у Deye Cloud геть усі відповіді успішні на рівні статусу, розрізняти
// треба тільки за тілом (див. docs/deye-cloud-api.md).
const TOKEN_REJECTED = new Set(['2101019', '2101017']);

// Логінимось наново за добу до протухання. Виділеного refresh-ендпойнта
// немає, а refreshToken має той самий exp, що й access — тож єдиний
// підтверджений спосіб продовжити доступ це повторний повний логін.
const REFRESH_MARGIN_MS = 24 * 3600 * 1000;

const REQUEST_TIMEOUT_MS = 30_000;

// Перевірено живим запитом: size > 50 дає 400 `2101006 size max 50`.
const PAGE_SIZE = 50;

export function createDeyeClient({
  baseUrl, appId, appSecret, email, password,
  fetchFn = globalThis.fetch, now = Date.now, sleep,
}) {
  const passwordHash = createHash('sha256').update(password).digest('hex');
  let cached = null; // { token, expiresAtMs }

  async function post(path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `bearer ${token}`;

    // Ретраїмо лише кинуті помилки — мережу й таймаути. Ділові відмови Deye
    // повертаються тілом і від повторення валідними не стануть.
    // Усі виклики тут — читання, тож повтор POST безпечний.
    const res = await withRetry(async () => {
      // Без таймаута зависла сесія блокує цикл назавжди — саме так помер бот.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await fetchFn(`${baseUrl}${path}`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    }, { sleep });

    // Статус не є ознакою успіху: помилки автентифікації Deye віддає з 200,
    // а помилки валідації параметрів — з 400, і в обох випадках справжня
    // причина лежить у тілі. Тому парсимо тіло завжди, а статус згадуємо
    // лише коли тіла немає (5xx, проксі, обрив).
    try {
      return await res.json();
    } catch {
      throw new Error(`Deye ${path}: HTTP ${res.status}, тіло не JSON`);
    }
  }

  async function login() {
    const body = await post(`/account/token?appId=${appId}`, {
      appSecret, email, companyId: '0', password: passwordHash,
    });
    if (!body.success) {
      // Ні appSecret, ні пароля тут бути не може — лише код і повідомлення Deye.
      throw new Error(`Deye login відхилено: code=${body.code} msg=${body.msg}`);
    }
    cached = {
      token: body.accessToken,
      expiresAtMs: now() + Number(body.expiresIn) * 1000,
    };
    return cached.token;
  }

  async function token() {
    if (cached && now() < cached.expiresAtMs - REFRESH_MARGIN_MS) return cached.token;
    return login();
  }

  // Токен може перестати годитись і до формального кінця строку — зміна
  // пароля, ротація секрету, розбіжність годинників. Тому крім проактивного
  // оновлення за строком є реактивне: один ре-логін і одна повторна спроба.
  async function authorized(path, body) {
    let res = await post(path, body, await token());

    if (!res.success && TOKEN_REJECTED.has(res.code)) {
      cached = null;
      // Саме одна: якщо доступ справді відкликано, нескінченний цикл
      // логінів гірший за чесну помилку.
      res = await post(path, body, await token());
    }

    if (!res.success) {
      throw new Error(`Deye ${path}: code=${res.code} msg=${res.msg}`);
    }
    return res;
  }

  async function getLatest(deviceSns) {
    const res = await authorized('/device/latest', { deviceList: deviceSns });
    return res.deviceDataList ?? [];
  }

  // Логер (COLLECTOR) і окремі банки (BATTERY) власної телеметрії не віддають —
  // усі метрики батареї лежать у відповіді самого інвертора.
  async function listInverterSns() {
    const sns = [];
    for (let page = 1; ; page++) {
      const res = await authorized('/station/listWithDevice',
                                   { page, size: PAGE_SIZE, deviceType: 'INVERTER' });
      const stations = res.stationList ?? [];
      sns.push(...stations
        .flatMap(station => station.deviceListItems ?? [])
        .filter(device => device.deviceType === 'INVERTER')
        .map(device => device.deviceSn));

      if (stations.length === 0 || page * PAGE_SIZE >= (res.stationTotal ?? 0)) return sns;
    }
  }

  return { getLatest, listInverterSns };
}

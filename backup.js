import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_PREFIX = 'backup-';
export const BACKUP_INTERVAL_MS = 24 * 3600_000;

// Підписки й рішення про доступ — єдиний невідновлюваний стан у системі.
// Інвертори перевідкриються з InfluxDB, метрики живуть там, алерти в Grafana.
// Втрата волюма без бекапу = всі знову pending, і адмін схвалює наосліп.
export function createBackup({ store, dir, keep = 7, log, now = () => new Date() }) {
  function runOnce() {
    try {
      const date = now().toISOString().slice(0, 10);
      const target = path.join(dir, `${BACKUP_PREFIX}${date}.db`);

      // VACUUM INTO робить узгоджену копію на живій БД — на відміну від
      // копіювання файлу, яке в WAL дало б рвану картину.
      fs.rmSync(target, { force: true });
      store.raw.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

      // Щойно створену копію не видаляємо ніколи. Просте «лишити keep
      // найновіших за іменем» видалило б її, якби в теці опинився файл з
      // пізнішою датою — збій годинника, ручна копія, відновлення з архіву.
      const current = path.basename(target);
      const others = fs.readdirSync(dir)
        .filter(f => f.startsWith(BACKUP_PREFIX) && f !== current)
        .sort();

      for (const stale of others.slice(0, Math.max(0, others.length - (keep - 1)))) {
        fs.rmSync(path.join(dir, stale), { force: true });
      }
      log.info(`Бекап: ${current}, копій лишилось ${Math.min(others.length + 1, keep)}`);
    } catch (err) {
      // Збій бекапу — привід для логу, а не для падіння бота.
      log.error(`Бекап не вдався: ${err.message}`);
    }
  }

  return { runOnce };
}

// Копія на волюмі не рятує від втрати самого волюма, а він прив'язаний до
// одного хоста. Раз на тиждень той самий дамп їде в чат адміна — позасмугово,
// туди, куди Fly не дістає.
export const EXPORT_MARKER = 'last-export';
export const EXPORT_INTERVAL_MS = 7 * 24 * 3600_000;

// Відлік живе на диску, а не в setInterval. Процес рестартує на кожному
// деплої, SIGTERM від Fly і спрацюванні вотчдога — таймер у памʼяті щоразу
// починався б з нуля, і тижневий строк не настав би ніколи.
export function createWeeklyExport({
  store, dir, sendDocument, chatId, log, now = () => Date.now(),
}) {
  const markerPath = path.join(dir, EXPORT_MARKER);

  function lastSentAt() {
    try {
      const parsed = Date.parse(fs.readFileSync(markerPath, 'utf8').trim());
      // Битий маркер (обірваний запис, ручне редагування) не має означати,
      // що бекапів більше не буде ніколи.
      return Number.isNaN(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }

  async function runIfDue() {
    if (chatId === null || chatId === undefined) return;

    const last = lastSentAt();
    const at = now();
    if (last !== null && at - last < EXPORT_INTERVAL_MS) return;

    try {
      const date = new Date(at).toISOString().slice(0, 10);
      const dump = Buffer.from(JSON.stringify(store.exportAll(), null, 2));
      await sendDocument(chatId, dump, `deye-backup-${date}.json`,
        '💾 Щотижнева копія: користувачі, підписки, обʼєкти й запрошення');

      // Маркер пишеться ЛИШЕ після успішної відправки. Інакше збій Telegram
      // з'їдав би цілий тиждень: наступна спроба була б аж за сім днів.
      fs.writeFileSync(markerPath, new Date(at).toISOString());
      log.info(`Щотижневий експорт надіслано: deye-backup-${date}.json`);
    } catch (err) {
      // Як і в createBackup: привід для логу, а не для падіння бота.
      log.error(`Щотижневий експорт не вдався: ${err.message}`);
    }
  }

  return { runIfDue };
}

// Знімок стану, яким він був за мить до появи нової версії. Окремий префікс
// обовʼязковий: добовий бекап зветься backup-YYYY-MM-DD.db і перезаписується
// на кожному старті — саме так копія до міграції v3 загинула через три
// секунди після завантаження нової версії.
export const PREDEPLOY_PREFIX = 'predeploy-';

// Тека може не існувати (у тестах — навмисно). Пошук попередніх знімків не
// має кидати раніше, ніж до цього дійде VACUUM зі своїм повідомленням.
const safeReaddir = dir => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// Telegram у telegram.js має власний таймаут 15 с. У шатдауні стільки чекати
// не можна: Fly шле SIGKILL через kill_timeout (тут дефолтні 5 с), і на
// половині очікування процес просто вбʼють.
const SEND_BUDGET_MS = 3000;

export function createDeploySnapshot({
  store, dir, keep = 3, chatId, version, sendDocument, log,
  now = () => Date.now(), sendTimeoutMs = SEND_BUDGET_MS,
}) {
  // Тотожність слоту веде ВЕРСІЯ, а час у назві — лише для людини. Машина
  // рестартує по кілька разів на день, і якби слот вела назва цілком, кожен
  // рестарт лишав би ще один файл і виштовхував старші версії з ротації.
  //
  // Без FLY_MACHINE_VERSION лишається сам час — тоді кожен вихід є окремою
  // подією, і це чесніше, ніж вдавати, що версія відома.
  const at = new Date(now());
  const stamp = at.toISOString().slice(0, 19).replaceAll(':', '-') + 'Z';
  const slot = version ? `${stamp}-${version}` : stamp;

  // FLY_MACHINE_VERSION виявився ULID, а ULID кодує момент СТВОРЕННЯ версії:
  // у бою це були 10:29, тоді як знімок знявся о 10:54. Тому час беремо свій,
  // а не розбираємо з версії — відновлюють за свіжістю даних, і дата в назві
  // не має брехати на пів години.
  const sameVersion = name =>
    version !== null && version !== undefined
    && name.startsWith(PREDEPLOY_PREFIX) && name.endsWith(`-${version}.db`);

  async function withBudget(promise) {
    let timer;
    try {
      await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`не вклався в ${sendTimeoutMs} мс`)), sendTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Розділено надвоє свідомо. shutdown робить capture(), потім зводить WAL і
  // закриває БД, і лише тоді send(): інакше чекпойнт — те, заради чого
  // обробник сигналу існує, — чекав би на Telegram до трьох секунд.
  function capture() {
    const target = path.join(dir, `${PREDEPLOY_PREFIX}${slot}.db`);
    // Читаємо ДО запису: файл цієї ж версії означає, що вона вже виходила,
    // тобто це повторний рестарт, а не нова версія. Шукаємо за версією, а не
    // за повною назвою — назва містить час і щоразу інша.
    const previous = safeReaddir(dir).filter(sameVersion);
    const seenBefore = previous.length > 0 || fs.existsSync(target);

    // Дамп збирається першим, поки БД точно відкрита: збій VACUUM не має
    // забирати ще й позасмугову копію, яка цінніша за локальну.
    let dump = null;
    try {
      dump = Buffer.from(JSON.stringify(store.exportAll(), null, 2));
    } catch (err) {
      log.error(`Знімок перед деплоєм, дамп не вдався: ${err.message}`);
    }

    try {
      fs.rmSync(target, { force: true });
      store.raw.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

      // Один файл на версію: попередній знімок тієї самої версії поступається
      // новішому, інакше серія рестартів заповнила б усю ротацію собою.
      const current = path.basename(target);
      for (const stale of previous.filter(f => f !== current)) {
        fs.rmSync(path.join(dir, stale), { force: true });
      }

      // Те саме правило, що й у добовій ротації: щойно створену копію не
      // видаляємо ніколи, скільки б файлів із пізнішими іменами не лежало.
      const others = safeReaddir(dir)
        .filter(f => f.startsWith(PREDEPLOY_PREFIX) && f !== current)
        .sort();
      for (const stale of others.slice(0, Math.max(0, others.length - (keep - 1)))) {
        fs.rmSync(path.join(dir, stale), { force: true });
      }
      log.info(`Знімок перед деплоєм: ${current}`);
    } catch (err) {
      log.error(`Знімок перед деплоєм не вдався: ${err.message}`);
    }

    return { dump, seenBefore };
  }

  async function send({ dump, seenBefore } = {}) {
    if (seenBefore || !dump || chatId === null || chatId === undefined) return;

    try {
      await withBudget(sendDocument(chatId, dump, `deye-predeploy-${slot}.json`,
        `💾 Копія перед зміною версії, знята ${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`));
      log.info(`Знімок перед деплоєм надіслано: deye-predeploy-${slot}.json`);
    } catch (err) {
      log.error(`Знімок перед деплоєм не надіслано: ${err.message}`);
    }
  }

  return { capture, send, runOnce: async () => send(capture()) };
}

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

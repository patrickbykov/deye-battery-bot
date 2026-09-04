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

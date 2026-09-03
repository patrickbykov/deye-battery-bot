import { toPoint, toLineProtocol, selectNewPoints } from './transform.js';

// Перелік інверторів рідко змінюється, але не є вічним: у станцію можуть
// додати пристрій. Перечитуємо його раз на годину, а не щоцикл.
const REDISCOVER_INTERVAL_MS = 3600_000;

// device/latest приймає до 10 SN за виклик.
const BATCH_SIZE = 10;

export function createCollector({ deye, influx, log, now = Date.now }) {
  const seen = new Map();     // inverter SN → останній записаний collectionTime
  let sns = null;
  let snsFetchedAt = 0;
  let lastSuccessAt = null;

  async function inverterSns() {
    if (sns && now() - snsFetchedAt < REDISCOVER_INTERVAL_MS) return sns;
    sns = await deye.listInverterSns();
    snsFetchedAt = now();
    log.info(`Інверторів у видимості: ${sns.length}`);
    return sns;
  }

  async function runCycle() {
    const all = await inverterSns();

    const devices = [];
    for (let i = 0; i < all.length; i += BATCH_SIZE) {
      devices.push(...await deye.getLatest(all.slice(i, i + BATCH_SIZE)));
    }

    // Валідація на пристрій, а не на пачку: бита телеметрія одного інвертора
    // не має позбавляти даних решту об'єктів.
    const points = [];
    for (const device of devices) {
      try {
        points.push(toPoint(device));
      } catch (err) {
        log.warn(`Точку відхилено: ${err.message}`);
      }
    }

    const fresh = selectNewPoints(points, seen);
    if (fresh.length === 0) {
      lastSuccessAt = now();
      return;
    }

    await influx.write(toLineProtocol(fresh));
    for (const point of fresh) seen.set(point.inverter, point.timestamp);
    lastSuccessAt = now();

    log.info(`Записано точок: ${fresh.length}`);
  }

  return { runCycle, lastSuccessAt: () => lastSuccessAt };
}

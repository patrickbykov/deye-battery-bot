import { toPoint, toGridPoint, toCapacityPoint, toLineProtocol, selectNewPoints } from './transform.js';

// Перелік інверторів рідко змінюється, але не є вічним: у станцію можуть
// додати пристрій. Перечитуємо його раз на годину, а не щоцикл.
const REDISCOVER_INTERVAL_MS = 3600_000;

// device/latest приймає до 10 SN за виклик.
const BATCH_SIZE = 10;

// Ємність майже не міняється: одного запису на добу на інвертор досить.
const CAPACITY_INTERVAL_MS = 24 * 3600_000;

export function createCollector({ deye, influx, log, now = Date.now }) {
  const seen = new Map();     // inverter SN → останній записаний collectionTime
  let sns = null;
  let snsFetchedAt = 0;
  let lastSuccessAt = null;
  const capacityWrittenAt = new Map();   // inverter SN → коли востаннє писали ємність

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
      // Батарея і мережа ловляться окремо: зникнення живлення — критичніший
      // сигнал за SOC, і зіпсоване поле батареї не має його ховати.
      try {
        points.push(toPoint(device));
      } catch (err) {
        log.warn(`Точку батареї відхилено: ${err.message}`);
      }
      try {
        const grid = toGridPoint(device);
        if (grid) points.push(grid);
      } catch (err) {
        log.warn(`Точку мережі відхилено: ${err.message}`);
      }
    }

    const fresh = selectNewPoints(points, seen);
    if (fresh.length > 0) {
      await influx.write(toLineProtocol(fresh));
      for (const point of fresh) seen.set(point.inverter, point.timestamp);
      log.info(`Записано точок: ${fresh.length}`);
    }
    lastSuccessAt = now();

    // Після основного запису: за збою Influx ретрай ємності не має
    // затримувати SOC і мережу. Помилка тут цикл не зриває.
    await writeCapacity(devices);
  }

  async function writeCapacity(devices) {
    const points = [];
    for (const device of devices) {
      if (now() - (capacityWrittenAt.get(device.deviceSn) ?? -Infinity) < CAPACITY_INTERVAL_MS) continue;
      try {
        const point = toCapacityPoint(device);
        if (point) points.push(point);
      } catch (err) {
        log.warn(`Ємність відхилено: ${err.message}`);
      }
    }
    if (points.length === 0) return;
    try {
      await influx.write(toLineProtocol(points));
      log.info(`Записано ємність: ${points.length}`);
    } catch (err) {
      log.warn(`Ємність не записано: ${err.message}`);
      // Постійна відмова (напр. конфлікт схеми) не повториться успішно:
      // відкладаємо на добу замість спроби кожні 90 с.
      if (!err.permanent) return;
    }
    for (const point of points) capacityWrittenAt.set(point.inverter, now());
  }

  return { runCycle, lastSuccessAt: () => lastSuccessAt };
}

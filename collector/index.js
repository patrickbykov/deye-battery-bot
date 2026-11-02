import { loadConfig } from './config.js';
import { createDeyeClient } from './deye.js';
import { createInfluxWriter } from './influx.js';
import { createCollector } from './collector.js';
import { nextDelayMs } from './schedule.js';

const defaultLog = {
  info: msg => console.log(`[collector] ${msg}`),
  warn: msg => console.warn(`[collector] ${msg}`),
  error: msg => console.error(`[collector] ${msg}`),
};

// Колектор живе в процесі бота: дві Node-машини не влазять у 256MB, а дві
// машини Fly — це рахунок понад $5. Власного HTTP більше немає — несвіжість
// циклу бот віддає у свій health-check через повернуті lastSuccessAt/stalenessLimitMs.
// `collector` — лише для тестів.
export function startCollector({ env = process.env, log = defaultLog, collector } = {}) {
  const config = loadConfig(env);

  collector ??= createCollector({
    deye: createDeyeClient(config.deye),
    influx: createInfluxWriter(config.influx),
    log,
  });

  log.info(`Старт. Інтервал ${config.collectIntervalMs / 1000}с, бакет ${config.influx.bucket}`);

  // Помилка циклу не має вбивати процес: наступна ітерація спробує знову,
  // а якщо не виходить надовго — health-check стане 503 і Fly перезапустить.
  //
  // Планування через setTimeout, а не setInterval: пауза після збою більша за
  // звичайний інтервал, а setInterval такого не вміє. Побічно це прибирає
  // давню ваду setInterval — цикл, довший за період, накладався б сам на себе.
  let failures = 0;

  const tick = async () => {
    try {
      await collector.runCycle();
      failures = 0;
    } catch (err) {
      failures++;
      log.error(`Цикл впав (${failures} поспіль): ${err.message}`);
    }

    const delayMs = nextDelayMs({ intervalMs: config.collectIntervalMs, failures });
    if (delayMs !== config.collectIntervalMs) {
      log.warn(`Наступна спроба через ${delayMs / 1000}с — відступ після збоїв`);
    }
    setTimeout(tick, delayMs);
  };

  tick();

  return { lastSuccessAt: collector.lastSuccessAt, stalenessLimitMs: config.stalenessLimitMs };
}

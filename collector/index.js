import http from 'node:http';
import { loadConfig } from './config.js';
import { createDeyeClient } from './deye.js';
import { createInfluxWriter } from './influx.js';
import { createCollector } from './collector.js';
import { nextDelayMs } from './schedule.js';

const log = {
  info: msg => console.log(`[collector] ${msg}`),
  warn: msg => console.warn(`[collector] ${msg}`),
  error: msg => console.error(`[collector] ${msg}`),
};

function main() {
  const config = loadConfig();

  const collector = createCollector({
    deye: createDeyeClient(config.deye),
    influx: createInfluxWriter(config.influx),
    log,
  });

  // Health-check, який каже правду. У бота він віддає 200 безумовно і сервер
  // стоїть поза головним циклом — тому мертвий бот пів року рапортував OK.
  // Тут 200 означає «цикл справді відпрацював нещодавно».
  http.createServer((req, res) => {
    const last = collector.lastSuccessAt();
    const ageMs = last === null ? Infinity : Date.now() - last;
    const healthy = ageMs < config.stalenessLimitMs;

    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'text/plain' });
    res.end(healthy
      ? `OK (останній цикл ${Math.round(ageMs / 1000)}с тому)`
      : `STALE (останній успішний цикл ${last === null ? 'ще не був' : Math.round(ageMs / 1000) + 'с тому'})`);
  }).listen(config.port, '0.0.0.0', () => {
    log.info(`Health-check на порту ${config.port}`);
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
}

main();

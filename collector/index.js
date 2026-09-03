import http from 'node:http';
import { loadConfig } from './config.js';
import { createDeyeClient } from './deye.js';
import { createInfluxWriter } from './influx.js';
import { createCollector } from './collector.js';

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
  const stalenessLimitMs = Math.max(3 * config.collectIntervalMs, 300_000);
  http.createServer((req, res) => {
    const last = collector.lastSuccessAt();
    const ageMs = last === null ? Infinity : Date.now() - last;
    const healthy = ageMs < stalenessLimitMs;

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
  const tick = async () => {
    try {
      await collector.runCycle();
    } catch (err) {
      log.error(`Цикл впав: ${err.message}`);
    }
  };

  tick();
  setInterval(tick, config.collectIntervalMs);
}

main();

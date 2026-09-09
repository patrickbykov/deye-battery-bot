// Каданс хмари Deye — ~5 хв (виміряно 7 вер 2026 на 2104 точках). Опитувати
// частіше за каданс має сенс не заради нових даних, а заради того, щоб не
// проспати вже готову точку: при рівних періодах цикл регулярно прокидався
// одразу ПЕРЕД появою свіжого значення й ніс зайві ~5 хв затримки.
// Повторів у бакеті це не додає — `selectNewPoints` відсіює той самий
// `collectionTime`.
const DEFAULT_COLLECT_INTERVAL_MS = 90_000;

// Нижня межа існує через невідомі ліміти Deye API: поведінка при їх
// перевищенні не тестувалась (docs/deye-cloud-api.md), тож описка в змінній
// оточення не повинна перетворити колектор на джерело троттлінгу.
const MIN_COLLECT_INTERVAL_MS = 30_000;

// Ліміт несвіжості для health-check. Прив'язка лише до інтервалу означала б,
// що скорочення періоду мовчки робить перевірку жорсткішою: 3 × 90с — це вже
// 4.5 хв, і кожен збій Deye довший за це давав би рестарт. Рестарт при цьому
// не лікує, а лише губить кешований токен і змушує логінитись наново.
const MIN_STALENESS_LIMIT_MS = 900_000;

const REQUIRED = [
  'DEYE_APP_ID', 'DEYE_APP_SECRET', 'DEYE_EMAIL', 'DEYE_PASSWORD',
  'INFLUX_URL', 'INFLUX_ORG', 'INFLUX_TOKEN',
];

// Секрети кладемо неперелічуваними: `console.log(config)` і JSON.stringify —
// найкоротший шлях злити токен у логи Fly, які потім не почистити.
function hidden(target, values) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(target, key, { value, enumerable: false });
  }
  return target;
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter(key => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Не задані обов'язкові змінні: ${missing.join(', ')}`);
  }

  const collectIntervalMs = Number(env.COLLECT_INTERVAL || DEFAULT_COLLECT_INTERVAL_MS);
  if (!Number.isFinite(collectIntervalMs) || collectIntervalMs < MIN_COLLECT_INTERVAL_MS) {
    throw new Error(
      `COLLECT_INTERVAL має бути числом не меншим за ${MIN_COLLECT_INTERVAL_MS} мс, отримано: ${env.COLLECT_INTERVAL}`);
  }

  return {
    deye: hidden({
      baseUrl: env.DEYE_BASE_URL || 'https://eu1-developer.deyecloud.com/v1.0',
      appId: env.DEYE_APP_ID,
      email: env.DEYE_EMAIL,
    }, {
      appSecret: env.DEYE_APP_SECRET,
      password: env.DEYE_PASSWORD,
    }),
    influx: hidden({
      url: env.INFLUX_URL,
      org: env.INFLUX_ORG,
      bucket: env.INFLUX_BUCKET || 'monitoring',
    }, {
      token: env.INFLUX_TOKEN,
    }),
    collectIntervalMs,
    stalenessLimitMs: Math.max(3 * collectIntervalMs, MIN_STALENESS_LIMIT_MS),
    port: Number(env.PORT || 8080),
  };
}

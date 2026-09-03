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
    collectIntervalMs: Number(env.COLLECT_INTERVAL || 300_000),
    port: Number(env.PORT || 8080),
  };
}

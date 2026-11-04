import { INFLUXDB_BUCKET } from './config.js';
import { parseGrafanaFields } from './helpers.js';

// Збагачення не має права гальмувати алерт про світло: довше — відправляємо без нього.
const LOOKUP_TIMEOUT_MS = 4_000;

export const isGridAlert = alert => String(alert.alertname).includes('Немає живлення від мережі');

function lastFlux(measurement, inverterId, range) {
  return `from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: ${range})
  |> filter(fn: (r) => r._measurement == "${measurement}")
  |> filter(fn: (r) => r.inverter == "${inverterId}")
  |> last()
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;
}

async function lastPoint(queryGrafana, measurement, inverterId, range) {
  const frames = (await queryGrafana(lastFlux(measurement, inverterId, range)))?.results?.A?.frames;
  return frames?.length ? parseGrafanaFields(frames) : null;
}

// Повертає { soc, batteryPower, grid: {voltage, frequency, power, time} } або null,
// якщо Influx недоступний: повідомлення тоді йде без необовʼязкових рядків.
export async function fetchGridContext(inverterId, queryGrafana) {
  if (!inverterId) return null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('lookup-timeout')), LOOKUP_TIMEOUT_MS);
  });
  try {
    const [battery, grid] = await Promise.race([
      Promise.all([
        lastPoint(queryGrafana, 'battery', inverterId, '-24h'),
        lastPoint(queryGrafana, 'grid', inverterId, '-7d'),
      ]),
      timeout,
    ]);
    return {
      soc: battery?.soc ?? null,
      batteryPower: battery?.power ?? null,
      batteryTime: battery?._time ?? null,
      grid: grid && {
        voltage: grid.voltage ?? null,
        frequency: grid.frequency ?? null,
        power: grid.power ?? null,
        time: grid._time ?? null,
      },
    };
  } catch (err) {
    console.error(`Контекст алерта ${inverterId}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

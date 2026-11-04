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

// Навантаження = імпорт з мережі + розряд батареї (на станції немає PV).
// Агрегуємо у Flux: Grafana обрізає відповідь, що має багато точок (400).
// Обидва виміри пишуться з однаковим collectionTime, тож збігаються по _time.
function loadFlux(inverterId) {
  const part = m => `from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -24h)
  |> filter(fn: (r) => r._measurement == "${m}" and r._field == "power" and r.inverter == "${inverterId}")
  |> keep(columns: ["_time", "_measurement", "_value"])`;
  return `union(tables: [${part('battery')}, ${part('grid')}])
  |> group()
  |> pivot(rowKey: ["_time"], columnKey: ["_measurement"], valueColumn: "_value")
  |> filter(fn: (r) => exists r.battery and exists r.grid)
  |> sort(columns: ["_time"])
  |> reduce(
    identity: {n: 0.0, sum: 0.0, first: time(v: 0), last: time(v: 0)},
    fn: (r, accumulator) => ({
      n: accumulator.n + 1.0,
      sum: accumulator.sum + r.battery + r.grid,
      first: if accumulator.n == 0.0 then r._time else accumulator.first,
      last: r._time,
    }),
  )`;
}

// Середнє за добу без зваження за часом: точки йдуть рівномірно (~5 хв).
// Менше 2 год історії — не показуємо, щоб не видавати випадкову цифру за норму.
const MIN_SPAN_MS = 2 * 3600_000;

async function averageLoad(queryGrafana, inverterId) {
  const frames = (await queryGrafana(loadFlux(inverterId)))?.results?.A?.frames;
  if (!frames?.length) return null;
  const { n, sum, first, last } = parseGrafanaFields(frames);
  if (!(n > 0) || last - first < MIN_SPAN_MS) return null;
  const mean = sum / n;
  return Number.isFinite(mean) ? mean : null;
}

async function lastPoint(queryGrafana, measurement, inverterId, range) {
  const frames = (await queryGrafana(lastFlux(measurement, inverterId, range)))?.results?.A?.frames;
  return frames?.length ? parseGrafanaFields(frames) : null;
}

// Повертає { soc, avgPower (Вт за 24 год), capacityAh, grid: {voltage, frequency, power, time} } або null,
// якщо Influx недоступний: повідомлення тоді йде без необовʼязкових рядків.
export async function fetchGridContext(inverterId, queryGrafana) {
  if (!inverterId) return null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('lookup-timeout')), LOOKUP_TIMEOUT_MS);
  });
  try {
    const [battery, grid, avgPower, info] = await Promise.race([
      Promise.all([
        lastPoint(queryGrafana, 'battery', inverterId, '-24h'),
        lastPoint(queryGrafana, 'grid', inverterId, '-7d'),
        averageLoad(queryGrafana, inverterId),
        lastPoint(queryGrafana, 'battery_info', inverterId, '-3d'),
      ]),
      timeout,
    ]);
    return {
      soc: battery?.soc ?? null,
      avgPower,
      capacityAh: info?.capacity_ah ?? null,
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

// Ключі Deye API → поля виміру `battery`. Мапінг звірено з живою відповіддю,
// див. docs/deye-cloud-api.md. `Temperature- Battery` — буквальний ключ Deye,
// разом з пробілом перед дефісом; не «виправляти».
const FIELD_KEYS = {
  soc: 'SOC',
  voltage: 'BatteryVoltage',
  current: 'BatteryTotalCurrent',
  power: 'BatteryPower',
  temperature: 'Temperature- Battery',
};

// Записане в InfluxDB serverless v3 видалити неможливо (405 на /api/v2/delete),
// тож усе сміття лежатиме до кінця retention. Межі широкі навмисне: вони
// ловлять биту телеметрію, а не звужують норму.
const RANGES = {
  soc: [0, 100],
  voltage: [0, 1500],
  current: [-1000, 1000],
  power: [-100000, 100000],
  temperature: [-50, 150],
};

export function toPoint(deviceData) {
  const { deviceSn, collectionTime } = deviceData;

  if (!Number.isFinite(collectionTime)) {
    throw new Error(`${deviceSn}: collectionTime відсутній або не число`);
  }

  const byKey = new Map(deviceData.dataList.map(d => [d.key, d.value]));

  const fields = {};
  for (const [field, key] of Object.entries(FIELD_KEYS)) {
    const value = Number(byKey.get(key));
    if (!Number.isFinite(value)) {
      throw new Error(`${deviceSn}: поле ${field} (${key}) не число: ${byKey.get(key)}`);
    }
    const [min, max] = RANGES[field];
    if (value < min || value > max) {
      throw new Error(`${deviceSn}: поле ${field} поза межами ${min}..${max}: ${value}`);
    }
    fields[field] = value;
  }

  fields.state = Math.sign(fields.power);

  return { inverter: deviceSn, timestamp: collectionTime, fields };
}

// Екранування за специфікацією line protocol: у тегах — кома, знак рівності
// і пробіл. Наш SN числовий, але людські назви об'єктів такими не будуть.
function escapeTag(value) {
  return String(value).replace(/([,= ])/g, '\\$1');
}

export function toLineProtocol(points) {
  return points.map(({ inverter, timestamp, fields }) => {
    // Без суфікса `i`: таблиця `battery` тримає всі шість полів як float,
    // і integer у ній дає HTTP 400 table schema conflict.
    const fieldSet = Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    return `battery,inverter=${escapeTag(inverter)} ${fieldSet} ${timestamp}`;
  }).join('\n');
}

// Хмара віддає ті самі дані між вивантаженнями логера (~10–15 хв), тож без
// цього фільтра кожен цикл переписував би ту саму точку. Строго новіші —
// щоб збій годинника на боці Deye не тягнув запис назад у часі.
export function selectNewPoints(points, seen) {
  return points.filter(p => !(seen.get(p.inverter) >= p.timestamp));
}

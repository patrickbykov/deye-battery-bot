// Джерело істини про перелік інверторів — сам InfluxDB: колектор пише тег
// `inverter`, discovery його вичитує. Ручного реєстру не заводимо, інакше
// додавання нового об'єкта потребувало б деплою.

export const DISCOVERY_INTERVAL_MS = 300_000;

export function parseTagValues(response) {
  const frame = response?.results?.A?.frames?.[0];
  const index = (frame?.schema?.fields ?? []).findIndex(f => f.name === '_value');
  if (index < 0) return [];
  return frame?.data?.values?.[index] ?? [];
}

export function createDiscovery({
  store, queryGrafana, notifyAdmin, log, bucket, dashboardUid,
}) {
  const flux = `import "influxdata/influxdb/schema"
schema.tagValues(bucket: "${bucket}", tag: "inverter")`;

  async function runOnce() {
    let ids;
    try {
      ids = parseTagValues(await queryGrafana(flux));
    } catch (err) {
      // Збій Grafana не має зупиняти ні цей цикл, ні полінг Telegram —
      // дочекаємось наступної ітерації.
      log.error(`discovery: ${err.message}`);
      return;
    }

    for (const id of ids) {
      // Зникнення тега НЕ видаляє інвертор: retention бакета 30 днів, а
      // ON DELETE CASCADE знесло б разом з ним усі підписки на нього.
      if (store.getInverter(id)) continue;
      // Видалений адміном — не повертаємо. Тег живе в InfluxDB до кінця
      // retention, тож інакше /remove_inverter скасовувався б за 5 хвилин.
      if (store.isIgnoredInverter(id)) continue;

      store.upsertInverter(id, id, dashboardUid);
      log.info(`discovery: новий інвертор ${id}`);
      try {
        await notifyAdmin(`🔌 Виявлено новий інвертор: ${id}`);
      } catch (err) {
        log.warn(`discovery: не вдалось повідомити адміна: ${err.message}`);
      }
    }
  }

  return { runOnce };
}

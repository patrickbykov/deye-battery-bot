export const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const GRAFANA_URL = process.env.GRAFANA_URL;
export const GRAFANA_SA_TOKEN = process.env.GRAFANA_SA_TOKEN;
export const GRAFANA_DS_UID = process.env.GRAFANA_DS_UID;
export const DASHBOARD_UID = process.env.GRAFANA_DASHBOARD_UID;
export const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || 'monitoring';
// Панель теплокарти відключень на тому самому дашборді. 12 — не здогадка:
// панелі 1–11 зайняті, і саме під цим id панель створено. Env лишається на
// випадок перестворення — хибне число дасть не помилку, а чужу картинку.
export const OUTAGE_PANEL_ID = Number(process.env.GRAFANA_OUTAGE_PANEL_ID) || 12;
// Тимчасово: поки немає підписок з БД (задача 10), команди працюють з одним
// інвертором. Дефолту навмисно немає: значення мусить збігатися з тегом
// `inverter`, який пише колектор (SN інвертора). Хибний дефолт давав би
// синтаксично валідний запит, що мовчки повертає порожньо.
export const DEFAULT_INVERTER_ID = process.env.DEFAULT_INVERTER_ID;
export const PORT = process.env.PORT || 8080;
export const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
export const GRAFANA_WEBHOOK_TOKEN = process.env.GRAFANA_WEBHOOK_TOKEN;
export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

export const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

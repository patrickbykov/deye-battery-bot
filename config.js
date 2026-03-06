export const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const GRAFANA_URL = process.env.GRAFANA_URL;
export const GRAFANA_SA_TOKEN = process.env.GRAFANA_SA_TOKEN;
export const GRAFANA_DS_UID = process.env.GRAFANA_DS_UID;
export const DASHBOARD_UID = process.env.GRAFANA_DASHBOARD_UID;
export const INFLUXDB_BUCKET = process.env.INFLUXDB_BUCKET || 'monitoring';
export const PORT = process.env.PORT || 8080;

export const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;
export const DASHBOARD_LINK = `${GRAFANA_URL}/d/${DASHBOARD_UID}/deye-sun-15k-battery-monitor`;

import fetch from 'node-fetch';
import { TG_API, INFLUXDB_BUCKET, DEFAULT_INVERTER_ID, DASHBOARD_UID } from './config.js';
import { fmt, renderSocBar, formatKyivTime, parseGrafanaFields } from './helpers.js';
import { sendMessage } from './telegram.js';
import { queryGrafana, renderGrafanaPanel, getDashboardLink } from './grafana.js';

// Місток до задачі 10: там inverter прийде з таблиці subscriptions замість env.
function defaultInverter() {
  return {
    id: DEFAULT_INVERTER_ID,
    name: DEFAULT_INVERTER_ID,
    dashboard_uid: DASHBOARD_UID,
    panel_id: 6
  };
}

async function handleStatus(chatId, inverter = defaultInverter()) {
  try {
    const flux = `from(bucket: "${INFLUXDB_BUCKET}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "battery")
  |> filter(fn: (r) => r.inverter == "${inverter.id}")
  |> last()
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")`;

    const data = await queryGrafana(flux);
    const frames = data?.results?.A?.frames;

    if (!frames || frames.length === 0) {
      await sendMessage(chatId, '❌ Немає даних за останню годину');
      return;
    }

    const f = parseGrafanaFields(frames);
    const timeStr = formatKyivTime(f['_time'] || f['Time']);

    const msg = `🔋 <b>${inverter.name} — стан батареї</b>

🔋 SOC: <b>${fmt(f.soc, 0)}%</b> ${f.soc < 20 ? '⚠️ КРИТИЧНО!' : ''}
<code>${renderSocBar(f.soc)}</code>

⚡ Напруга: <b>${fmt(f.voltage)} V</b>
⚡ Струм: <b>${fmt(f.current)} A</b>
⚡ Потужність: <b>${fmt(f.power)} W</b>
🌡️ Температура: <b>${fmt(f.temperature)} °C</b>

🟢 Оновлено: ${timeStr}
📊 <a href="${getDashboardLink(inverter)}">Відкрити дашборд</a>`;

    await sendMessage(chatId, msg);
  } catch (err) {
    // Деталі — в лог. Користувачу загальне повідомлення: у тексті помилки
    // Grafana лежать uid датасорсів і внутрішні хости.
    console.error('/status error:', err.message);
    await sendMessage(chatId, '❌ Не вдалося отримати дані. Спробуйте за хвилину.');
  }
}

async function handleGraph(chatId, inverter = defaultInverter()) {
  try {
    const imageBuffer = await renderGrafanaPanel(inverter);

    const { FormData, Blob: FetchBlob } = await import('node-fetch');
    const formData = new FormData();
    formData.append('chat_id', chatId.toString());
    formData.append('caption', `📊 ${inverter.name} — SOC за останні 24 години`);
    formData.append('photo', new FetchBlob([imageBuffer], { type: 'image/png' }), 'soc_graph.png');

    const tgRes = await fetch(`${TG_API}/sendPhoto`, {
      method: 'POST',
      body: formData
    });

    if (!tgRes.ok) {
      await sendMessage(chatId, `📊 <a href="${getDashboardLink(inverter)}">Відкрити дашборд Grafana</a>\n\n⚠️ Рендеринг графіку недоступний. Перегляньте дашборд за посиланням.`);
    }
  } catch (err) {
    console.error('/graph error:', err);
    await sendMessage(chatId, `📊 <a href="${getDashboardLink(inverter)}">Відкрити дашборд Grafana</a>\n\n⚠️ Графік тимчасово недоступний.`);
  }
}

async function handleHelp(chatId) {
  const msg = `🤖 <b>Deye Battery Monitor Bot</b>

Доступні команди:

/status — 🔋 Поточний стан батареї
/graph — 📊 Графік SOC за 24 години
/help — ℹ️ Список команд

<i>Інвертор: Deye SUN-15K-SG05LP3-EU-SM2
Моніторинг: InfluxDB Cloud + Grafana
Алерт: SOC &lt; 20% → автоматичне сповіщення</i>`;

  await sendMessage(chatId, msg, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔋 Статус батареї', callback_data: '/status' }],
        [{ text: '📊 Графік SOC', callback_data: '/graph' }]
      ]
    }
  });
}

export const commands = {
  '/start': handleHelp,
  '/help': handleHelp,
  '/status': handleStatus,
  '/graph': handleGraph,
};

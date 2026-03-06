# 🔋 Deye Battery Telegram Bot

Телеграм-бот для моніторингу батарей інвертора **Deye SUN-15K-SG05LP3-EU-SM2 WiFi** (15 kW, 3 фази, 2 MPPT, LV).

## Можливості

- `/status` — поточний стан батареї (SOC, напруга, струм, температура, потужність)
- `/graph` — графік SOC за 24 години (через Grafana Render)
- `/help` — список команд
- Автоматичні алерти через Grafana при SOC < 20%

## Стек технологій

- **InfluxDB Cloud** — зберігання метрик батареї
- **Grafana Cloud** — дашборд, алерти, рендеринг графіків
- **Telegram Bot API** — інтерактивні команди та сповіщення
- **Node.js 18+** — runtime

## Швидкий старт

### 1. Клонувати репозиторій

```bash
git clone https://github.com/patrickbykov/deye-battery-bot.git
cd deye-battery-bot
```

### 2. Встановити залежності

```bash
npm install
```

### 3. Налаштувати змінні оточення

```bash
cp .env.example .env
# Заповнити .env реальними значеннями
```

### 4. Запустити бота

```bash
npm start
```

## Змінні оточення

| Змінна | Опис |
|--------|------|
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота від @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID для сповіщень |
| `GRAFANA_URL` | URL Grafana Cloud інстансу |
| `GRAFANA_SA_TOKEN` | Service Account Token (роль Viewer) |
| `GRAFANA_DS_UID` | UID InfluxDB datasource в Grafana |
| `GRAFANA_DASHBOARD_UID` | UID дашборду батареї |
| `INFLUXDB_BUCKET` | Назва InfluxDB bucket (default: monitoring) |
| `POLL_INTERVAL` | Інтервал полінгу Telegram в мс (default: 3000) |

## Деплой на Render.com (безкоштовно)

1. Форкнути або завантажити цей репо на GitHub
2. Зайти на [render.com](https://render.com) → New → Background Worker
3. Підключити GitHub репозиторій
4. Build Command: `npm install`
5. Start Command: `node index.js`
6. Додати змінні оточення в Settings → Environment
7. Deploy!

## Волонтерський проєкт 🇺🇦

Цей бот створений для волонтерського проєкту з моніторингу сонячних інверторів.

## Ліцензія

MIT# deye-battery-bot
Telegram bot for Deye SUN-15K battery monitoring via Grafana &amp; InfluxDB

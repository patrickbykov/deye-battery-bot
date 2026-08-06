# Multi-Inverter Subscriptions Design

## Overview

Extend the Telegram bot to support multiple inverters with per-user subscriptions, auto-discovery of new inverters from InfluxDB, admin role, and automatic SOC alerts.

## Storage

SQLite (`data/bot.db`) via `better-sqlite3`.

### Tables

```sql
CREATE TABLE inverters (
  id TEXT PRIMARY KEY,          -- tag value from InfluxDB (e.g. "Deye-SUN-15K")
  name TEXT,                    -- human-readable name
  dashboard_uid TEXT,           -- Grafana dashboard UID
  panel_id INTEGER DEFAULT 6,  -- Grafana panel ID for graph rendering
  discovered_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE subscriptions (
  chat_id INTEGER NOT NULL,
  inverter_id TEXT NOT NULL REFERENCES inverters(id) ON DELETE CASCADE,
  subscribed_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, inverter_id)
);

CREATE TABLE alert_state (
  inverter_id TEXT NOT NULL REFERENCES inverters(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,        -- e.g. "soc_low"
  active INTEGER DEFAULT 0,       -- 1 = alert is active (SOC still low)
  last_triggered_at TEXT,
  PRIMARY KEY (inverter_id, alert_type)
);
```

## Auto-Discovery

Every 5 minutes, query InfluxDB for all unique `inverter` tag values:

```flux
import "influxdata/influxdb/schema"
schema.tagValues(bucket: "monitoring", tag: "inverter")
```

New values are inserted into `inverters` table. Admin receives a notification about newly discovered inverters.

## Commands

### User commands

| Command | Description |
|---------|-------------|
| `/subscribe <id>` | Subscribe to an inverter (validated against DB) |
| `/unsubscribe <id>` | Unsubscribe from an inverter |
| `/list` | Show all available inverters |
| `/mysubs` | Show current user's subscriptions |
| `/status` | Status for all subscribed inverters (one message per inverter) |
| `/graph` | Graph for all subscribed inverters |
| `/help` | Updated help with new commands |

### Admin commands (ADMIN_CHAT_ID only)

| Command | Description |
|---------|-------------|
| `/remove_inverter <id>` | Remove inverter from DB (cascades to subscriptions) |
| `/users` | List all users and their subscriptions |

## Alerts

Background loop every 60 seconds checks SOC for all inverters:
- SOC < 20% triggers alert to all subscribers of that inverter
- Alert sent once per incident (deduplicated via `alert_state.active` flag)
- When SOC returns above 20%, `active` is reset to 0 and a recovery message is sent

## File Structure

```
config.js         -- env + constants (add ADMIN_CHAT_ID)
db.js             -- SQLite init, inverters CRUD, subscriptions CRUD, alert_state
helpers.js        -- formatting (unchanged)
telegram.js       -- sendMessage, answerCallbackQuery (unchanged)
grafana.js        -- queryGrafana, renderGrafanaPanel (parameterized by inverter)
commands.js       -- command handlers (subscribe, unsubscribe, status, graph, admin)
discovery.js      -- auto-discovery loop
alerts.js         -- background SOC monitoring + alert dispatch
index.js          -- main, polling, start discovery + alerts
data/             -- SQLite file (Fly.io volume)
```

## Fly.io Changes

Add volume mount to `fly.toml`:

```toml
[mounts]
  source = "bot_data"
  destination = "/app/data"
```

Add `ADMIN_CHAT_ID` to Fly.io secrets.

## Dependencies

Add `better-sqlite3` to package.json.
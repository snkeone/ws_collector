# ws_collector

Standalone WebSocket collector for Hyperliquid raw feed.

## Purpose
- Keep external WS connection in one independent process.
- Write date-based raw logs (`raw-YYYYMMDD.jsonl`) like V1/V2.
- Also mirror stream to one shared feed JSONL file for live consumers.
- Let `hlws-v1` / `hlws-v2` consume identical input via `WS_SHARED_FEED_FILE`.

## Setup
```bash
cd /home/snkeone/projects/ws_collector
npm install
cp .env.example .env
# set DEV_DISCORD_WEBHOOK_URL in .env
```

## Run
```bash
WS_SHARED_FEED_FILE=/tmp/hlws-shared-feed.jsonl npm start
```

Optional env:
- `WS_SHARED_SYMBOLS` default: `BTC`
- `WS_SHARED_SUB_TYPES` default: `l2Book,trades,activeAssetCtx`
- `WS_COLLECTOR_LOG_DIR` default: `./logs`
- `WS_COLLECTOR_RAW_PREFIX` default: `raw-`
- `HL_WS_URL` default: `wss://api.hyperliquid.xyz/ws`
- `WS_COLLECTOR_RECONNECT_MS` default: `3000`
- `WS_COLLECTOR_HEARTBEAT_MS` default: `15000`
- `WS_COLLECTOR_LOG_COMPRESS_AFTER_DAYS` default: `2`
- `WS_COLLECTOR_LOG_KEEP_DAYS` default: `7`

## Use with V1/V2
Start runtime with the same feed path:
```bash
WS_SHARED_FEED_FILE=/tmp/hlws-shared-feed.jsonl <runtime command>
```

If you need replay from file start:
```bash
WS_SHARED_FEED_REPLAY_FROM_START=1 WS_SHARED_FEED_FILE=/tmp/hlws-shared-feed.jsonl <runtime command>
```

## Always-on Service (auto restart + notifications)
Install systemd user services:
```bash
cd /home/snkeone/projects/ws_collector
./scripts/install_user_services.sh
```

Service control:
```bash
./scripts/service_ctl.sh status
./scripts/service_ctl.sh restart
./scripts/service_ctl.sh stop
./scripts/service_ctl.sh logs
./scripts/downtime_report.sh
```

Uninstall:
```bash
./scripts/uninstall_user_services.sh
```

### Notification behavior
- Collector process start: Discord info.
- Graceful stop/restart (`SIGTERM`/`SIGINT`): Discord warn.
- Crash/down detected by monitor: Discord error.
- Recover after down: Discord info with downtime duration.
- Long down: repeated error report every `WS_COLLECTOR_MONITOR_DOWN_REPORT_MS`.
# ws_collector

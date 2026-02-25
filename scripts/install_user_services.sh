#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
ENV_FILE="${ROOT_DIR}/.env"

mkdir -p "${UNIT_DIR}"

cat > "${UNIT_DIR}/ws-collector.service" <<EOF
[Unit]
Description=Standalone Hyperliquid WS Collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=/usr/bin/env node ${ROOT_DIR}/index.js
Restart=always
RestartSec=3
StandardOutput=append:${ROOT_DIR}/logs/service.out.log
StandardError=append:${ROOT_DIR}/logs/service.err.log

[Install]
WantedBy=default.target
EOF

cat > "${UNIT_DIR}/ws-collector-monitor.service" <<EOF
[Unit]
Description=WS Collector Downtime Monitor
After=ws-collector.service
Wants=ws-collector.service

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=-${ENV_FILE}
ExecStart=/usr/bin/env node ${ROOT_DIR}/monitor.js
Restart=always
RestartSec=5
StandardOutput=append:${ROOT_DIR}/logs/monitor.out.log
StandardError=append:${ROOT_DIR}/logs/monitor.err.log

[Install]
WantedBy=default.target
EOF

mkdir -p "${ROOT_DIR}/logs"

systemctl --user daemon-reload
systemctl --user enable --now ws-collector.service
systemctl --user enable --now ws-collector-monitor.service

echo "[OK] installed and started:"
echo "  - ws-collector.service"
echo "  - ws-collector-monitor.service"
echo
echo "If you need auto-start without login session, run once:"
echo "  sudo loginctl enable-linger ${USER}"

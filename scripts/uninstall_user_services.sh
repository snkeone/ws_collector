#!/usr/bin/env bash
set -euo pipefail

UNIT_DIR="${HOME}/.config/systemd/user"

systemctl --user disable --now ws-collector-monitor.service 2>/dev/null || true
systemctl --user disable --now ws-collector.service 2>/dev/null || true

rm -f "${UNIT_DIR}/ws-collector-monitor.service"
rm -f "${UNIT_DIR}/ws-collector.service"

systemctl --user daemon-reload

echo "[OK] uninstalled ws-collector services"

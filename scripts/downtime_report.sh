#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${WS_COLLECTOR_MONITOR_STATE_FILE:-/tmp/ws_collector_monitor_state.json}"
NOW="$(date +%s)"

if [ ! -f "$STATE_FILE" ]; then
  echo "monitor state not found: $STATE_FILE"
  exit 0
fi

node -e '
const fs = require("fs");
const file = process.argv[1];
const now = Math.floor(Date.now() / 1000);
const s = JSON.parse(fs.readFileSync(file, "utf8"));
function fmt(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const ss = sec%60;
  return `${h}h ${m}m ${ss}s`;
}
if (s.status === "down" && s.downSince) {
  const downSec = now - Math.floor(Number(s.downSince)/1000);
  console.log(`status=down downtime=${fmt(downSec)} downSince=${new Date(Number(s.downSince)).toISOString()}`);
} else {
  console.log(`status=${s.status || "unknown"} lastUpAt=${s.lastUpAt ? new Date(Number(s.lastUpAt)).toISOString() : "n/a"} lastPid=${s.lastPid ?? "n/a"}`);
}
' "$STATE_FILE"

#!/usr/bin/env bash
set -euo pipefail

CMD="${1:-status}"

case "$CMD" in
  start)
    systemctl --user start ws-collector.service ws-collector-monitor.service
    ;;
  stop)
    systemctl --user stop ws-collector-monitor.service ws-collector.service
    ;;
  restart)
    systemctl --user restart ws-collector.service ws-collector-monitor.service
    ;;
  status)
    systemctl --user status ws-collector.service --no-pager || true
    echo "----"
    systemctl --user status ws-collector-monitor.service --no-pager || true
    ;;
  logs)
    journalctl --user -u ws-collector.service -u ws-collector-monitor.service -n 200 --no-pager
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac

#!/usr/bin/env bash
# gpu-server: remove only the https:8443 serve entry, then stop only our pid (SIGKILL after 5 s).
set -uo pipefail
. "$(dirname "$0")/common.sh"
tailscale serve --https="$SERVE_PORT" off >/dev/null 2>&1 || true
if pid="$(server_pid)"; then
  kill "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  echo "stopped pid $pid"
else
  echo "not running"
fi
rm -f "$PID_FILE"
tailscale serve status

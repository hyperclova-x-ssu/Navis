# Shared settings for the gpu-server scripts. Everything stays inside ~/navis-cnn-live (D-70); the only outside
# change is the tailscale serve entry for https:8443.
L="${NAVIS_CNN_HOME:-$HOME/navis-cnn-live}"
APP="$L/app"
VENV="$L/venv"
PY="$VENV/bin/python"
RUN="$L/run"
LOGS="$L/logs"
PID_FILE="$RUN/server.pid"
PORT="${CNN_PORT:-8765}"
SERVE_PORT=8443

funnel_on() {
  # prints nothing and returns 1 when funnel is off everywhere
  local out
  out="$(tailscale funnel status 2>&1 || true)"
  if echo "$out" | grep -qiE "no serve config|^$"; then return 1; fi
  echo "$out" | grep -qi "funnel on" && return 0
  echo "$out" | grep -qiE "\(Funnel on\)|Funnel on" && return 0
  return 1
}

server_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

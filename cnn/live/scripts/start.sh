#!/usr/bin/env bash
# gpu-server: start the server (default --mode weak = no GPU, CPU 0-3, 8 GB memory cap) and tailscale serve https:8443.
set -euo pipefail
. "$(dirname "$0")/common.sh"
MODE=weak
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    *) echo "usage: start.sh [--mode weak|gpu]" >&2; exit 2 ;;
  esac
done
[ "$MODE" = weak ] || [ "$MODE" = gpu ] || { echo "mode must be weak or gpu" >&2; exit 2; }
if funnel_on; then echo "tailscale funnel is ON - refusing to start (ARCHITECTURE 12.8)" >&2; exit 1; fi
if pid="$(server_pid)"; then echo "already running (pid $pid)"; exit 0; fi
if ss -ltn 2>/dev/null | grep -q "127.0.0.1:$PORT "; then echo "port $PORT busy (not ours)" >&2; exit 1; fi
mkdir -p "$RUN" "$LOGS" "$L/data"
export CNN_MODE="$MODE" CNN_DATA_DIR="${CNN_DATA_DIR:-$L/data}" CNN_MODEL_DIR="${CNN_MODEL_DIR:-$L/models}"
export YOLO_AUTOINSTALL=False YOLO_CONFIG_DIR="$L/ultra_cfg"
UV=("$PY" -m uvicorn server:app --app-dir "$APP" --host 127.0.0.1 --port "$PORT" --ws-max-size 1048576 --no-access-log)
WRAP=()
if [ "$MODE" = weak ]; then
  export CUDA_VISIBLE_DEVICES="" CNN_CPU_THREADS="${CNN_CPU_THREADS:-4}"
  export OMP_NUM_THREADS="$CNN_CPU_THREADS" MKL_NUM_THREADS="$CNN_CPU_THREADS" OPENBLAS_NUM_THREADS="$CNN_CPU_THREADS"
  if systemd-run --user --scope --quiet -p MemoryMax=8G true 2>/dev/null; then
    WRAP=(systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 taskset -c 0-3)
  else
    echo "systemd-run --user unavailable: using ulimit -v 8G instead" >&2
    ulimit -v $((8 * 1024 * 1024))
    WRAP=(taskset -c 0-3)
  fi
fi
cd "$L"
nohup "${WRAP[@]}" "${UV[@]}" >>"$LOGS/server.log" 2>&1 &
echo $! >"$PID_FILE"
# systemd-run --scope execs the command, so $! is the uvicorn process itself
for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break
  kill -0 "$(cat "$PID_FILE")" 2>/dev/null || { echo "server exited, see $LOGS/server.log" >&2; tail -20 "$LOGS/server.log" >&2; exit 1; }
  sleep 1
done
tailscale serve --bg --https="$SERVE_PORT" "http://127.0.0.1:$PORT" >/dev/null
echo "started pid $(cat "$PID_FILE") mode $MODE"
curl -s "http://127.0.0.1:$PORT/api/health"; echo

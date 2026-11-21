#!/usr/bin/env bash
# gpu-server: pid, local health, serve and funnel status.
set -uo pipefail
. "$(dirname "$0")/common.sh"
if pid="$(server_pid)"; then echo "pid $pid running"; else echo "server not running"; fi
echo "health: $(curl -s -m 2 "http://127.0.0.1:$PORT/api/health" || echo unreachable)"
echo "--- tailscale serve status"; tailscale serve status
echo "--- tailscale funnel status"; tailscale funnel status
if funnel_on; then echo "WARNING: funnel is ON"; exit 1; fi

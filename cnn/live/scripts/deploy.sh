#!/usr/bin/env bash
# Mac (repository root or anywhere in it): copy the live server to gpu-server ~/navis-cnn-live/app/.
# smooth.py and occupancy/seat_state.py are copied (read-only originals) into app/vendor/.
set -euo pipefail
HOST="${GPU_HOST:-user@gpu-server}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"   # repository root
LIVE="$ROOT/cnn/live"
rsync -a --delete --exclude venv --exclude __pycache__ --exclude .pytest_cache --exclude vendor \
  "$LIVE/" "$HOST:navis-cnn-live/app/"
ssh "$HOST" 'mkdir -p ~/navis-cnn-live/app/vendor'
rsync -a "$ROOT/cnn/smooth.py" "$ROOT/cnn/occupancy/seat_state.py" "$HOST:navis-cnn-live/app/vendor/"
echo "deployed to $HOST:~/navis-cnn-live/app"

#!/usr/bin/env bash
# gpu-server, once: venv packages (requirements.txt), models, INT8 960 model, import check. Never touches conda envs.
set -euo pipefail
. "$(dirname "$0")/common.sh"
mkdir -p "$L/models" "$L/data" "$RUN" "$LOGS"
if [ ! -x "$PY" ]; then
  # T-065 README way: venv from the conda torch env's python (the conda env itself is not modified)
  BASE_PY="${BASE_PY:-$HOME/miniconda3/envs/torch/bin/python}"
  "$BASE_PY" -m venv "$VENV"
fi
"$PY" -m pip install -q -r "$APP/requirements.txt"
"$PY" -m pip install -q --no-deps openvino==2024.6.0 openvino-telemetry==2025.2.0   # same as T-065 (numpy 2.2.6)
cd "$L/models"
for m in yolo11s.pt yolo11s-seg.pt yolo11m.pt; do
  [ -f "$m" ] || curl -fsSLO "https://github.com/ultralytics/assets/releases/download/v8.3.0/$m"
done
INT8="$L/models/yolo11s_544x960_int8_openvino_model"
if [ ! -d "$INT8" ]; then
  MK="$L/cnn/bench/make_int8.py"
  if [ ! -f "$MK" ]; then
    echo "INT8 model missing and $MK not found: rsync cnn/bench to ~/navis-cnn-live/cnn/bench first" >&2
    exit 1
  fi
  "$PY" -m pip install -q nncf==2.14.1 scikit-learn==1.5.2 joblib==1.6.0 threadpoolctl==3.8.0 jstyleson==0.0.2 \
    natsort==8.4.0 pydot==4.0.1 pyparsing==3.3.3 tabulate==0.10.0 safetensors==0.8.0
  (cd "$L/cnn/bench" && YOLO_AUTOINSTALL=False "$PY" make_int8.py --model yolo11s --size 960)
fi
CUP_INT8="$L/models/yolo11m_384x384_int8_openvino_model"
if [ ! -d "$CUP_INT8" ]; then
  echo "Stage the prepared cup INT8 model directory at $CUP_INT8 (README.md)" >&2
  exit 1
fi
"$PY" -c "import openvino, fastapi, uvicorn, segno, ultralytics, cv2; print('ok openvino', openvino.__version__, 'fastapi', fastapi.__version__)"

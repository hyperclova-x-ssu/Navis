#!/usr/bin/env bash
# gpu-server 에서 측정 스크립트를 돌리는 래퍼. 기존 conda torch 환경 python 은 실행만 하고(설치 금지),
# 추가 패키지는 ~/navis-cnn-live/extra(lap), extra_trt(tensorrt·onnx) 에 pip --target 으로 넣어 PYTHONPATH 로 붙인다.
# 사용: bash ~/navis-cnn-live/cnn/bench/run_gpu.sh bench_detect.py --backends pt
set -euo pipefail
L=$HOME/navis-cnn-live
export NAVIS_LIVE=$L
export YOLO_AUTOINSTALL=False          # ultralytics 가 빠진 패키지를 conda 환경에 자동 설치하지 못하게
export YOLO_CONFIG_DIR=$L/ultra_cfg    # ultralytics 설정 파일도 이 폴더 안에
export YOLO_OFFLINE=True
PY=${NAVIS_PY:-$HOME/miniconda3/envs/torch/bin/python}
export PYTHONPATH=$L/extra:$L/extra_trt${PYTHONPATH:+:$PYTHONPATH}
cd $L/cnn/bench
exec "$PY" "$@"

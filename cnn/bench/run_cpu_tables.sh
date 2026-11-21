#!/usr/bin/env bash
# 측정 3 의 CPU 조건 시간(분할 모델 한 장). run_cpu_raw.sh 가 끝난 뒤 실행(같은 4코어를 나눠 쓰지 않게).
L=$HOME/navis-cnn-live; B=$L/cnn/bench
while pgrep -f "bash [r]un_cpu_(more|raw).sh" >/dev/null; do sleep 10; done
CUDA_VISIBLE_DEVICES="" OMP_NUM_THREADS=4 NAVIS_THREADS=4 PYTHONPATH=$L/extra:$L/extra_cpu \
  systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 \
  taskset -c 0-3 bash $B/run_moa.sh bench_tables.py --device cpu --sample 20

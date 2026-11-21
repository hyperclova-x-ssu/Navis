#!/usr/bin/env bash
# GPU 없는 매장 PC 흉내(D-73): GPU 숨김 + 4코어 고정 + 스레드 4 + 메모리 8GB 상한. gpu-server 에서 실행(sudo 불필요).
# 사용: bash run_cpu.sh [latency|pipeline|all]
set -uo pipefail
L=$HOME/navis-cnn-live
B=$L/cnn/bench
cpu() {  # 설정 하나 = 새 프로세스 하나(메모리 최대값을 설정별로 재기 위해)
  CUDA_VISIBLE_DEVICES="" OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 NAVIS_THREADS=4 \
  PYTHONPATH=$L/extra:$L/extra_cpu \
  systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 \
    taskset -c 0-3 bash $B/run_moa.sh bench_cpu.py "$@"
}
what=${1:-all}
if [[ $what == latency || $what == all ]]; then
  for m in yolo11n yolo11s; do for rt in pt onnx openvino; do for s in 320 416 512 640; do
    cpu --mode latency --model $m --runtime $rt --size $s
  done; done; done
fi
if [[ $what == pipeline || $what == all ]]; then
  cpu --mode reference
  for m in yolo11n yolo11s; do for s in 320 416 512 640; do
    cpu --mode pipeline --model $m --runtime openvino --size $s --interval 1
  done; done
  for n in 2 3; do cpu --mode pipeline --model yolo11n --runtime openvino --size 640 --interval $n; done
  cpu --mode pipeline --model yolo11s --runtime openvino --size 640 --interval 3
fi

#!/usr/bin/env bash
# run_cpu.sh 다음 단계: 큰 입력(960/1280)과 정확도 형식 바뀌기 전 줄 다시 재기. 사용: bash run_cpu_more.sh
set -uo pipefail
L=$HOME/navis-cnn-live
B=$L/cnn/bench
eval "$(sed -n '/^cpu()/,/^}/p' $B/run_cpu.sh)"
while pgrep -f "bash [r]un_cpu.sh all" >/dev/null; do sleep 10; done
for m in yolo11n yolo11s; do for s in 960 1280; do cpu --mode latency --model $m --runtime openvino --size $s --iters 30; done; done
cpu --mode reference
for s in 320 416 512; do cpu --mode pipeline --model yolo11n --runtime openvino --size $s; done
for m in yolo11n yolo11s; do for s in 960 1280; do cpu --mode pipeline --model $m --runtime openvino --size $s; done; done

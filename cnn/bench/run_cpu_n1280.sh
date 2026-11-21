#!/usr/bin/env bash
# 후보 A: YOLO11s·1280 을 덜 자주 탐지(이 5fps 영상에서 2장마다 = 초당 2.5번, 3장마다 = 1.67번). 다른 대기열이 끝난 뒤.
L=$HOME/navis-cnn-live; B=$L/cnn/bench
eval "$(sed -n '/^cpu()/,/^}/p' $B/run_cpu.sh)"
while pgrep -f "bash [r]un_cpu_(more|raw|tables).sh" >/dev/null; do sleep 10; done
for n in 2 3; do cpu --mode pipeline --model yolo11s --runtime openvino --size 1280 --interval $n; done

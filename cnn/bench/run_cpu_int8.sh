#!/usr/bin/env bash
# 후보 C: YOLO11s INT8(make_int8.py) 의 탐지 시간과 정확도. 다른 대기열(A 포함)이 끝난 뒤.
L=$HOME/navis-cnn-live; B=$L/cnn/bench
eval "$(sed -n '/^cpu()/,/^}/p' $B/run_cpu.sh)"
while pgrep -f "bash [r]un_cpu_(more|raw|tables|n1280).sh" >/dev/null; do sleep 10; done
for s in 960 1280; do cpu --mode latency --model yolo11s --runtime ov_int8 --size $s --iters 30; done
for s in 960 1280; do cpu --mode pipeline --model yolo11s --runtime ov_int8 --size $s; done

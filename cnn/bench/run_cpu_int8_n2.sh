#!/usr/bin/env bash
# 후보 A+C: YOLO11s·1280 INT8 을 초당 2.5번 탐지(이 5fps 영상에서 2장마다)
L=$HOME/navis-cnn-live; B=$L/cnn/bench
eval "$(sed -n '/^cpu()/,/^}/p' $B/run_cpu.sh)"
cpu --mode pipeline --model yolo11s --runtime ov_int8 --size 1280 --interval 2

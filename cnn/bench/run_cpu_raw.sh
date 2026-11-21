#!/usr/bin/env bash
# 원본 상자 저장(results/cpu_frames/*_raw.json, T-065b 용)을 붙인 뒤 파이프라인 설정 전체를 다시 잰다. run_cpu_more.sh 가 끝난 뒤.
L=$HOME/navis-cnn-live; B=$L/cnn/bench
eval "$(sed -n '/^cpu()/,/^}/p' $B/run_cpu.sh)"
while pgrep -f "bash [r]un_cpu_more.sh" >/dev/null; do sleep 10; done
for m in yolo11n yolo11s; do for s in 320 416 512 640 960 1280; do cpu --mode pipeline --model $m --runtime openvino --size $s; done; done
for n in 2 3; do cpu --mode pipeline --model yolo11n --runtime openvino --size 640 --interval $n; done
cpu --mode pipeline --model yolo11s --runtime openvino --size 640 --interval 3

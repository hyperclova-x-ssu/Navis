#!/usr/bin/env bash
# gpu-server: 대기열 두 개를 뒤에서 시작(로그는 ~/navis-cnn-live/logs)
cd $HOME/navis-cnn-live/cnn/bench
nohup bash run_cpu_raw.sh > ../../logs/cpu_raw.log 2>&1 < /dev/null &
sleep 2
nohup bash run_cpu_tables.sh > ../../logs/tables_cpu.log 2>&1 < /dev/null &

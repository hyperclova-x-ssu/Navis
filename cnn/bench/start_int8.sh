#!/usr/bin/env bash
cd $HOME/navis-cnn-live/cnn/bench
nohup bash run_cpu_int8.sh > ../../logs/cpu_int8.log 2>&1 < /dev/null &

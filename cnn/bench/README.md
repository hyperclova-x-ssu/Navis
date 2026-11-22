# T-065 CNN 실시간 속도 측정과 최적화 후보

반복 5-C "CNN 실시간 시연"(BLUEPRINT 10.16)의 실시간 서버 구성을 R3가 정하기 위한 측정입니다. 서버를 만든 것이 아니라 재기만 했습니다.
측정: 2026-11-10 02:46~04:53 KST, gpu-server(`user@gpu-server`, RTX 3090 24GB, i9-10900K, RAM 31GB).

**기준 컴퓨터(D-373)**: GPU 없는 보통 매장 PC(CPU 4코어, RAM 8GB). gpu-server에서 흉내 내어 쟀고(아래 "흉내 방법"), GPU 숫자(측정 1~3의 GPU 표)는 참고값입니다.
**목표**: 상자 갱신 초당 15번 이상, 카메라→화면 0.5초 이내. **여유 1.5배**: 15장/초 카메라에서 한 장에 쓰는 CPU 시간이 프레임 간격(66.7ms)의 2/3 = **44.4ms 이하**.
**정확도 허용선(D-378 새 판정·새 정의, 기준선 대비 상대값)**: 손님 수 오차 ≤ 7.3%, 테이블 점유 정확도(outlier 포함·제외 둘 다) ≥ 91.4%, 머문 인원 오차 ≤ 26.6%.

표시: **[측정]** 실제로 돌려 잰 값, **[추정]** 측정값으로 계산한 값, **[가정]** 재지 않은 전제.

## 결론과 추천 구성

| 항목 | 추천 |
| :-- | :-- |
| 모델 | YOLO11s (COCO 사전학습 그대로, 새 학습 없음) |
| 실행기 | OpenVINO 2024.6 **INT8**(NNCF 사후 양자화, `make_int8.py`), CPU |
| 입력 크기 | 960 (16:9 고정 모양 544×960) |
| 탐지 횟수 | 초당 5번(15장/초 카메라에서 3장마다). 사이 장은 직전 상자를 그대로 그림(아래 4절 근거) |
| 판정 | T-065b `occupancy/seat_state.py` 기본값(`DEFAULTS`). 이 설정에서 설정별로 고른 값과 기본값이 같았음 |
| 스레드 | 4 (OpenVINO `INFERENCE_NUM_THREADS=4`, torch·OpenCV 4) |
| 메모리 | 프로세스 최대 약 0.92GB [측정] (8GB 상한 안) |
| 휴대폰 영상 | 1280×720 JPEG 품질 80(약 160KB), 연결 하나를 계속 씀(keep-alive 또는 웹소켓) |

- **속도 [추정, 측정값으로 계산]**: 한 장 비용 = 1280×720 디코딩 4.4ms + (탐지·추적 85.4ms + 뒤처리 0.4ms) ÷ 3 = **33.0ms ≤ 44.4ms** → 통과. 탐지 한 번 p95 86.8ms라 다음 탐지(200ms 뒤) 전에 끝남. 상자는 매 장(초당 15번) 갱신.
- **정확도 [측정, 새 정의]**: 손님 수 오차 7.1%(≤7.3), 점유 92.1% / 92.1%(≥91.4), 머문 인원 오차 22.2%(≤26.6) → 통과. 뒤쪽 절반(판정 값을 고르지 않은 구간)만 보면 6.5% · 95.6% / 93.6% · 20.0%. 옛 정의(T-046d) 점유는 81.6%(기준선 83.7%).
- **지연 [추정]**: 휴대폰 촬영·JPEG 만들기 30~50ms[가정] + 보내기·답 받기 15~50ms[측정: Mac→gpu-server, tailnet] + 디코딩 4ms + 탐지 85ms + 다음 탐지 차례를 기다림 최대 133ms + 화면 그리기 16ms[가정] ≈ **0.2~0.35초** → 0.5초 안.
- **주의(여유가 얇은 곳)**: 손님 수 오차 7.1%는 허용선 7.3%에 가깝습니다. gpu-server 코어 하나는 보통 매장 PC(예: i5 8세대)보다 1.3~2배 빠를 수 있어[가정, maintainer], 실제 PC에서는 33.0ms가 43~66ms가 될 수 있습니다. 66ms 쪽이면 탐지를 초당 3~4번으로 줄여야 하고(그만큼 정확도 확인 필요), 시연 전에 실제 PC에서 `run_cpu.sh`와 같은 명령으로 한 번 재 보는 것을 권합니다.
- **차선**: YOLO11s·1280 INT8 초당 5번은 정확도가 더 좋지만(손님 수 6.0%) 56.9ms로 예산 초과. 초당 2.5번이면 31.0ms지만 점유(제외) 91.2%로 허용선 0.2%p 아래. GPU가 있는 서버에서는 YOLO11s·1280을 그대로 써도 한 장 약 22ms[측정].

후보를 고른 순서(D-375): A(탐지 횟수 줄이기) → C(INT8) → B(테이블 영역 크롭) → D(학습). A만으로는 속도 47.3ms(초당 2.5번)로 예산 바로 위였고, C에서 통과 설정이 나와 B·D는 하지 않았습니다.

## 측정 1. 사진 1장 탐지 시간

### 1-GPU (참고) — YOLO11s, PyTorch, 입력 1280×720 사진 [측정] (`results/detect.json`)

| 입력 크기 | 정밀도 | 평균 ms | p95 ms | 초당 장수 | GPU 메모리(프로세스, nvidia-smi) | torch 최대 예약 |
| --: | :-- | --: | --: | --: | --: | --: |
| 640 | FP32 | 12.81 | 14.31 | 78.0 | 454MiB | 120MiB |
| 640 | FP16 | 12.69 | 13.27 | 78.8 | 416MiB | 74MiB |
| 960 | FP32 | 13.73 | 14.11 | 72.8 | 504MiB | 160MiB |
| 960 | FP16 | 14.11 | 14.62 | 70.9 | 452MiB | 108MiB |
| 1280 | FP32 | 13.76 | 14.30 | 72.7 | 552MiB | 208MiB |
| 1280 | FP16 | 14.33 | 15.79 | 69.8 | 476MiB | 130MiB |

- 시간 = `model.predict` 1회(전처리+추론+NMS, `cuda.synchronize` 포함, JPEG 디코딩 제외), 300회 평균, 예열 30회.
- 크기·정밀도와 거의 무관하게 13~14ms: 3090에서는 GPU 계산보다 파이썬·커널 호출 시간이 대부분이라 FP16도 빨라지지 않습니다.
- **TensorRT**: 표에 없음. 기존 conda 환경에 tensorrt가 없고, 새 폴더에 `pip --target`으로 `tensorrt-cu12==10.7.0`을 설치하던 중(메타 패키지가 소스 빌드 단계에서 오래 걸림) D-373(GPU 없는 PC 기준)으로 대상에서 빠져 중단했습니다. 엔진 내보내기 코드는 `bench_detect.py --backends engine`에 있습니다(실행 안 함).

### 1-CPU — 약한 PC 흉내, 입력 1280×720 사진 [측정] (`results/cpu.json` → `latency`, 원본 `results/cpu_rows.jsonl`)

| 모델 | 실행기 | 입력 | 평균 ms | p95 ms | 초당 장수 | 메모리 최대 MiB |
| :-- | :-- | --: | --: | --: | --: | --: |
| yolo11n | PyTorch CPU | 640 | 71.72 | 73.14 | 13.9 | 663 |
| yolo11n | ONNX Runtime | 640 | 33.86 | 34.45 | 29.5 | 755 |
| yolo11n | OpenVINO | 320 | 8.46 | 8.67 | 118.2 | 818 |
| yolo11n | OpenVINO | 416 | 12.57 | 12.75 | 79.6 | 703 |
| yolo11n | OpenVINO | 512 | 16.54 | 16.81 | 60.5 | 838 |
| yolo11n | OpenVINO | 640 | 25.61 | 25.98 | 39.0 | 847 |
| yolo11n | OpenVINO | 960 | 51.37 | 51.65 | 19.5 | 912 |
| yolo11n | OpenVINO | 1280 | 90.69 | 94.18 | 11.0 | 1067 |
| yolo11s | PyTorch CPU | 640 | 145.57 | 177.50 | 6.9 | 736 |
| yolo11s | ONNX Runtime | 640 | 76.09 | 78.04 | 13.1 | 961 |
| yolo11s | OpenVINO | 320 | 19.47 | 19.74 | 51.4 | 953 |
| yolo11s | OpenVINO | 416 | 30.44 | 30.78 | 32.9 | 972 |
| yolo11s | OpenVINO | 512 | 41.17 | 41.76 | 24.3 | 984 |
| yolo11s | OpenVINO | 640 | 66.54 | 69.60 | 15.0 | 1024 |
| yolo11s | OpenVINO | 960 | 135.16 | 136.53 | 7.4 | 1143 |
| yolo11s | OpenVINO | 1280 | 251.35 | 256.84 | 4.0 | 1362 |
| yolo11s | **OpenVINO INT8** | 960 | **83.63** | 84.65 | 12.0 | 753 |
| yolo11s | OpenVINO INT8 | 1280 | 150.01 | 155.14 | 6.7 | 812 |

- 320~640의 PyTorch·ONNX 전체 24줄은 `results/cpu_tables.md`. 같은 크기에서 OpenVINO가 가장 빠르고(PyTorch CPU의 약 1/2.8~1/5.5), INT8은 FP32보다 1.6~1.7배 빠릅니다.
- ONNX·OpenVINO 모델은 16:9 고정 모양(예: 960 → 544×960, 1280 → 736×1280)으로 내보냈습니다(정사각형으로 채우는 계산 낭비 없음).
- 메모리 = 프로세스 최대 상주 메모리(`ru_maxrss`, 모델·사진 포함).

## 측정 2. 한 장당 전체 처리 시간 (디코딩 + 탐지·ByteTrack + 확인된 추적 N=2 + 앉음 판정 + 칼만 + 컵 구역)

### 2-GPU (참고) [측정] (`results/pipeline.json`)

| 설정 | 입력 | 디코딩 ms | track ms 평균/p95 | 뒤처리 ms | 합계 ms 평균/p95 | GPU 메모리 |
| :-- | :-- | --: | --: | --: | --: | --: |
| 640 FP16 | cafe17 960×540 | 2.53 | 15.11 / 17.64 | 0.24 | 17.87 / 20.86 | 414MiB |
| 960 FP16 | cafe17 960×540 | 2.53 | 15.22 / 16.00 | 0.27 | 18.01 / 18.88 | 450MiB |
| 1280 FP16 | cafe17 960×540 | 2.60 | 19.02 / 19.80 | 0.33 | 21.96 / 22.81 | 474MiB |
| 1280 FP32 | cafe17 960×540 | 2.58 | 18.20 / 20.04 | 0.32 | 21.11 / 23.21 | 552MiB |
| 640 FP16 | 1280×720 | 4.28 | 15.32 / 15.97 | 0.27 | 19.87 / 20.63 | 414MiB |
| 960 FP16 | 1280×720 | 4.25 | 16.81 / 17.87 | 0.28 | 21.35 / 22.70 | 450MiB |
| 1280 FP16 | 1280×720 | 4.37 | 17.04 / 17.75 | 0.34 | 21.75 / 22.55 | 474MiB |
| 1280 FP32 | 1280×720 | 4.43 | 16.67 / 17.30 | 0.34 | 21.44 / 22.24 | 552MiB |

- JPEG(품질 80) 평균 크기: 960×540 101.7KB, 1280×720 161.4KB. **JPEG 디코딩**: 960×540 2.5ms, 1280×720 4.3ms [측정].
- 한 장씩 돌리는 판정(`benchlib.LivePipeline`)이 저장소의 배치 함수(`smooth.confirm_tracks`·`smooth.kalman`)와 1,718장 모두 같은 숫자를 냄을 확인(`liveEqualsBatch: true`).
- 1280×720 입력은 Café 17-354 원본 35장(1920×1080)을 줄여 6바퀴 돌림(바퀴마다 추적 초기화). 정답이 없어 시간만 봄.

### 2-CPU — 약한 PC 흉내, cafe17.mp4 1,718장 전체 + 정답 비교 [측정 + 추정] (`results/cpu.json` → `pipeline`·`verdict`)

"한 장 비용(15fps)"은 [추정]: 1280×720 디코딩 4.4ms + (탐지·추적 + 뒤처리) ÷ (15 ÷ 초당 탐지). 이 영상은 초당 5장이라, 간격 N=1·2·3이 실제 카메라의 초당 5·2.5·1.67번 탐지와 같은 시간 간격입니다.
정확도(새 정의)는 T-065b 평가(`occupancy/evaluate_weakpc.py`, 설정별 판정 값)이고, 옛 정의는 T-046d 판정·정의입니다.

| 설정 | 초당 탐지 | 탐지+추적 ms 평균/p95 | 한 장 비용 ms | 속도 | 손님 수 | 점유 포함/제외 | 머문 인원 | 정확도 | 옛 정의 점유 | 메모리 MiB |
| :-- | --: | --: | --: | :-- | --: | --: | --: | :-- | --: | --: |
| 기준선 yolo11s·1280 GPU(mps, 1920 원본) | 5 | - | - | - | 5.3% | 94.4% / 93.7% | 23.6% | 기준 | 83.7% | - |
| yolo11n·320 OpenVINO | 5 | 10.27 / 10.72 | 7.9 | 통과 | 52.4% | 70.4% / 78.7% | 54.7% | 탈락 | 59.6% | 850 |
| yolo11n·416 OpenVINO | 5 | 15.13 / 15.62 | 9.6 | 통과 | 23.2% | 84.2% / 89.9% | 31.8% | 탈락 | 71.2% | 859 |
| yolo11n·512 OpenVINO | 5 | 19.20 / 19.73 | 10.9 | 통과 | 7.7% | 90.7% / 92.6% | 32.4% | 탈락 | 79.0% | 869 |
| yolo11n·640 OpenVINO | 5 | 30.98 / 43.10 | 14.9 | 통과 | 7.9% | 88.8% / 91.0% | 26.9% | 탈락 | 81.0% | 895 |
| yolo11n·640 OpenVINO | 2.5 | 28.77 / 29.23 | 9.3 | 통과 | 11.8% | 89.4% / 91.4% | 25.9% | 탈락 | 80.8% | 891 |
| yolo11n·640 OpenVINO | 1.7 | 28.78 / 29.84 | 7.7 | 통과 | 15.8% | 90.3% / 91.4% | 23.7% | 탈락 | 81.3% | 890 |
| yolo11n·960 OpenVINO | 5 | 52.05 / 52.77 | 21.9 | 통과 | 11.9% | 91.8% / 92.1% | 25.5% | 탈락 | 80.6% | 961 |
| yolo11n·1280 OpenVINO | 5 | 95.40 / 97.02 | 36.3 | 통과 | 10.1% | 92.2% / 93.1% | 27.2% | 탈락 | 81.8% | 1020 |
| yolo11s·320 OpenVINO | 5 | 21.62 / 22.07 | 11.7 | 통과 | 32.2% | 82.4% / 87.6% | 31.1% | 탈락 | 70.2% | 910 |
| yolo11s·416 OpenVINO | 5 | 32.86 / 33.37 | 15.5 | 통과 | 24.1% | 88.2% / 92.8% | 27.7% | 탈락 | 77.9% | 917 |
| yolo11s·512 OpenVINO | 5 | 43.19 / 44.01 | 18.9 | 통과 | 19.6% | 92.3% / 92.3% | 25.6% | 탈락 | 80.3% | 924 |
| yolo11s·640 OpenVINO | 5 | 68.29 / 69.52 | 27.3 | 통과 | 11.9% | 92.0% / 92.1% | 20.9% | 탈락 | 80.9% | 939 |
| yolo11s·640 OpenVINO | 1.7 | 68.38 / 69.33 | 12.1 | 통과 | 17.7% | 90.7% / 91.4% | 25.7% | 탈락 | 81.5% | 934 |
| yolo11s·960 OpenVINO | 5 | 136.59 / 139.22 | 50.1 | 초과 | 7.4% | 92.0% / 92.1% | 22.3% | 탈락 | 81.5% | 995 |
| yolo11s·1280 OpenVINO | 5 | 255.49 / 264.62 | 89.7 | 초과 | 6.5% | 92.2% / 92.1% | 19.5% | 통과 | 82.1% | 1093 |
| yolo11s·1280 OpenVINO (A) | 2.5 | 256.53 / 263.93 | 47.3 | 초과 | 6.8% | 91.7% / 91.4% | 21.2% | 통과 | 82.3% | 1068 |
| yolo11s·1280 OpenVINO (A) | 1.7 | 255.10 / 260.80 | 32.8 | 통과 | 8.0% | 90.8% / 91.5% | 28.5% | 탈락 | 81.9% | 1093 |
| **yolo11s·960 INT8 (C, 추천)** | **5** | **85.44 / 86.79** | **33.0** | **통과** | **7.1%** | **92.1% / 92.1%** | **22.2%** | **통과** | 81.6% | 919 |
| yolo11s·1280 INT8 (C) | 5 | 156.94 / 163.95 | 56.9 | 초과 | 6.0% | 92.0% / 92.2% | 23.9% | 통과 | 82.3% | 1032 |
| yolo11s·1280 INT8 (A+C) | 2.5 | 159.19 / 178.46 | 31.0 | 통과 | 6.5% | 91.5% / 91.2% | 21.3% | 탈락 | 82.3% | 1001 |

- 원인: 안쪽 부스·먼 자리의 앉은 사람이 화면에서 작아 입력을 줄이면 놓칩니다. 입력을 키우면 거의 단조롭게 회복되고, CPU의 YOLO11s·1280이 기준선과 같은 수준이라 실시간 파이프라인 자체는 문제가 없습니다.
- 판정 값은 T-065b 방식대로 설정마다 앞쪽 절반에서 골랐습니다(추천 설정은 고른 값 = `DEFAULTS`). 뒤쪽 절반만의 값은 `results/occupancy_eval.json`(INT8)·`occupancy/results/eval_weakpc.json`(나머지)의 `occupiedSecondHalf`.
- 시간: 같은 설정을 두 번 이상 잰 경우 가장 빠른 실행의 시간을 씁니다. yolo11n·960/1280의 04:08·04:13 다시 재기는 다른 코어에서 INT8 변환을 돌리던 때라 시간이 부풀어(95→159ms) 앞선 실행(03:46·03:49) 시간을 씁니다. 상자·정확도에는 영향이 없습니다.
- 정확도 비교 입력은 cafe17.mp4(960×540)이고 기준선은 1920×1080 원본입니다. 실제 휴대폰 1280×720은 그 사이라, 입력 960 이하 설정에서는 차이가 작다고 봅니다[가정].

## 측정 3. 테이블 추천 영역 후보 (`results/tables.json`, CPU 시간 `results/tables_cpu.json`)

비교 대상: `zones/cafe17_tables.json`의 실제 테이블 4개(사람이 그린 "윗면+앉는 자리" 다각형). "찾음" = IoU ≥ 0.25 또는 후보 넓이의 60% 이상이 그 테이블 안. 영상 cafe17.mp4, 고르게 60장.

| 후보 | 시간(1장) | 찾은 테이블 | 평균 IoU | 엉뚱한 후보 |
| :-- | :-- | :-- | --: | --: |
| A. yolo11s-seg dining table 마스크, 640 | GPU 18.4ms / CPU 185ms | 1장: 평균 0.47개, 60장 투표: 0개 | 0.057 | 0 |
| A. 같은 것, 960 | GPU 18.4ms / CPU 345ms | 1장: 1.48개, 투표: 2개(t2, t3) | 0.135 | 0 |
| A. 같은 것, 1280 | GPU 22.2ms / CPU 660ms | 1장: 1.30개, 투표: 2개(t2, t3) | 0.138 | 0 |
| B. 탐지 모델의 dining table 상자(960, 60장 투표) | 추가 0(탐지에 이미 있음) | 1개(t2) | 0.175 | 0 |
| C. 앉은 사람 흔적(상자 높이 ≤ 350px인 사람의 아래 절반을 1,718장 누적, 10% 이상) | 추가 0 | **3개(t1, t2, t3)** | **0.452** | 1 |

- 분할 모델은 테이블 윗면만 덮고(실제 다각형은 앉는 자리까지 포함), 안쪽 부스(t1)·창고 쪽 자리(t4)는 거의 못 찾습니다. GPU 메모리 438~530MiB.
- **추천**: 설정 화면을 열자마자 A(분할, 960, 몇 장 투표; CPU에서 1장 0.35초라 3~5장이면 1~2초)로 점선 후보를 먼저 띄우고, 영업 중 C(앉은 사람 흔적)를 쌓아 후보를 다듬는 방식. C의 임계값 10%는 정답과 비교해 세 값(5/10/20%) 중 고른 것이라 실제보다 좋게 나왔을 수 있습니다[주의]. t4처럼 둘 다 못 찾는 자리는 사장님이 그립니다(BLUEPRINT 10.16와 같음).

## 측정 4. 네트워크 왕복 (Mac → gpu-server, tailnet 직접 연결) [측정] (`results/network.json`)

1280×720 JPEG(품질 80, 165,650바이트) 1장, 200회(예열 5회 제외). 서버 `net_server.py`는 `gpu-server:18765`(기존 포트와 안 겹침)에 tailnet 주소로만 열었고 측정 뒤 닫았습니다(03:32 KST에 닫고 리슨·프로세스 없음 확인, 04:53에 다시 확인). Mac은 유선(이더넷), ping 평균 12.3ms(최소 3.2, 최대 89.9).

| 요청 | 연결 | 답 크기 | 평균 ms | p50 | p95 | 최대 |
| :-- | :-- | --: | --: | --: | --: | --: |
| `/ack` 사진 보내고 작은 답 | 계속 씀 | 17B | 15.38 | 12.72 | 16.24 | 101.75 |
| `/ack` | 매번 새 연결 | 17B | 44.35 | 36.85 | 124.59 | 131.56 |
| `/echo` 사진 보내고 사진 받기 | 계속 씀 | 165,650B | 22.02 | 17.97 | 22.08 | 106.87 |
| `/detect` 서버에서 탐지(yolo11n·640 OpenVINO, CPU 4코어) | 계속 씀 | 630B | 82.68 | 70.75 | 156.45 | 183.87 |

- `/detect` 서버 안 처리(디코딩+탐지+판정) 33.4ms. 그런데 서버가 요청 본문을 읽는 데 평균 35.5ms가 걸려(`/ack`은 전체 왕복이 15ms), 탐지를 붙이면 왕복이 처리 시간보다 약 30ms 더 깁니다. TCP_NODELAY를 켜도 같았고 원인은 확인하지 못했습니다(추정: 탐지 스레드가 CPU를 쓰는 동안 받는 쪽 처리가 늦어짐). 실제 서버에서는 받기와 탐지를 다른 스레드로 나누고(받은 최신 장만 탐지), 연결 하나를 계속 쓰는 것을 권합니다.
- **새 연결은 매번 약 30ms 더 듭니다** → 웹소켓이나 keep-alive.
- 휴대폰(와이파이/LTE, Tailscale 중계 가능)은 재지 않았습니다[가정: Mac 유선보다 느리고 흔들림이 큼].

## 흉내 방법 (GPU 없는 매장 PC)

sudo 없이 gpu-server에서:

```sh
CUDA_VISIBLE_DEVICES="" OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 NAVIS_THREADS=4 \
PYTHONPATH=$HOME/navis-cnn-live/extra:$HOME/navis-cnn-live/extra_cpu \
systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 \
  taskset -c 0-3 bash $HOME/navis-cnn-live/cnn/bench/run_gpu.sh bench_cpu.py --mode latency --model yolo11s --runtime ov_int8 --size 960
```

- CPU 0~3은 서로 다른 물리 코어(`lscpu -e`), 스레드 수는 torch·OpenCV·ONNX Runtime·OpenVINO 모두 4로 고정(`bench_cpu.py`가 ONNX Runtime·OpenVINO 세션 옵션을 덮어씀).
- `run_cpu.sh`(1차), `run_cpu_more.sh`, `run_cpu_raw.sh`, `run_cpu_n1280.sh`, `run_cpu_int8.sh`, `run_cpu_int8_n2.sh`, `run_cpu_tables.sh`가 위 명령으로 설정 하나씩 새 프로세스에서 돌립니다. 서로 겹치지 않게 앞 대기열이 끝나길 기다립니다.

## 다시 돌리는 명령

gpu-server 준비(한 번):

```sh
# Mac(저장소 루트에서): 코드·데이터 복사. 영상·사진·가중치는 저장소에 넣지 않음
ssh user@gpu-server 'mkdir -p ~/navis-cnn-live/{cnn,data/clip354_1080,models,logs}'
rsync -a cnn/common.py cnn/smooth.py cnn/zones user@gpu-server:navis-cnn-live/cnn/
rsync -a --exclude results cnn/bench/ user@gpu-server:navis-cnn-live/cnn/bench/
rsync -a frontend/public/cnn/cafe17.mp4 frontend/public/cnn/cafe17-detections.json user@gpu-server:navis-cnn-live/data/
rsync -a ~/Datasets/cafe-sample/Cafe_Dataset/Dataset/cafe/17/354/images/ user@gpu-server:navis-cnn-live/data/clip354_1080/
rsync -a ~/Datasets/cafe-sample/models/yolo11s.pt user@gpu-server:navis-cnn-live/models/
(cd cnn/bench && python3 make_gt.py /tmp/gt_cafe17.json) && scp /tmp/gt_cafe17.json user@gpu-server:navis-cnn-live/data/   # 정답(프레임별 숫자)
# gpu-server: 가중치, 추가 패키지(기존 conda 환경은 실행만, 설치는 전부 ~/navis-cnn-live 안)
cd ~/navis-cnn-live/models && curl -LO https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt \
  && curl -LO https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11s-seg.pt
cd ~/navis-cnn-live && P=~/miniconda3/envs/torch/bin/python
$P -m pip install --no-deps --target extra lap
$P -m pip install --no-deps --target extra_cpu onnx==1.17.0 onnxruntime==1.20.1 openvino==2024.6.0 openvino-telemetry protobuf==5.29.3 flatbuffers coloredlogs humanfriendly
$P -m pip install --no-deps --target extra_int8 nncf==2.14.1 jstyleson natsort pydot pyparsing tabulate scikit-learn==1.5.2 joblib threadpoolctl safetensors
```

측정(gpu-server, `~/navis-cnn-live/cnn/bench`):

```sh
bash run_gpu.sh bench_detect.py --backends pt        # 1-GPU  -> results/detect.json
bash run_gpu.sh bench_pipeline.py --configs pt:640:fp16,pt:960:fp16,pt:960:fp32,pt:1280:fp16,pt:1280:fp32   # 2-GPU -> results/pipeline.json
bash run_gpu.sh bench_tables.py                      # 3-GPU  -> results/tables.json
bash run_cpu.sh all                                  # 1·2-CPU (FP32) -> results/cpu_rows.jsonl, results/cpu_frames/
PYTHONPATH=$HOME/navis-cnn-live/extra:$HOME/navis-cnn-live/extra_cpu:$HOME/navis-cnn-live/extra_int8 \
  taskset -c 10-19 bash run_gpu.sh make_int8.py --model yolo11s --size 960   # INT8 만들기(약 3분, 1280 은 약 5분)
bash run_cpu_int8.sh; bash run_cpu_int8_n2.sh        # C (INT8)
bash run_cpu_tables.sh                               # 3-CPU  -> results/tables_cpu.json
```

네트워크(측정 4):

```sh
# gpu-server: 서버(10분 뒤 저절로 꺼짐). 끝나면 kill 로 바로 닫고 `ss -ltn | grep 18765` 가 비었는지 확인
L=~/navis-cnn-live; CUDA_VISIBLE_DEVICES="" NAVIS_THREADS=4 PYTHONPATH=$L/extra:$L/extra_cpu \
  taskset -c 4-7 bash $L/cnn/bench/run_gpu.sh net_server.py --host gpu-server --port 18765 --ttl 600 --config cpu:yolo11n:openvino:640
# Mac(cnn/bench): 1280x720 JPEG 하나를 만들어서
python3 net_client.py --host gpu-server --port 18765 --jpeg <1280x720.jpg> --n 200 --out results/network.json
```

정리(Mac, `cnn/bench`):

```sh
rsync -a user@gpu-server:navis-cnn-live/cnn/bench/results/ results/
python3 eval_occupancy.py int8                       # 새 판정·새 정의 평가 -> results/occupancy_eval.json
python3 summarize_cpu.py > results/cpu_tables.md     # -> results/cpu.json + 표
```

## 결과 파일

| 파일 | 내용 |
| :-- | :-- |
| `results/detect.json` | 1-GPU 표 |
| `results/pipeline.json` | 2-GPU 표(단계별 시간, `liveEqualsBatch`, 기존 재생 결과와 숫자 차이 `vsPlaybackJson`) |
| `results/tables.json`, `results/tables_cpu.json` | 3 (GPU, CPU 시간) |
| `results/network.json` | 4 |
| `results/cpu_rows.jsonl` | 1·2-CPU 원본(설정·실행마다 한 줄, 실행 시각 포함) |
| `results/cpu.json`, `results/cpu_tables.md` | `summarize_cpu.py` 결과(판정 포함) |
| `results/occupancy_eval.json` | INT8 세 설정의 새 판정·새 정의 평가(`eval_occupancy.py`) |
| `results/cpu_frames/<모델>_<실행기>_<입력>_N<간격>_raw.json` | **설정별 탐지 원본(T-065b·이후 재계산용)**: 탐지한 장만 `{"i": 프레임 번호, "persons": [[x1,y1,x2,y2,추적번호]], "cups": [[x1,y1,x2,y2]]}`, 좌표는 [0..1], 확인 전(N=2 전) 상자. 실행기 `openvino`=FP32, `ov_int8`=INT8 |
| `results/cpu_frames/<같은 이름>.json` (`_raw` 없음) | 같은 실행의 프레임별 `inStore`·`seated`·`occupiedTables`(옛 판정) |

`cpu_frames/`는 20개 설정(설정마다 `_raw.json`과 숫자 파일 한 쌍), 약 11MB입니다(저장소에 넣을지는 maintainer 판단).

## 쓴 환경과 패키지 (서버 의존성 확정은 R3)

- 측정 실행: gpu-server 기존 conda `torch` 환경의 파이썬을 **실행만**(Python 3.10.20, torch 2.5.1+cu121, ultralytics 8.4.41, opencv 4.13.0, numpy 2.2.6). 그 환경에는 아무것도 설치하지 않았고, `YOLO_AUTOINSTALL=False`로 ultralytics 자동 설치도 막았습니다(`run_gpu.sh`).
- 추가 패키지(모두 `~/navis-cnn-live/` 안, `pip --target`): `extra/` lap 0.5.14 · `extra_cpu/` onnx 1.17.0, onnxruntime 1.20.1, openvino 2024.6.0, openvino-telemetry, protobuf 5.29.3, flatbuffers, coloredlogs, humanfriendly · `extra_int8/` nncf 2.14.1, scikit-learn 1.5.2, joblib, threadpoolctl, jstyleson, natsort, pydot, pyparsing, tabulate, safetensors.
- 서버용 새 환경 `~/navis-cnn-live/venv`(Python 3.10, conda `torch` 환경 파이썬으로 만든 venv): torch 2.5.1+cu121, torchvision 0.20.1+cu121, ultralytics 8.4.41, lap 0.5.14, opencv-python-headless 5.0. 설치가 늦게 끝나 측정에는 쓰지 않았습니다. 처음 시도한 Python 3.13 venv는 torchvision cu121 휠이 없어 실패해 지웠습니다.
- 가중치: `yolo11s.pt`(Mac에서 복사), `yolo11n.pt`·`yolo11s-seg.pt`(ultralytics assets v8.3.0). ONNX·OpenVINO·INT8 모델은 `~/navis-cnn-live/models/`.
- 모델 가중치·영상·사진·가상환경은 저장소에 없습니다.

## 스크립트

| 파일 | 하는 일 |
| :-- | :-- |
| `benchlib.py` | 공통: 경로, 프레임 읽기, 시간 통계, GPU 메모리, 한 장씩 판정 `LivePipeline`(확인 추적 + 앉음 + 칼만; 판정 함수 `seat` 를 바꿔 끼울 수 있음) |
| `bench_detect.py` | 측정 1-GPU (TensorRT 엔진 코드 포함, 실행 안 함) |
| `bench_pipeline.py` | 측정 2-GPU |
| `bench_cpu.py` | 측정 1·2-CPU (`--mode latency/pipeline/reference`, `--runtime pt/onnx/openvino/ov_int8`, `--interval N`) |
| `make_int8.py` | OpenVINO FP32 → INT8 (NNCF, 보정 = cafe17.mp4 300장. 같은 카메라 영상이라 "그 매장 화면으로 보정"한 경우에 가까움) |
| `bench_tables.py` | 측정 3 (`--device cpu`) |
| `net_server.py`, `net_client.py` | 측정 4 |
| `make_gt.py` | Mac: Café 정답 → 프레임별 숫자(`gt_cafe17.json`, 저장소 밖) |
| `eval_occupancy.py` | T-065b 평가(`occupancy/evaluate_weakpc.py`)를 bench 결과에 돌림(출력은 bench 안) |
| `summarize_cpu.py` | CPU 결과 정리·판정 |
| `run_gpu.sh`, `run_cpu*.sh`, `start_*.sh` | gpu-server 실행 래퍼·대기열 |

## 하지 않은 것과 남은 위험

- B(테이블 영역 크롭)·D(작은 모델 학습): C에서 통과 설정이 나와 하지 않음(D-375 순서).
- TensorRT: 1-GPU 절 참고(중단, 원인 기록).
- 실제 매장 PC·휴대폰 네트워크는 재지 않음: 추천 설정의 속도 여유(33.0 vs 44.4ms)는 gpu-server 코어 기준이라, 느린 PC에서는 부족할 수 있음.
- 상자 예측: 사이 장을 등속으로 밀어 그리는 것이 그대로 두는 것보다 낫지 않았습니다. 추천 설정(yolo11s·960 INT8)에서 실제 탐지 상자와의 평균 IoU: 0.2초 뒤 등속 0.943 vs 유지 0.944, 0.4초 뒤 0.921 vs 0.929 (14개 설정 모두 같은 경향, `results/cpu.json` `extrapolationIoU`). 앉은 손님이 대부분이라 그렇고, 15장/초 카메라에서는 간격이 0.067초로 더 짧아 차이가 더 작습니다[추정]. 그래서 추천은 "직전 상자 유지"입니다.

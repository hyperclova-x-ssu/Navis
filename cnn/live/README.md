# CNN live server (`cnn/live/`)

반복 5-C "CNN 실시간 시연" 서버. 휴대폰 카메라 페이지 → 이 서버(gpu-server) → Navis. 계약은 `03_architecture/API_CONTRACT.md`
API-14~18, 구성은 ARCHITECTURE 14절, 자료 형식은 DATA_MODEL 12절이 원본이다.

| 파일 | 작업 | 내용 |
| :-- | :-- | :-- |
| `server.py` | T-066 | FastAPI 앱: `/api/health`, `/api/pair`, `/api/pair/check`, `/cam`, `/ws/camera`, `/ws/view`, `/api/zones*`(얇은 라우트), Origin·CORS·크기 상한·429, 한 칸 자리 + 작업자 스레드 1개, 보는 소켓마다 1장 줄 |
| `config.py` | T-066 | 환경변수(아래 표) |
| `contracts.py` | T-066 | 부품 사이 약속(FrameIn·Detections·FrameResult·Protocol)과 소켓 메시지 형식 |
| `pairing.py` | T-066 | 짝짓기 코드·카메라 세션 토큰·QR SVG(segno) |
| `camera_page/` | T-066 | `/cam` 정적 페이지(`index.html`·`cam.js`·`i18n.js` 4개 언어) |
| `scripts/` | T-066 | `deploy.sh`(Mac) · `setup.sh`·`start.sh`·`stop.sh`·`status.sh`(gpu-server) |
| `pipeline.py`·`numbers.py` | T-067 | 사람 탐지·추적·숫자 |
| `capture.py` | MODEL-COMBO | 라이브와 녹화 재생 공용 프레임 처리, 테이블 크롭·컵 유지 |
| `zones.py`·`suggest.py` | T-068 | 영역 저장·추천 |

## 실행 (gpu-server `~/navis-cnn-live/`)

```sh
# Mac, 저장소 어디서나
cnn/live/scripts/deploy.sh            # app/ 로 복사 + smooth.py·seat_state.py 를 app/vendor/ 로
# gpu-server
~/navis-cnn-live/app/scripts/setup.sh        # 처음 한 번: venv 패키지, 모델, INT8 사람·컵 모델 확인
~/navis-cnn-live/app/scripts/start.sh --mode weak   # 기본. 또는 --mode gpu
~/navis-cnn-live/app/scripts/status.sh
~/navis-cnn-live/app/scripts/stop.sh         # serve https:8443 끄기 → 우리 pid 만 종료
# Mac 에서 확인
curl -s https://gpu-server.example.ts.net:8443/api/health
```

- `start.sh`는 `tailscale funnel status`에 Funnel이 켜져 있으면 시작하지 않는다. serve는 `https:8443 → http://127.0.0.1:8765` 하나만 더하고, `stop.sh`는 그 하나만 끈다(다른 serve 설정·프로세스는 건드리지 않음).
- `--mode weak`(시연 기본, D-373·D-379): `CUDA_VISIBLE_DEVICES=""` + `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 taskset -c 0-3` + 스레드 4개(`CNN_CPU_THREADS`, `OMP/MKL/OPENBLAS_NUM_THREADS`). gpu-server(Ubuntu 20.04)에서 `systemd-run --user`가 된다고 확인했다(2026-11-10, scope `MemoryMax=8589934592`, 친화도 0-3). **안 되는 컴퓨터의 대안**: `start.sh`가 저절로 `ulimit -v 8G` + `taskset -c 0-3`로 바꾼다(가상 메모리 제한이라 실제 사용량 제한보다 거칠다. OpenVINO가 큰 가상 영역을 잡으면 시작이 실패할 수 있으니 그때는 `ulimit` 줄을 빼고 `taskset`만 쓴다).
- 두 모드는 YOLO11s 960으로 사람을 5 Hz에 탐지한다. YOLO11m 384는 사람 탐지 사이에 한 테이블씩 돌아가며 컵을 탐지한다. 카메라당 초당 2.7회이며 확인된 컵은 짧은 탐지 누락 동안 유지한다.
- `--mode gpu`는 같은 체크포인트·입력 크기·주기·판정 코드를 CUDA PyTorch에서 실행한다. `weak`는 OpenVINO INT8로 실행한다.
- `setup.sh` 실행 전에 `models/yolo11m_384x384_int8_openvino_model`에 준비된 컵 모델의 XML, BIN, metadata.yaml을 함께 복사한다. gpu-server에는 이미 있다. GPU용 `yolo11m.pt`는 setup에서 내려받는다.
- T-067 전이나 모델 없이 경로만 볼 때: `CNN_FAKE_DETECTOR=1 start.sh` → 빈 탐지(`tests/fakes.py`)로 영상 경로만 연다.
- openvino 2024.6은 메타데이터에 `numpy<2.2`가 있지만 T-065는 numpy 2.2.6으로 측정했다. 같은 환경을 지키려고 `setup.sh`가 `--no-deps`로 따로 설치한다(`pip check`에 그 경고 한 줄이 남는 것은 정상).
- 로그 `~/navis-cnn-live/logs/server.log`(접속 로그 끔, 프레임·상자·좌표는 남기지 않음), pid `run/server.pid`. 디스크에 쓰는 것은 `data/zones.json` 하나뿐이다.

## 시험

```sh
cd ~/navis-cnn-live && venv/bin/python -m pytest -q app/tests          # gpu-server 전체
cd cnn/live && python -m pytest -q tests -m "not gpu"           # Mac(fastapi·pydantic·segno·httpx·pytest·numpy·opencv 필요)
```

## Navis 쪽 설정

`frontend/.env.local`(git 제외)에 한 줄:

```sh
VITE_CNN_SERVER_URL=https://gpu-server.example.ts.net:8443
```

그다음 `npm run dev`. CNN 서버의 `CNN_ALLOWED_ORIGINS`에 Navis 페이지 주소(출처)가 있어야 한다. 기본값은
`http://127.0.0.1:5173,http://localhost:5173`. 다른 주소(예: gpu-server에서 띄운 Navis를 `http://gpu-server:5173`으로
열 때)는 쉼표로 더해 서버를 다시 켠다:

```sh
CNN_ALLOWED_ORIGINS="http://127.0.0.1:5173,http://localhost:5173,http://gpu-server:5173" ~/navis-cnn-live/app/scripts/start.sh
```

허용 목록에 없는 `Origin`은 HTTP 403 `BAD_ORIGIN`, 보는 소켓은 닫힘 코드 4403. `Origin`이 없는 요청(`curl` 등
브라우저가 아닌 tailnet 기기)은 막지 않는다(ARCHITECTURE 14.8). 카메라 페이지는 서버 자신의 주소(`CNN_PUBLIC_URL`)라 따로 넣지 않는다.

## 환경변수 (`config.py`, 모두 기본값 있음, 비밀값 없음)

| 이름 | 기본 | 뜻 |
| :-- | :-- | :-- |
| `CNN_HOST` / `CNN_PORT` | `127.0.0.1` / `8765` | 바인드 주소(`start.sh`는 항상 127.0.0.1) |
| `CNN_PUBLIC_URL` | `https://gpu-server.example.ts.net:8443` | QR·`cameraUrl`에 넣는 주소 |
| `CNN_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Navis 출처 허용 목록 |
| `CNN_DATA_DIR` / `CNN_MODEL_DIR` | `~/navis-cnn-live/data` / `models` | `zones.json` / 모델 파일 |
| `CNN_MODE` | `weak` | `weak`·`gpu` (`start.sh --mode`가 정함) |
| `CNN_MODEL` / `CNN_SEG_MODEL` / `CNN_IMGSZ` | `yolo11s` / `yolo11s-seg` / 960 | 사람 모델과 입력 크기 |
| `CNN_RUNTIME` / `CNN_DEVICE` / `CNN_HALF` | `openvino-int8` / `cpu` / 0 (gpu: `torch` / `cuda:0`) | |
| `CNN_CPU_THREADS` | 4 | |
| `CNN_DETECT_HZ` | 5 | 사람 탐지 횟수/초 |
| `CNN_BOX_PREDICT` / `CNN_DETECT_PLAN` | `hold` / `full+zones` | 공용 파이프라인은 직전 사람 상자를 유지한다. `full`은 기존 전체 프레임 탐지 경로다. |
| `CNN_OCC_PARAMS` | 비움(= `seat_state.DEFAULTS`) | 점유 판정 값 JSON |
| `CNN_CAMERA_FPS` | 15 | 카메라 페이지 캡처 횟수/초(`hello.fps`, ARCHITECTURE 14.4) |
| `CNN_FAKE_DETECTOR` | 0 | 1이면 빈 탐지 |

## 동작 요약 (R5 참고)

- **짝짓기**: `POST /api/pair {lang, replace}` → `{code, cameraUrl, qrSvg, expiresAt, expiresInSec}`. `expiresAt`은 서버 시계(`time.monotonic()` 초, `status.serverT`와 같은 시계)라 앱은 `expiresInSec` 또는 `serverT`와 비교한다. 새 `POST`는 이전 코드를 무효로 한다. 초당 2번 넘으면 429.
- **카메라 소켓**: `?c=` 처음 / `?s=<token>` 같은 세션 재연결(끊긴 뒤 5분). 서버→휴대폰 `hello`·`ack`·`status ok|replaced|busy`·`ping`(2초마다, 휴대폰은 `{"type":"pong","t":…, "phoneT":…}`로 답해 시계 차를 잰다, 최근 5개 중앙값), 휴대폰→서버 `ping`(→`pong {t, serverT}`). 닫힘 4401·4409·4413·4400.
- **최신만**: 받은 프레임은 한 칸 자리에 들어가고 처리 전에 새 프레임이 오면 앞의 것을 버린다(`stats.dropped`). 작업자 스레드 하나가 `CapturePipeline.step`을 부른다. 사람 탐지와 컵 크롭은 서로 다른 프레임을 사용한다. 서버는 결과에 프레임 정보와 stats를 채워 보낸다. 추천(`/api/zones/suggest`)도 같은 스레드에서 돈다.
- **보기 소켓**: 연결 직후 `status`, 그 뒤 1초마다와 바뀔 때. 프레임은 `[u32 BE 길이][FrameResult JSON][JPEG]`, `subscribe {video:false}`면 JPEG 0바이트. 소켓마다 못 보낸 프레임은 1장만 남긴다. 최대 8개(넘으면 4429).


## 매장 예시 다시 만들기

팀 영상 원본(15 fps 이상)을 같은 캡처 크기·JPEG 품질·탐지 설정으로 재생한다. 기본 영역은
`store_sample_zones.json`이며 서버의 `data/zones.json`과 같은 형식이다. 원본의 15 fps 스트림을 처리하고
5 fps 미리 보기 MP4에 맞춰 결과를 저장한다.

```sh
cd <repository root>
CNN_MODE=weak CNN_MODEL_DIR=/path/to/models /path/to/venv/bin/python cnn/export_store_sample.py /path/to/team-recording.mp4
```

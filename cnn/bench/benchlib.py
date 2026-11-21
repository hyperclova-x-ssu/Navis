"""T-065 측정 공통 도우미. gpu-server 의 ~/navis-cnn-live/ 에서 돌린다(README 참고).
폴더 구조(gpu-server): cnn/{common.py, smooth.py, zones/, bench/}, data/{cafe17.mp4, clip354_1080/}, models/."""
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

BENCH = Path(__file__).resolve().parent
CNN = BENCH.parent
sys.path.insert(0, str(CNN))  # common.py, smooth.py

ROOT = Path(os.environ.get("NAVIS_LIVE", Path.home() / "navis-cnn-live"))
DATA = ROOT / "data"
MODELS = ROOT / "models"
RESULTS = BENCH / "results"
VIDEO = DATA / "cafe17.mp4"
CLIP_1080 = DATA / "clip354_1080"
TABLES = CNN / "zones" / "cafe17_tables.json"
PERSON, CUP_CLASSES, TABLE = 0, (40, 41, 45), 60  # COCO: person, wine glass/cup/bowl, dining table
JPEG_Q = 80  # 휴대폰 브라우저 canvas.toBlob('image/jpeg', 0.8) 가정


def video_frames(path=VIDEO, limit=None):
    """cafe17.mp4 (960x540, 5fps) -> BGR 프레임 목록"""
    cap, out = cv2.VideoCapture(str(path)), []
    while limit is None or len(out) < limit:
        ok, f = cap.read()
        if not ok:
            break
        out.append(f)
    cap.release()
    return out


def clip720_frames():
    """Café 17번 클립 354 원본 1920x1080 35장 -> 1280x720 (휴대폰 해상도 가정)"""
    paths = sorted(CLIP_1080.glob("frames_*.jpg"), key=lambda p: int(p.stem.split("_")[1]))
    return [cv2.resize(cv2.imread(str(p)), (1280, 720), interpolation=cv2.INTER_AREA) for p in paths]


def to_jpeg(frames, q=JPEG_Q):
    return [cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes() for f in frames]


def stats(ms):
    a = np.asarray(ms, float)
    return {"n": int(a.size), "mean_ms": round(float(a.mean()), 2), "p50_ms": round(float(np.percentile(a, 50)), 2),
            "p95_ms": round(float(np.percentile(a, 95)), 2), "max_ms": round(float(a.max()), 2),
            "fps": round(1000.0 / float(a.mean()), 1)}


def sync():
    import torch
    if torch.cuda.is_available():
        torch.cuda.synchronize()


def now_ms():
    return time.perf_counter() * 1000.0


def gpu_mem_reset():
    import torch
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()


def gpu_mem():
    """torch 가 잡은 최대 메모리(MiB). TensorRT 엔진 메모리는 torch 밖이라 nvidia-smi 프로세스 값도 같이 적는다."""
    import torch
    pid = os.getpid()
    smi = None
    try:
        q = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=10).stdout
        for line in q.splitlines():
            p, m = [s.strip() for s in line.split(",")]
            if int(p) == pid:
                smi = int(m)
    except Exception:
        pass
    return {"torch_peak_alloc_mib": round(torch.cuda.max_memory_allocated() / 2**20),
            "torch_peak_reserved_mib": round(torch.cuda.max_memory_reserved() / 2**20),
            "process_nvidia_smi_mib": smi}


def env_info():
    import torch
    import ultralytics
    info = {"host": platform.node(), "python": platform.python_version(), "torch": torch.__version__,
            "cuda": torch.version.cuda, "cudnn": torch.backends.cudnn.version(), "ultralytics": ultralytics.__version__,
            "opencv": cv2.__version__, "numpy": np.__version__,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}
    try:
        import tensorrt
        info["tensorrt"] = tensorrt.__version__
    except Exception as e:
        info["tensorrt"] = f"없음 ({type(e).__name__})"
    return info


def save(name, obj):
    RESULTS.mkdir(parents=True, exist_ok=True)
    obj = {"measuredAt": time.strftime("%Y-%m-%d %H:%M %Z"), "env": env_info(), **obj}
    (RESULTS / name).write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    print("저장:", RESULTS / name)


def load_tables(w, h):
    """cafe17_tables.json(1920x1080 px) -> [0..1] 좌표 테이블과 비품 구역, 그리고 (w,h) 픽셀 다각형"""
    cfg = json.loads(TABLES.read_text())
    sx, sy = cfg["image_size"]
    tables = [{"id": t["id"], "maxBoxH": t["maxBoxH"], "polygon": [[x / sx, y / sy] for x, y in t["polygon"]],
               "px": [[x / sx * w, y / sy * h] for x, y in t["polygon"]]} for t in cfg["tables"]]
    return tables, cfg.get("footFrac", 0.8)


class LivePipeline:
    """한 장씩 들어오는 실시간용: 확인된 추적(N=2) + 앉음 판정 + 1차원 칼만 필터.
    smooth.confirm_tracks / smooth.kalman / export_playback.assign_seats 와 같은 규칙을 한 장 단위로 푼 것
    (bench_pipeline.py 가 끝에 배치 함수와 결과가 같은지 확인한다)."""

    def __init__(self, tables, foot_frac, min_frames=2, q=None, r=None):
        import smooth
        from common import point_in_polygon
        self.pip = point_in_polygon
        self.tables, self.foot = tables, foot_frac
        self.min_frames = min_frames
        self.q = smooth.KALMAN_Q if q is None else q
        self.r = smooth.KALMAN_R if r is None else r
        self.streak = {}
        self.kx = {}  # name -> [x, P]

    def seat(self, p):
        pt = ((p[0] + p[2]) / 2, p[1] + (p[3] - p[1]) * self.foot)
        return next((t["id"] for t in self.tables
                     if (p[3] - p[1]) * 1080 <= t["maxBoxH"] and self.pip(pt, t["polygon"])), None)

    def _kalman(self, name, v):
        if name not in self.kx:
            self.kx[name] = [float(v), float(self.r)]
        s = self.kx[name]
        s[1] += self.q
        k = s[1] / (s[1] + self.r)
        s[0] += k * (v - s[0])
        s[1] *= 1 - k
        return s[0]

    def step(self, persons):
        """persons: [[x1,y1,x2,y2,trackId]] ([0..1] 좌표) -> 이번 장 숫자"""
        cur, keep = {}, []
        for p in persons:
            if p[4] < 0:
                continue
            cur[p[4]] = self.streak.get(p[4], 0) + 1
            if cur[p[4]] >= self.min_frames:
                keep.append(p[:5] + [self.seat(p)])
        self.streak = cur
        occupied = sorted({p[5] for p in keep if p[5]})
        raw_in, raw_seat = len(keep), sum(1 for p in keep if p[5])
        return {"persons": keep, "inStoreRaw": raw_in, "seatedRaw": raw_seat, "occupiedTables": occupied,
                "inStore": int(round(self._kalman("in", raw_in))), "seated": int(round(self._kalman("seat", raw_seat)))}

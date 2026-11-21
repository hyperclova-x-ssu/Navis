"""T-067 추론·추적 (ARCHITECTURE 14.4·14.5). Detector(contracts.py) 구현.

확정 설정(약한 PC 모드 `weak`): YOLO11s · 입력 960(544×960 고정) · OpenVINO INT8(T-065 make_int8.py 가 만든
`yolo11s_544x960_int8_openvino_model`) · 4스레드 · 탐지 초당 5번, 사이 장은 직전 상자 유지(hold).
`gpu` 모드: YOLO11s · 960 · PyTorch CUDA. 탐지 방식은 T-065 bench_cpu.py 의 OpenVINO 경로와 같다
(conf 0.25, ByteTrack 하나를 계속 씀 = persist=True).
full+zones에서는 사람만 탐지하고, 컵은 capture.py 가 별도로 탐지한다. 다른 점: 추적기를 직접 만들어
유지 시간을 '초'로 정한다(CNN_TRACK_SEC, 기본 6초 = T-065 측정의 30번 × 초당 5번).

최신 프레임만 처리하는 자리·작업자 스레드는 server.py(T-066)가 갖는다. 이 파일은 그 작업자 스레드에서만 불린다.
영상·사진을 디스크에 쓰지 않는다.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from contracts import Detections, FrameIn

HERE = Path(__file__).resolve().parent
PERSON = 0
CUP_CLASSES = (40, 41, 45)
CONF = 0.25
RECT = {320: (192, 320), 416: (256, 416), 512: (288, 512), 640: (384, 640), 960: (544, 960), 1280: (736, 1280)}
MODE_DEFAULTS = {
    "weak": {"runtime": "openvino-int8", "model": "yolo11s", "imgsz": 960, "device": "cpu"},
    "gpu": {"runtime": "pt", "model": "yolo11s", "imgsz": 960, "device": "cuda:0"},
}
RUNTIMES = ("openvino-int8", "openvino", "pt")
BOX_PREDICTS = ("hold", "kalman")
DETECT_PLANS = ("full", "full+zones")
TRACK_SEC_DEFAULT = 6.0


def load_numbers():
    """numbers.py 를 파일 경로로 읽는다(표준 라이브러리 numbers 와 이름이 겹쳐 `import numbers`가 표준 모듈을 줄 수 있음).
    server.py 는 `from pipeline import load_numbers; create_engine = load_numbers().create_engine` 로 쓰면 안전하다."""
    m = sys.modules.get("live_numbers")
    if m is None:
        spec = importlib.util.spec_from_file_location("live_numbers", HERE / "numbers.py")
        m = importlib.util.module_from_spec(spec)
        sys.modules["live_numbers"] = m
        spec.loader.exec_module(m)
    return m


def _get(cfg, attr, env, default, cast=str):
    v = getattr(cfg, attr, None) if cfg is not None else None
    if v is None or v == "":
        v = os.environ.get(env, "")
    if v is None or v == "":
        return default
    return cast(v)


def resolve_settings(cfg=None) -> dict:
    """config.Config(T-066) 속성 → 없으면 환경변수 → 없으면 모드 기본값."""
    mode = _get(cfg, "mode", "CNN_MODE", "weak")
    if mode not in MODE_DEFAULTS:
        raise ValueError(f"CNN_MODE={mode!r} (weak|gpu)")
    d = MODE_DEFAULTS[mode]
    runtime = _get(cfg, "runtime", "CNN_RUNTIME", d["runtime"])
    runtime = {"ov_int8": "openvino-int8", "int8": "openvino-int8", "torch": "pt"}.get(runtime, runtime)
    s = {
        "mode": mode,
        "runtime": runtime,
        "model": _get(cfg, "model", "CNN_MODEL", d["model"]),
        "imgsz": _get(cfg, "imgsz", "CNN_IMGSZ", d["imgsz"], int),
        "device": _get(cfg, "device", "CNN_DEVICE", d["device"]),
        "detect_hz": _get(cfg, "detect_hz", "CNN_DETECT_HZ", 5.0, float),
        "box_predict": _get(cfg, "box_predict", "CNN_BOX_PREDICT", "hold"),
        "detect_plan": _get(cfg, "detect_plan", "CNN_DETECT_PLAN", "full"),
        "cpu_threads": _get(cfg, "cpu_threads", "CNN_CPU_THREADS", 4, int),
        "track_sec": _get(cfg, "track_sec", "CNN_TRACK_SEC", TRACK_SEC_DEFAULT, float),
        "model_dir": Path(_get(cfg, "model_dir", "CNN_MODEL_DIR",
                               str(Path(os.environ.get("NAVIS_LIVE", Path.home() / "navis-cnn-live")) / "models"))),
        "half": bool(_get(cfg, "half", "CNN_HALF", False, lambda v: v if isinstance(v, bool) else str(v).lower() in ("1", "true"))),
    }
    if s["runtime"] not in RUNTIMES:
        raise ValueError(f"CNN_RUNTIME={s['runtime']!r} ({'|'.join(RUNTIMES)})")
    if s["box_predict"] not in BOX_PREDICTS:
        raise ValueError(f"CNN_BOX_PREDICT={s['box_predict']!r} ({'|'.join(BOX_PREDICTS)})")
    if s["detect_plan"] not in DETECT_PLANS:
        raise ValueError(f"CNN_DETECT_PLAN={s['detect_plan']!r} (full|full+zones)")
    if (s["runtime"] != "pt" or s["detect_plan"] == "full+zones") and s["imgsz"] not in RECT:
        raise ValueError(f"CNN_IMGSZ={s['imgsz']} (OpenVINO 고정 크기: {sorted(RECT)})")
    if s["detect_hz"] < 0:
        raise ValueError("CNN_DETECT_HZ >= 0 (0 = 매 장)")
    return s


def model_path(s: dict) -> Path:
    name, md = s["model"], s["model_dir"]
    if s["runtime"] == "pt":
        return md / f"{name}.pt"
    h, w = RECT[s["imgsz"]]
    suffix = "_int8_openvino_model" if s["runtime"] == "openvino-int8" else "_openvino_model"
    return md / f"{name}_{h}x{w}{suffix}"


def set_threads(n: int) -> None:
    """torch·OpenCV·OpenVINO 스레드 수(bench_cpu.py 와 같은 방법: ultralytics 가 OpenVINO 스레드를 정하지 않아 덮어씀)."""
    os.environ.setdefault("OMP_NUM_THREADS", str(n))
    try:
        import cv2
        cv2.setNumThreads(n)
    except ImportError:
        pass
    try:
        import torch
        torch.set_num_threads(n)
    except ImportError:
        pass
    try:
        import openvino as ov
        if not getattr(ov.Core.compile_model, "_navis_threads", None):
            orig = ov.Core.compile_model

            def compile_model(self, model, device_name=None, config=None, **k):
                config = dict(config or {})
                config["INFERENCE_NUM_THREADS"] = compile_model._navis_threads
                return orig(self, model, device_name, config, **k)
            compile_model._navis_threads = n
            ov.Core.compile_model = compile_model
        else:
            ov.Core.compile_model._navis_threads = n
    except ImportError:
        pass


class DetectSchedule:
    """탐지할 프레임 고르기: 직전 탐지에서 0.8/hz 초 넘게 지났으면 탐지(15장/초·5Hz → 3장마다, 시계 흔들림 허용)."""

    def __init__(self, hz: float):
        self.hz = hz
        self.last = None

    def due(self, t: float) -> bool:
        if self.hz <= 0 or self.last is None or t - self.last >= 0.8 / self.hz - 1e-9 or t < self.last:
            return True
        return False

    def mark(self, t: float) -> None:
        self.last = t

    def reset(self) -> None:
        self.last = None


def _decode(frame: FrameIn):
    if getattr(frame, "image", None) is not None:
        return frame.image
    import cv2
    img = cv2.imdecode(np.frombuffer(frame.jpeg, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("JPEG 디코딩 실패")
    frame.image = img
    return img


def split_tracks(tracks: np.ndarray, w: int, h: int) -> Detections:
    """ByteTrack 출력 [x1,y1,x2,y2,id,score,cls,idx](픽셀) -> 0~1 Detections(사람: 추적 번호, 컵: 상자만)."""
    persons, cups = [], []
    if tracks is not None and len(tracks):
        sc = np.array([w, h, w, h], dtype=np.float64)
        for row in tracks:
            x1, y1, x2, y2 = np.clip(np.asarray(row[:4], np.float64) / sc, 0.0, 1.0).tolist()
            cls = int(row[6])
            if cls == PERSON:
                persons.append((x1, y1, x2, y2, int(row[4])))
            elif cls in CUP_CLASSES:
                cups.append((x1, y1, x2, y2))
    return Detections(persons=persons, cups=cups)


def box_center_x(box):
    return (box[0] + box[2]) / 2


def same_person_head(left, right):
    """A full-body detection and its short fragment often share a head."""
    width = max(left[2] - left[0], right[2] - right[0])
    return (abs(left[1] - right[1]) <= 0.015
            and abs(box_center_x(left) - box_center_x(right)) <= min(0.02, width / 2))


class YoloDetector:
    """Detector(contracts.py). detect = 탐지+추적, predict = 사이 장(hold: 직전 상자 / kalman: 등속 예측)."""

    def __init__(self, settings: dict, model=None, tracker_factory=None):
        self.s = settings
        self.schedule = DetectSchedule(settings["detect_hz"])
        self.model = model if model is not None else self._load_model()
        self._tracker_factory = tracker_factory or self._bytetrack
        self.tracker = self._tracker_factory()
        self.last = Detections()
        self.last_t = None
        self.prev = {}  # track_id -> [(t, box)] 직전 두 번 탐지 (kalman 예측용)
        self.infer_ms = 0.0
        self.detect_count = 0

    # ---------- 만들기 ----------
    def _load_model(self):
        os.environ.setdefault("YOLO_AUTOINSTALL", "False")
        os.environ.setdefault("YOLO_OFFLINE", "True")
        set_threads(self.s["cpu_threads"])
        from ultralytics import YOLO
        p = model_path(self.s)
        if not p.exists():
            hint = " (T-065 make_int8.py 로 만든 모델)" if self.s["runtime"] == "openvino-int8" else ""
            raise FileNotFoundError(f"모델 없음: {p}{hint}")
        return YOLO(str(p), task="detect")

    def _bytetrack(self):
        from ultralytics.trackers.byte_tracker import BYTETracker
        hz = self.s["detect_hz"] if self.s["detect_hz"] > 0 else float(os.environ.get("CNN_CAMERA_FPS", 15))
        args = SimpleNamespace(tracker_type="bytetrack", track_high_thresh=0.25, track_low_thresh=0.1,
                               new_track_thresh=0.25, track_buffer=max(1, int(round(self.s["track_sec"] * hz))),
                               match_thresh=0.8, fuse_score=True)
        from ultralytics.trackers.basetrack import BaseTrack
        keep = BaseTrack._count  # 새 추적기도 번호를 이어서(재연결 뒤 옛 번호와 섞이지 않게)
        try:
            tr = BYTETracker(args=args, frame_rate=30)  # 8.4.41: max_time_lost = 30/30 × track_buffer
        except TypeError:
            tr = BYTETracker(args=args)  # 8.4.51: max_frames_lost = track_buffer
        BaseTrack._count = keep
        return tr  # 유지 = track_buffer 번의 탐지 = track_sec 초

    def _predict_kw(self):
        imgsz = self.s["imgsz"] if self.s["runtime"] == "pt" else list(RECT[self.s["imgsz"]])
        kw = dict(imgsz=imgsz, classes=[PERSON, *CUP_CLASSES], conf=CONF, device=self.s["device"], verbose=False)
        if self.s["detect_plan"] == "full+zones":
            kw.update(imgsz=list(RECT[self.s["imgsz"]]), classes=[PERSON], rect=False)
        if self.s["runtime"] == "pt" and self.s["half"]:
            kw["half"] = True
        return kw

    def warmup(self, w: int = 1280, h: int = 720) -> float:
        """예열 1회(첫 추론의 컴파일·메모리 잡기). 추적기는 비운다. -> 걸린 ms"""
        t0 = time.perf_counter()
        self.model.predict(np.zeros((h, w, 3), np.uint8), **self._predict_kw())
        self.reset_tracker()
        return (time.perf_counter() - t0) * 1000

    # ---------- Detector ----------
    def due(self, t: float) -> bool:
        """server.py 작업자가 이 프레임을 탐지할지 묻는 도우미(초당 CNN_DETECT_HZ번)."""
        return self.schedule.due(t)

    def detect(self, frame: FrameIn, zones=None) -> Detections:
        t0 = time.perf_counter()
        img = _decode(frame)
        r = self.model.predict(img, **self._predict_kw())[0]
        boxes = r.boxes.cpu().numpy()
        tracks = self.tracker.update(boxes, img)
        h, w = img.shape[:2]
        d = split_tracks(tracks, w, h)
        if self.s["detect_plan"] == "full+zones":
            coordinates = np.clip(boxes.xyxy / [w, h, w, h], 0.0, 1.0)
            order = np.argsort(-boxes.conf, kind="stable")
            d.person_observations = [tuple(coordinates[i]) for i in order]
        self.infer_ms = (time.perf_counter() - t0) * 1000
        t = frame.capture_t
        self.schedule.mark(t)
        self.detect_count += 1
        if self.s["box_predict"] == "kalman":
            for p in d.persons:
                self.prev[p[4]] = (self.prev.get(p[4], []) + [(t, p[:4])])[-2:]
            alive = {p[4] for p in d.persons}
            self.prev = {k: v for k, v in self.prev.items() if k in alive}
        self.last, self.last_t = d, t
        return d

    def predict(self, frame: FrameIn, dt: float = 0.0) -> Detections:
        """사이 장. hold = 직전 상자 그대로(확정 설정). kalman = 직전 두 번 탐지의 속도로 등속 이동(선택)."""
        if self.s["box_predict"] == "kalman" and self.last_t is not None:
            el = max(0.0, frame.capture_t - self.last_t) if dt <= 0 else dt
            persons = []
            for p in self.last.persons:
                h = self.prev.get(p[4], [])
                if len(h) == 2 and h[1][0] > h[0][0]:
                    v = (np.asarray(h[1][1]) - np.asarray(h[0][1])) / (h[1][0] - h[0][0])
                    b = np.clip(np.asarray(h[1][1]) + v * el, 0.0, 1.0).tolist()
                    persons.append((*b, p[4]))
                else:
                    persons.append(p)
            d = Detections(persons=persons, cups=list(self.last.cups))
        else:
            d = Detections(persons=list(self.last.persons), cups=list(self.last.cups))
        d.predicted = True  # numbers.py: 사이 장은 점유·추적 확인을 갱신하지 않음
        return d

    def reset_tracker(self) -> None:
        self.tracker = self._tracker_factory()
        self.last, self.last_t, self.prev = Detections(), None, {}
        self.schedule.reset()

    def info(self) -> dict:
        """/api/health 용 설정값(API-14)."""
        s = self.s
        return {"mode": s["mode"], "device": "cpu" if s["device"] == "cpu" else "cuda", "cpuThreads": s["cpu_threads"],
                "runtime": s["runtime"], "model": s["model"], "imgsz": s["imgsz"], "detectHz": s["detect_hz"],
                "boxPredict": s["box_predict"], "detectPlan": s["detect_plan"]}


def create_detector(cfg=None, warmup: bool = True) -> YoloDetector:
    """config.Config -> Detector. 모델을 읽고 예열 1회."""
    s = resolve_settings(cfg)
    if s["mode"] == "weak" and s["device"] != "cpu":
        raise ValueError("weak 모드는 GPU 를 쓰지 않음(CNN_DEVICE=cpu)")
    det = YoloDetector(s)
    if warmup:
        det.warmup()
    return det

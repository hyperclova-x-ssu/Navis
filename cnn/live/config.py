"""Server settings from environment variables (ARCHITECTURE 6절 끝 표, 12.4). No secrets here."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_ORIGINS = "http://127.0.0.1:5173,http://localhost:5173"
HOME = Path.home()


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v.strip() == "" else v.strip()


def _int(name: str, default: int) -> int:
    return int(_env(name, str(default)))


def _float(name: str, default: float) -> float:
    return float(_env(name, str(default)))


@dataclass
class Config:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    public_url: str = f"http://{DEFAULT_HOST}:{DEFAULT_PORT}"
    allowed_origins: tuple = tuple(DEFAULT_ORIGINS.split(","))
    data_dir: Path = HOME / "navis-cnn-live" / "data"
    model_dir: Path = HOME / "navis-cnn-live" / "models"
    model: str = "yolo11s"
    seg_model: str = "yolo11s-seg"
    imgsz: int = 960
    mode: str = "weak"            # weak | gpu
    cpu_threads: int = 4
    detect_hz: float = 5.0        # 0 = every frame
    box_predict: str = "hold"     # hold | kalman
    detect_plan: str = "full+zones"     # full | full+zones
    runtime: str = "openvino-int8"  # gpu mode: torch
    occ_params: dict = field(default_factory=dict)
    half: bool = False
    device: str = "cpu"           # gpu mode: cuda:0
    fps: int = 15                 # camera capture rate sent in hello
    max_edge: int = 1280
    quality: float = 0.8
    fake_detector: bool = False   # CNN_FAKE_DETECTOR=1 -> tests/fakes.py empty detector + engine
    pair_ttl_sec: float = 600.0
    session_ttl_sec: float = 300.0  # reconnect window for ?s=<token> after the camera socket closes
    version: str = "5.0.0"

    @property
    def zones_path(self) -> Path:
        return Path(self.data_dir) / "zones.json"


def load_config() -> Config:
    port = _int("CNN_PORT", DEFAULT_PORT)
    public_host = _env("NAVIS_CNN_PUBLIC_HOST", "")
    public_url = f"https://{public_host}:8443" if public_host else f"http://{DEFAULT_HOST}:{port}"
    mode = _env("CNN_MODE", "weak")
    gpu = mode == "gpu"
    occ_raw = _env("CNN_OCC_PARAMS", "")
    occ = json.loads(occ_raw) if occ_raw else {}
    if not isinstance(occ, dict):
        raise ValueError("CNN_OCC_PARAMS must be a JSON object")
    return Config(
        host=_env("CNN_HOST", DEFAULT_HOST),
        port=port,
        public_url=_env("CNN_PUBLIC_URL", public_url).rstrip("/"),
        allowed_origins=tuple(o.strip().rstrip("/") for o in _env("CNN_ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
                              if o.strip()),
        data_dir=Path(os.path.expanduser(_env("CNN_DATA_DIR", str(HOME / "navis-cnn-live" / "data")))),
        model_dir=Path(os.path.expanduser(_env("CNN_MODEL_DIR", str(HOME / "navis-cnn-live" / "models")))),
        model=_env("CNN_MODEL", "yolo11s"),
        seg_model=_env("CNN_SEG_MODEL", "yolo11s-seg"),
        imgsz=_int("CNN_IMGSZ", 960),
        mode=mode,
        cpu_threads=_int("CNN_CPU_THREADS", 4),
        detect_hz=_float("CNN_DETECT_HZ", 5),
        box_predict=_env("CNN_BOX_PREDICT", "hold"),
        detect_plan=_env("CNN_DETECT_PLAN", "full+zones"),
        runtime=_env("CNN_RUNTIME", "torch" if gpu else "openvino-int8"),
        occ_params=occ,
        half=_env("CNN_HALF", "0") == "1",
        device=_env("CNN_DEVICE", "cuda:0" if gpu else "cpu"),
        fps=_int("CNN_CAMERA_FPS", 15),
        fake_detector=_env("CNN_FAKE_DETECTOR", "0") == "1",
    )

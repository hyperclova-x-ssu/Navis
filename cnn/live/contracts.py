"""Shared contracts between server.py (T-066), pipeline.py/numbers.py (T-067) and zones.py/suggest.py (T-068).

Source of truth: ARCHITECTURE 14.5, DATA_MODEL 12.2/12.4, API_CONTRACT API-14~18.

- Internal per-frame objects (FrameIn, Detections, FrameResult) are plain dataclasses (cheap at 15 fps).
- Incoming wire messages (camera header, view subscribe, pair body, ping) are pydantic models.
- Zone types live in zones.py (T-068, dataclasses with to_dict/from_dict). Here they are Protocols that
  describe the attributes the other parts may rely on; zones.py exceptions InvalidZones/RevisionConflict
  are the ones server.py catches.
- server.py imports only the names below plus create_detector / create_engine / FileZoneStore / suggest_zones.
"""
from __future__ import annotations

import json
import struct
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------- limits (API 공통 약속 v5, ARCHITECTURE 14.8)

MAX_HTTP_BODY = 256 * 1024
MAX_WS_TEXT = 64 * 1024
MAX_CAMERA_BINARY = 1024 * 1024
MAX_VIEWERS = 8
PAIR_RATE_PER_SEC = 2
GRID_COLS, GRID_ROWS = 160, 90
CUP_CLASSES = (40, 41, 45)

# socket close codes (API-16/17)
CLOSE_BAD_FORMAT = 4400
CLOSE_BAD_CODE = 4401
CLOSE_BAD_ORIGIN = 4403
CLOSE_REPLACED = 4409
CLOSE_TOO_BIG = 4413
CLOSE_TOO_MANY = 4429

CameraState = Literal["none", "waiting", "connected", "live"]


# ---------------------------------------------------------------- per-frame objects

@dataclass
class FrameIn:
    """A received camera frame. Times are server monotonic seconds."""
    frame_id: int
    capture_t: float  # phone clock converted to server clock
    recv_t: float
    jpeg: bytes
    w: int
    h: int
    image: Any = None  # decoded BGR np.ndarray, filled lazily by whoever decodes first (server worker decodes once)


@dataclass
class Detections:
    """One frame's detections. Coordinates 0..1. Track ids stay inside the server."""
    persons: list = field(default_factory=list)  # [(x1, y1, x2, y2, track_id)], track_id -1 = none
    cups: list = field(default_factory=list)     # [(x1, y1, x2, y2)] COCO 40/41/45 only
    person_observations: list | None = None     # pre-tracking boxes, strongest first (full+zones)


@dataclass
class Counts:
    inStore: int = 0
    occupants: int = 0
    inStoreRaw: int = 0
    occupantsRaw: int = 0
    occupiedTables: list = field(default_factory=list)   # zoneId
    tablesToClear: list = field(default_factory=list)    # zoneId


@dataclass
class FrameStats:
    fps: float = 0.0
    detectFps: float = 0.0
    inferMs: float = 0.0
    latencyMs: float = 0.0
    dropped: int = 0


@dataclass
class FrameResult:
    """API-17 frame header (DATA_MODEL 12.4). Field names = JSON names.

    NumberEngine.update() fills persons/cups/counts/change5m/tableOccupiedSeconds/avgOccupiedSeconds
    (persons WITHOUT track ids: [x1, y1, x2, y2, zoneId|None]). server.py then fills frameId, detected,
    w, h, captureT, recvT, doneT, zonesRevision and stats with dataclasses.replace().
    """
    persons: list = field(default_factory=list)   # [[x1, y1, x2, y2, zoneId|None]]
    cups: list = field(default_factory=list)      # [[x1, y1, x2, y2]]
    counts: Counts = field(default_factory=Counts)
    change5m: Optional[int] = None
    tableOccupiedSeconds: dict = field(default_factory=dict)  # zoneId -> seconds (1 decimal)
    avgOccupiedSeconds: Optional[float] = None
    # filled by server.py
    type: str = "frame"
    frameId: int = 0
    detected: bool = False
    w: int = 0
    h: int = 0
    captureT: float = 0.0
    recvT: float = 0.0
    doneT: float = 0.0
    zonesRevision: int = 0
    stats: FrameStats = field(default_factory=FrameStats)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["persons"] = [[_r3(p[0]), _r3(p[1]), _r3(p[2]), _r3(p[3]), p[4] if len(p) > 4 else None]
                        for p in self.persons]
        d["cups"] = [[_r3(c[0]), _r3(c[1]), _r3(c[2]), _r3(c[3])] for c in self.cups]
        for k in ("captureT", "recvT", "doneT"):
            d[k] = round(d[k], 3)
        return d


def _r3(v: float) -> float:
    return round(float(v), 3)


# ---------------------------------------------------------------- binary framing (API-16 / API-17)

def pack_frame(header: dict, payload: bytes) -> bytes:
    """[u32 BE header length][header JSON UTF-8][payload]"""
    h = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return struct.pack(">I", len(h)) + h + payload


def unpack_frame(data: bytes, max_header: int = MAX_WS_TEXT) -> tuple[dict, bytes]:
    """Inverse of pack_frame. Raises ValueError on a malformed message."""
    if len(data) < 4:
        raise ValueError("too short")
    (n,) = struct.unpack(">I", data[:4])
    if n <= 0 or n > max_header or 4 + n > len(data):
        raise ValueError("bad header length")
    header = json.loads(data[4:4 + n].decode("utf-8"))
    if not isinstance(header, dict):
        raise ValueError("header must be an object")
    return header, data[4 + n:]


# ---------------------------------------------------------------- wire messages (pydantic)

class _Msg(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=False)


class CameraFrameHeader(_Msg):
    frameId: int = Field(ge=0)
    captureT: float
    w: int = Field(gt=0, le=4096)
    h: int = Field(gt=0, le=4096)


class PingMsg(_Msg):
    type: Literal["ping"]
    t: float


class PongMsg(_Msg):
    type: Literal["pong"]
    t: float
    serverT: Optional[float] = None


class SubscribeMsg(_Msg):
    type: Literal["subscribe"]
    video: bool = True


class PairBody(_Msg):
    lang: Literal["ko", "en", "zh-Hans", "zh-Hant"] = "ko"
    replace: bool = False


# ---------------------------------------------------------------- zones (shape of zones.py dataclasses)

class Zone(Protocol):
    id: str
    number: int
    source: str
    mask: dict  # {"cols":160, "rows":90, "runs":[...]}


class ZoneSet(Protocol):
    revision: int
    saved_at: Optional[str]
    frame_aspect: Optional[float]
    zones: list  # list[Zone]

    def to_dict(self) -> dict: ...


class ZoneSetIn(Protocol):
    frame_aspect: Optional[float]
    zones: list


# ---------------------------------------------------------------- parts (Protocols)

@runtime_checkable
class Detector(Protocol):  # pipeline.py (T-067)
    # worker thread only, CNN_DETECT_HZ times per second. zones are for D-375 B (crop plan); `full` ignores them.
    def detect(self, frame: FrameIn, zones: ZoneSet) -> Detections: ...

    # frames that are not detected: hold (previous boxes) by default, kalman optional. dt = s since last detect.
    def predict(self, frame: FrameIn, dt: float) -> Detections: ...

    def reset_tracker(self) -> None: ...


@runtime_checkable
class NumberEngine(Protocol):  # numbers.py (T-067)
    def update(self, t: float, det: Detections, zones: ZoneSet) -> FrameResult: ...
    def reset(self) -> None: ...
    def occupancy_heat(self) -> Any: ...  # np.ndarray 90x160 seconds, for suggest (b)


@runtime_checkable
class ZoneStore(Protocol):  # zones.py (T-068)
    def load(self) -> ZoneSet: ...
    def save(self, zs: ZoneSetIn, base_revision: int) -> ZoneSet: ...  # zones.RevisionConflict if different


# Factories (implemented elsewhere, imported lazily by server.py):
#   pipeline.create_detector(cfg) -> Detector
#   numbers.create_engine(cfg) -> NumberEngine
#   zones.FileZoneStore(path)   -> ZoneStore (+ on_change(cb))
#   suggest.suggest_zones(jpeg, existing, occupancy_heat) -> list[Zone]   (runs on the worker thread)
# cfg is config.Config (attributes: mode, device, cpu_threads, runtime, model, seg_model, imgsz, half,
#   detect_hz, box_predict, detect_plan, occ_params, model_dir, data_dir, fps).

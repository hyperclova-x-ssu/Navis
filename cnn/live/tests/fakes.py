"""Fakes for T-066 server tests and for running the server before T-067 (CNN_FAKE_DETECTOR=1).

FakeDetector returns empty detections (optionally sleeping to emulate a slow worker); FakeEngine turns them
into an all-zero FrameResult. No frame is decoded or stored.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

import os
import sys

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import contracts as C  # noqa: E402


class FakeDetector:
    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.detected_ids: list = []
        self.predicted_ids: list = []
        self.resets = 0
        self.gate: threading.Event | None = None  # tests can block the worker on this

    def detect(self, frame: C.FrameIn, zones) -> C.Detections:
        if self.gate is not None:
            self.gate.wait(5)
        if self.delay:
            time.sleep(self.delay)
        self.detected_ids.append(frame.frame_id)
        return C.Detections()

    def predict(self, frame: C.FrameIn, dt: float) -> C.Detections:
        self.predicted_ids.append(frame.frame_id)
        return C.Detections()

    def reset_tracker(self) -> None:
        self.resets += 1


class FakeEngine:
    def __init__(self):
        self.updates = 0
        self.resets = 0
        self.track_resets = 0

    def update(self, t: float, det: C.Detections, zones) -> C.FrameResult:
        self.updates += 1
        return C.FrameResult()

    def reset(self) -> None:
        self.resets += 1

    def reset_tracks(self) -> None:
        self.track_resets += 1

    def occupancy_heat(self):
        return None


@dataclass
class FakeZoneSet:
    revision: int = 0
    saved_at: str | None = None
    frame_aspect: float | None = None
    zones: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"revision": self.revision, "savedAt": self.saved_at, "frameAspect": self.frame_aspect,
                "zones": list(self.zones)}

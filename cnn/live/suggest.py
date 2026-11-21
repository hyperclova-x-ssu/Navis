"""Suggested table zones (T-068, ARCHITECTURE 14.4, API-18 suggest).

(a) yolo11s-seg `dining table` masks of one recent frame, reduced to the 160x90 grid
    (cell = 1 when >=50% covered)
(b) accumulated seated-person anchor heat (NumberEngine.occupancy_heat(), 90x160, seconds)
Merged: candidates overlapping >50% (of the smaller) become one; <12 cells dropped; max 12.
Call from the GPU worker thread so it never overlaps the tracking model.
The model loads on first call. No images are written to disk.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Callable, Optional

import cv2
import numpy as np

from zones import (COLS, ROWS, MIN_ZONE_CELLS, Zone, ZoneSet, decode_runs, encode_mask,
                   new_zone_id)

MAX_SUGGESTIONS = 12
DINING_TABLE_CLASS = 60            # COCO
SEG_IMGSZ = 960
OVERLAP_MERGE = 0.5
HEAT_MIN_S = 3.0                   # seconds of seated anchor per cell to count [estimate]
HEAT_DILATE = (7, 5)               # (cols, rows) kernel grouping neighbouring anchors [estimate]

# segmenter: (bgr image) -> list of float masks (ROWS, COLS) in 0..1 coverage per grid cell
Segmenter = Callable[[np.ndarray], list]
_segmenter: Optional[Segmenter] = None
_lock = threading.Lock()


@dataclass
class SuggestedZone(Zone):
    method: str = "segment"        # 'segment' | 'seated' (record only, not stored)

    def to_dict(self) -> dict:
        d = Zone.to_dict(self)
        d["method"] = self.method
        return d


def set_segmenter(fn: Optional[Segmenter]) -> None:
    """Inject a segmenter (tests) or reset to the default (None)."""
    global _segmenter
    _segmenter = fn


def _default_segmenter() -> Segmenter:
    from ultralytics import YOLO  # lazy
    model = YOLO(os.environ.get("CNN_SEG_MODEL", "yolo11s-seg.pt"))
    device = os.environ.get("CNN_SEG_DEVICE", "cpu")

    def run(img: np.ndarray) -> list:
        res = model.predict(img, imgsz=SEG_IMGSZ, device=device, classes=[DINING_TABLE_CLASS],
                            verbose=False)[0]
        out = []
        if res.masks is None:
            return out
        k = 10  # supersample factor for the 50% rule
        for poly in res.masks.xyn:
            if len(poly) < 3:
                continue
            canvas = np.zeros((ROWS * k, COLS * k), dtype=np.uint8)
            pts = np.round(poly * [COLS * k, ROWS * k]).astype(np.int32)
            cv2.fillPoly(canvas, [pts], 1)
            out.append(cv2.resize(canvas.astype(np.float32), (COLS, ROWS), interpolation=cv2.INTER_AREA))
        return out
    return run


def _get_segmenter() -> Segmenter:
    global _segmenter
    if _segmenter is None:
        _segmenter = _default_segmenter()
    return _segmenter


def _heat_candidates(heat: Optional[np.ndarray]) -> list:
    if heat is None:
        return []
    h = np.asarray(heat, dtype=np.float32)
    if h.shape != (ROWS, COLS):
        raise ValueError(f"occupancy_heat must be ({ROWS},{COLS}), got {h.shape}")
    m = (h >= HEAT_MIN_S).astype(np.uint8)
    if not m.any():
        return []
    m = cv2.dilate(m, np.ones((HEAT_DILATE[1], HEAT_DILATE[0]), np.uint8))
    n, labels = cv2.connectedComponents(m, connectivity=8)
    return [labels == i for i in range(1, n)]


def _merge(cands: list) -> list:
    """cands: list of (mask, method). Merge pairs overlapping > 50% of the smaller."""
    cands = [(m.copy(), meth) for m, meth in cands]
    changed = True
    while changed:
        changed = False
        for i in range(len(cands)):
            for j in range(i + 1, len(cands)):
                a, b = cands[i][0], cands[j][0]
                inter = int((a & b).sum())
                small = min(int(a.sum()), int(b.sum()))
                if small and inter / small > OVERLAP_MERGE:
                    meth = "segment" if "segment" in (cands[i][1], cands[j][1]) else "seated"
                    cands[i] = (a | b, meth)
                    del cands[j]
                    changed = True
                    break
            if changed:
                break
    return cands


def combine(seg_masks: list, heat: Optional[np.ndarray], existing: Optional[ZoneSet]) -> list:
    """Pure merge step (no model). seg_masks: 0..1 coverage grids. Returns SuggestedZone list."""
    cands = [(np.asarray(m) >= 0.5, "segment") for m in seg_masks]
    cands += [(m, "seated") for m in _heat_candidates(heat)]
    taken = np.zeros((ROWS, COLS), dtype=bool)
    if existing is not None:
        for z in existing.zones:
            taken |= decode_runs(z.mask["runs"])
    cands = [(m & ~taken, meth) for m, meth in _merge(cands)]
    cands = [c for c in cands if c[0].sum() >= MIN_ZONE_CELLS]
    cands.sort(key=lambda c: -int(c[0].sum()))
    out, used, ids = [], np.zeros((ROWS, COLS), dtype=bool), set()
    for m, meth in cands:
        m = m & ~used                      # keep zones disjoint (invariant 3)
        if m.sum() < MIN_ZONE_CELLS:
            continue
        used |= m
        zid = new_zone_id(ids)
        ids.add(zid)
        out.append(SuggestedZone(id=zid, number=0, source="suggested",
                                 mask={"cols": COLS, "rows": ROWS, "runs": encode_mask(m)},
                                 method=meth))
        if len(out) == MAX_SUGGESTIONS:
            break
    return out


def suggest_zones(jpeg: bytes, existing: ZoneSet, occupancy_heat: "np.ndarray | None") -> list:
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR) if jpeg else None
    if img is None:
        raise ValueError("cannot decode jpeg")
    with _lock:   # one model run at a time
        masks = _get_segmenter()(img)
    return combine(masks, occupancy_heat, existing)

"""The causal capture pipeline used by the live worker and recorded replay."""
from dataclasses import dataclass
from math import ceil, floor, hypot
from time import perf_counter

import numpy as np

from contracts import Detections, FrameResult
from pipeline import _decode, box_center_x, create_detector, load_numbers, resolve_settings, same_person_head
from zones import COLS, ROWS, decode_runs

CUP_MODEL = "yolo11m"
CUP_IMGSZ = 384
CUP_SCAN_HZ = 2.7  # total across the camera, independent of the number of tables
CUP_CONF = 0.22
CUP_CONFIRMATIONS = 2
CUP_TIMEOUT_SEC = 20
CUP_NEAR_SEC = 4
CUP_MISSES = 5

PERSON_HOLD_SEC = 1.2
PERSON_ENTER_SEC = 0.6
EPS = 1e-9


def _distinct_people(boxes):
    kept = []
    for box in boxes:
        if not any(same_person_head(box, other) for other in kept):
            kept.append(box)
    return kept


def _head_match(box, previous):
    """Match nearby overlapping observations across ByteTrack ID changes."""
    dx = abs(box_center_x(box) - box_center_x(previous))
    dy = abs(box[1] - previous[1])
    if dy > 0.055 or dx > max(0.025, (previous[2] - previous[0]) * 0.8):
        return None
    w = min(box[2], previous[2]) - max(box[0], previous[0])
    h = min(box[3], previous[3]) - max(box[1], previous[1])
    smaller = min((p[2] - p[0]) * (p[3] - p[1]) for p in (box, previous))
    return dx + dy if w > 0 and h > 0 and w * h >= 0.28 * smaller else None


@dataclass
class DisplayTrack:
    seen: float
    first_seen: float
    box: tuple
    exiting: bool = False


class StablePeople:
    """Delay increases and retain recently seen boxes through brief occlusions."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.recent = []
        self.streaks = {}
        self.count = None
        self.pending = None
        self.measured = 0
        self.seat_boxes = []

    def update(self, t, boxes, observations=None):
        self.streaks = {p[4]: self.streaks.get(p[4], 0) + 1 for p in boxes}
        self.seat_boxes = [p for p in boxes if self.streaks[p[4]] >= 2]
        self.measured = len(self.seat_boxes)
        if observations is None:
            visible = _distinct_people(sorted(boxes, key=lambda p: p[1] - p[3]))
        else:
            visible = _distinct_people(observations)
            visible = [self._link_seat_id(p, boxes) for p in visible]
        self._refresh_tracks(t, visible)
        held = [tr.box for tr in sorted(self.recent, key=lambda tr: -tr.seen) if tr.seen < t]
        available = _distinct_people(visible + held)
        fresh = len(visible)
        if self.count is None:
            self.count = fresh
        if fresh > self.count:
            if self.pending is None or self.pending[0] != fresh:
                self.pending = (fresh, t)
            if t - self.pending[1] >= PERSON_ENTER_SEC - EPS:
                self.count = fresh
                self.pending = None
        else:
            self.pending = None
        self.count = min(self.count, len(available))
        if fresh > self.count:
            available = [track.box for track in sorted(
                (tr for tr in self.recent if tr.seen == t), key=lambda tr: tr.first_seen)]
        return available[:self.count]

    @staticmethod
    def _link_seat_id(box, tracks):
        _, tid = min(((cost, p[4]) for p in tracks if (cost := _head_match(box, p)) is not None),
                     default=(float("inf"), -1))
        return (*box, tid)

    def _refresh_tracks(self, t, visible):
        recent = [tr for tr in self.recent if not tr.exiting and t - tr.seen <= PERSON_HOLD_SEC + EPS]
        matches = []
        for i, box in enumerate(visible):
            for j, track in enumerate(recent):
                cost = _head_match(box, track.box)
                if cost is not None:
                    matches.append((cost + 0.025 * (t - track.seen), j, i))
        used, seen = set(), set()
        for _, j, i in sorted(matches):
            if j in used or i in seen:
                continue
            track, box = recent[j], visible[i]
            dx = box_center_x(box) - box_center_x(track.box)
            exiting = (box[0] <= 0.005 and dx < -0.006) or (box[2] >= 0.995 and dx > 0.006)
            recent[j] = DisplayTrack(t, track.first_seen, box, exiting)
            used.add(j)
            seen.add(i)
        recent.extend(DisplayTrack(t, t, box) for i, box in enumerate(visible) if i not in seen)
        self.recent = recent


def _same_cup(a, b):
    width = max(a[2] - a[0], b[2] - b[0])
    return (abs(a[0] + a[2] - b[0] - b[2]) / 2 <= 0.85 * width
            and max(a[1], b[1]) - min(a[3], b[3]) <= 3 / 540)


def _cup_center(cup):
    return (cup[0] + cup[2]) / 2, (cup[1] + cup[3]) / 2


def _near_person(cup, persons):
    x, y = _cup_center(cup)
    return any(hypot(max(p[0] - x, 0, x - p[2]) * 960, max(p[1] - y, 0, y - p[3]) * 540) <= 48
               for p in persons)


@dataclass
class CupTrack:
    box: tuple
    seen: float
    near: float = -float("inf")
    hits: int = 1
    misses: int = 0

    @property
    def confirmed(self):
        return self.hits >= CUP_CONFIRMATIONS


class TableCups:
    """Scan a single table at a time and keep stationary cups through missed scans."""

    def __init__(self, settings, model=None):
        self.settings = settings
        self.reset()
        if model is None:
            from ultralytics import YOLO
            folder = settings["model_dir"]
            if settings["runtime"] == "pt":
                path = folder / f"{CUP_MODEL}.pt"
            else:
                suffix = "_int8_openvino_model" if settings["runtime"] == "openvino-int8" else "_openvino_model"
                path = folder / f"{CUP_MODEL}_{CUP_IMGSZ}x{CUP_IMGSZ}{suffix}"
            if not path.exists():
                raise FileNotFoundError(f"cup model missing: {path}")
            model = YOLO(str(path), task="detect")
        self.model = model
        self.inference = dict(imgsz=[CUP_IMGSZ, CUP_IMGSZ], classes=[41], conf=CUP_CONF,
                              device=settings["device"], verbose=False, rect=False)
        if settings["runtime"] == "pt" and settings["half"]:
            self.inference["half"] = True
        self.last_scan_ms = None

    def warmup(self):
        self.model.predict(np.zeros((256, 256, 3), np.uint8), **self.inference)

    def reset(self):
        self.zone_key = None
        self.crops = []
        self.tracks = {}
        self.index = 0
        self.next_scan = None

    def _sync_zones(self, zones):
        key = getattr(zones, "revision", 0)
        if key == self.zone_key:
            return
        self.reset()
        self.zone_key = key
        for zone in getattr(zones, "zones", ()):
            mask = decode_runs(zone.mask["runs"])
            ys, xs = mask.nonzero()
            if not len(xs):
                continue
            bounds = (xs.min()/COLS, ys.min()/ROWS, (xs.max()+1)/COLS, (ys.max()+1)/ROWS)
            self.crops.append((zone.id, mask, bounds))
            self.tracks[zone.id] = []

    def _observe(self, zid, t, observations, persons):
        kept = []
        for track in self.tracks[zid]:
            match = next((i for i, box in enumerate(observations) if _same_cup(box, track.box)), None)
            if match is None:
                x, y = _cup_center(track.box)
                covered = any(person[0] <= x <= person[2] and person[1] <= y <= person[3] for person in persons)
                if not (track.confirmed and covered):
                    track.misses += 1
            else:
                box = observations.pop(match)
                observations = [b for b in observations if not _same_cup(b, box)]
                if box[3] - box[1] >= 0.8 * (track.box[3] - track.box[1]):
                    track.box = box
                track.seen = t
                track.hits += 1
                track.misses = 0
            if track.misses == 0 or (track.confirmed and (track.misses < CUP_MISSES or t - track.near > CUP_NEAR_SEC)):
                kept.append(track)
        for box in observations:
            if not any(_same_cup(box, track.box) for track in kept):
                kept.append(CupTrack(box, t, t if _near_person(box, persons) else -float("inf")))
        self.tracks[zid] = kept

    def step(self, frame, zones, persons, *, can_scan):
        self.last_scan_ms = None
        self._sync_zones(zones)
        t = frame.capture_t
        for zid, tracks in self.tracks.items():
            self.tracks[zid] = [track for track in tracks if t - track.seen <= CUP_TIMEOUT_SEC]
            for track in self.tracks[zid]:
                if _near_person(track.box, persons):
                    track.near = t
        if can_scan and self.crops and (self.next_scan is None or t >= self.next_scan - EPS):
            started = perf_counter()
            zid, mask, (left, top, right, bottom) = self.crops[self.index]
            image = _decode(frame)
            h, w = image.shape[:2]
            margin_x, margin_y = round(w * 30 / 1920), round(h * 30 / 1080)
            l = max(0, floor(left*w) - margin_x)
            r = min(w, ceil(right*w) + margin_x)
            a = max(0, floor(top*h) - margin_y)
            b = min(h, ceil(bottom*h) + margin_y)
            result = self.model.predict(image[a:b, l:r], **self.inference)[0]
            observations = []
            for x1, y1, x2, y2 in result.boxes.xyxy.tolist():
                box = ((x1 + l) / w, (y1 + a) / h, (x2 + l) / w, (y2 + a) / h)
                cx, cy = load_numbers().cell_of((box[0] + box[2]) / 2, box[3])
                if mask[cy, cx]:
                    observations.append(box)
            self._observe(zid, t, observations, persons)
            self.index = (self.index + 1) % len(self.crops)
            period = 1 / CUP_SCAN_HZ
            base = t if self.next_scan is None else max(self.next_scan, t - period / 2)
            self.next_scan = base + period
            self.last_scan_ms = (perf_counter() - started) * 1000
        return [track.box for tracks in self.tracks.values() for track in tracks if track.confirmed]


@dataclass
class CaptureResult:
    result: FrameResult
    detected: bool
    infer_ms: float | None


class CapturePipeline:
    def __init__(self, cfg, detector, engine, cups=None):
        self.detector, self.engine, self.cups = detector, engine, cups
        self.detect_hz = cfg.detect_hz
        self.people = StablePeople()
        self.reset()

    def reset(self):
        self.last_detect_t = None
        self.person_boxes = []
        self.people.reset()
        if self.cups is not None:
            self.cups.reset()

    def step(self, frame, zones):
        t = frame.capture_t
        hz = self.detect_hz
        detected = (hz <= 0 or self.last_detect_t is None
                    or t - self.last_detect_t >= 0.9 / hz - EPS or t < self.last_detect_t)
        infer_ms = None
        if detected:
            started = perf_counter()
            det = self.detector.detect(frame, zones)
            infer_ms = (perf_counter() - started) * 1000
            self.last_detect_t = t
        elif self.cups is None:
            det = self.detector.predict(frame, t - self.last_detect_t)
        if self.cups is None:
            result = self.engine.update(t, det, zones)
        else:
            if detected:
                self.person_boxes = self.people.update(t, det.persons, det.person_observations)
            cup_boxes = self.cups.step(frame, zones, self.people.seat_boxes, can_scan=not detected)
            result = self.engine.update(t, Detections(self.person_boxes, cup_boxes), zones,
                                        detected=detected, confirmed=True, seat_persons=self.people.seat_boxes)
            result.counts.inStoreRaw = self.people.measured
        return CaptureResult(result, detected, infer_ms)


def create_frame_pipeline(cfg, detector=None, engine=None, cups=None):
    if detector is None:
        detector = create_detector(cfg)
    if engine is None:
        engine = load_numbers().create_engine(cfg)
    if cups is None and cfg.detect_plan == "full+zones" and not cfg.fake_detector:
        cups = TableCups(resolve_settings(cfg))
        cups.warmup()
    return CapturePipeline(cfg, detector, engine, cups)

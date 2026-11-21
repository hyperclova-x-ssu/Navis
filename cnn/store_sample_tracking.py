"""Box and table state for the offline store sample."""
from dataclasses import dataclass, field
from itertools import groupby
from math import ceil, hypot

import numpy as np
from lap import lapjv

from common import box_center, point_in_polygon
from export_playback import CLEAR_SEC, FPS, H, W, assign_seats, r3
from smooth import MIN_TRACK_FRAMES

SOURCE_W, SOURCE_H = 1920, 1080
PERSON_CONFIDENCE = 0.27
PERSON_MATCH_LIMIT = 1.15
PERSON_GAP = ceil(1.5 * FPS)
CUP_GAP = ceil(1.5 * FPS)
CUP_TIMEOUT = 20 * FPS
CUP_REACH = 48  # pixels in the 960x540 preview
MIN_CUP_HITS = 2
MIN_SEAT_FRAMES = ceil(1.2 * FPS)


@dataclass(frozen=True)
class PersonObservation:
    box: tuple
    anchor_x: float

    @classmethod
    def from_pose(cls, detection, nose):
        box = tuple(detection[:4])
        x1, y1, x2, _ = box
        centre_x = (x1 + x2) / 2
        nose_x, nose_y, confidence = nose
        if confidence >= 0.74 and x1 < nose_x < x2 and y1 < nose_y < y1 + 75:
            centre_x = 0.7 * nose_x + 0.3 * centre_x
        return cls(box, centre_x)

    def same_head(self, other):
        x1, y1, x2, _ = self.box
        a1, b1, a2, _ = other.box
        return (abs(y1 - b1) < 18
                and (abs(self.anchor_x - other.anchor_x) < 28
                     or abs((x1 + x2) - (a1 + a2)) < min(x2 - x1, a2 - a1)))


def person_observations(boxes, poses):
    # Overlapping torso and full-body boxes can represent the same head.
    kept = []
    for box, pose in zip(boxes, poses):
        if box[4] >= PERSON_CONFIDENCE:
            observation = PersonObservation.from_pose(box, pose[0])
            if not any(observation.same_head(other) for other in kept):
                kept.append(observation)
    return kept


def association_cost(track, previous, observation, span):
    x1, y1, x2, y2 = track.box
    a1, b1, a2, b2 = observation.box
    x, y = track.anchor_x, y1
    if previous is not None and abs(y2 - previous.box[3]) < 115:
        # Allow brief occlusions to change the box size without accelerating the track.
        lead = 0.75 * min(span, 2)
        x += (track.anchor_x - previous.anchor_x) * lead
        y += (y1 - previous.box[1]) * lead

    # The foreground occupies more pixels, so people can cross it faster.
    foreground = max(y2, b2) >= 1030 and (min(y2, b2) >= 1010 or (max(x1, a1) < 800 and abs(y1 - b1) < 40))
    x_reach = 70 + min(span, 5) * 18 + (185 * min(span, 2) if foreground else 0)
    y_reach = 50 + min(span, 5) * 6 + (22 if foreground else 0)
    clipped = (a1 < 10 and x1 > 155) or (a2 > SOURCE_W - 10 and x2 < SOURCE_W - 155)
    return abs(observation.anchor_x - x) / x_reach + abs(b1 - y) / y_reach + 0.035 * (span - 1) + (0.35 if clipped else 0)


def normalized_box(box):
    return [r3(value / size) for value, size in zip(box, (SOURCE_W, SOURCE_H, SOURCE_W, SOURCE_H))]


def stable_people(rows):
    """Associate poses and interpolate only gaps bounded by two sightings of the same person."""
    active, tracks = {}, []
    for i, row in enumerate(rows):
        active = {tid: last for tid, last in active.items() if i - last <= PERSON_GAP + 1}
        ids = list(active)
        costs = np.empty((len(ids), len(row)))
        for j, tid in enumerate(ids):
            last = active[tid]
            track = tracks[tid]
            costs[j] = [association_cost(track[last], track.get(last - 1), p, i - last) for p in row]
        _, assigned, unmatched = lapjv(costs, extend_cost=True, cost_limit=PERSON_MATCH_LIMIT)
        for tid, col in zip(ids, assigned):
            if col >= 0:
                tracks[tid][i] = row[col]
                active[tid] = i
        for col, association in enumerate(unmatched):
            if association < 0:
                active[len(tracks)] = i
                tracks.append({i: row[col]})

    frames = [[] for _ in rows]
    for tid, track in enumerate(tracks, 1):
        if len(track) < MIN_TRACK_FRAMES:
            continue
        sightings = list(track.items())
        for i, person in sightings:
            frames[i].append(normalized_box(person.box) + [tid])
        for (a, left), (b, right) in zip(sightings, sightings[1:]):
            for i in range(a + 1, b):
                fraction = (i - a) / (b - a)
                box = [before + (after - before) * fraction for before, after in zip(left.box, right.box)]
                frames[i].append(normalized_box(box) + [tid])
    for frame in frames:
        frame.sort(key=lambda person: person[4])
    return frames


def bottom_center(box):
    return (box[0] + box[2]) / 2, box[3]


def nearby_person(cup, persons):
    x, y = box_center(cup)
    return any(hypot(max(p[0] - x, 0, x - p[2]) * W, max(p[1] - y, 0, y - p[3]) * H) <= CUP_REACH
               for p in persons)


def same_cup(box, previous):
    # The model sometimes sees only the lid or only the lower half.
    # Join overlapping vertical fragments only when their horizontal centres agree.
    width = max(box[2] - box[0], previous[2] - previous[0])
    return (abs(box_center(box)[0] - box_center(previous)[0]) <= 0.85 * width
            and max(box[1], previous[1]) - min(box[3], previous[3]) <= 3 / H)


def cup_moved(box, previous):
    x, y = box_center(box)
    old_x, old_y = box_center(previous)
    height = previous[3] - previous[1]
    full_box = box[3] - box[1] >= 0.8 * height
    return abs(x - old_x) > 0.5 * (previous[2] - previous[0]) or (full_box and abs(y - old_y) > 0.4 * height)


@dataclass
class CupTrack:
    boxes: dict = field(default_factory=dict)
    last_seen: int = -1
    near: int = -1
    hits: int = 0
    anchor: list = field(default_factory=list)
    moving: bool = False

    def observe(self, frame, box):
        self.moving = bool(self.anchor and cup_moved(box, self.anchor))
        if not self.anchor or self.moving or box[3] - box[1] >= 0.8 * (self.anchor[3] - self.anchor[1]):
            self.anchor = box
        self.boxes[frame] = self.anchor
        self.last_seen = frame
        self.hits += 1

    def expire(self, frame):
        missing = frame - self.last_seen
        if missing > CUP_GAP and self.near >= max(0, self.last_seen - CUP_GAP):
            # The exported clip can use later frames to confirm removal and
            # end the overlay at the first missed frame.
            for i in range(self.last_seen + 1, frame):
                self.boxes.pop(i, None)
            return True
        return missing > CUP_TIMEOUT or (self.hits < MIN_CUP_HITS and missing > CUP_GAP)


def stable_cups(cups, people):
    """Keep stationary cups through missed observations and confirm disappearances."""
    frames = [[] for _ in cups]
    active, tracks = [], []
    for i, (row, persons) in enumerate(zip(cups, people)):
        available = list(row)
        for track in active[:]:
            match = next((box for box in available if same_cup(box, track.anchor)), None)
            if match is not None:
                track.observe(i, match)
                available = [box for box in available if not same_cup(box, track.anchor)]
            if nearby_person(track.anchor, persons):
                track.near = i
            if track.expire(i):
                active.remove(track)
            elif match is None and not track.moving:
                track.boxes[i] = track.anchor

        for box in available:
            if any(same_cup(box, track.anchor) for track in active):
                continue
            track = CupTrack()
            track.observe(i, box)
            if nearby_person(box, persons):
                track.near = i
            active.append(track)
            tracks.append(track)

    for track in tracks:
        if track.hits >= MIN_CUP_HITS:
            for i, box in track.boxes.items():
                frames[i].append(box)
    return frames


def stable_seats(frames):
    """Bridge short misses in the same seat and reject brief walk-throughs."""
    tracks = {}
    for i, row in enumerate(frames):
        for person in row:
            tracks.setdefault(person[4], []).append((i, person))

    for track in tracks.values():
        occupied = [(i, person[5]) for i, person in track if person[5] is not None]
        by_frame = dict(track)
        for (left, seat), (right, next_seat) in zip(occupied, occupied[1:]):
            if seat == next_seat and right - left <= PERSON_GAP + 1:
                for i in range(left + 1, right):
                    if i in by_frame:
                        by_frame[i][5] = seat
        for seat, run in groupby(track, key=lambda pair: pair[1][5]):
            rows = list(run)
            if seat is not None and len(rows) < MIN_SEAT_FRAMES:
                for _, person in rows:
                    person[5] = None
    return frames


def table_counts(frames, tables, raw_people):
    """Count the displayed boxes and show clearing after an unoccupied cup stays three seconds."""
    waiting = {}
    clearing = {}
    occupied_frames = dict.fromkeys((table["id"] for table in tables), 0)
    events = []
    for i, (frame, raw) in enumerate(zip(frames, raw_people)):
        persons, cups = frame["persons"], frame["cups"]
        occupied = {p[5] for p in persons if p[5] is not None}
        clear = []
        for table in tables:
            tid = table["id"]
            if tid in occupied:
                occupied_frames[tid] += 1
            if tid in occupied or not any(point_in_polygon(bottom_center(cup), table["polygon"]) for cup in cups):
                waiting.pop(tid, None)
                event = clearing.pop(tid, None)
                if event:
                    events.append(dict(event, toT=r3((i - 1) / FPS), hiddenT=frame["t"]))
                continue

            start = waiting.setdefault(tid, i)
            if i - start >= round(CLEAR_SEC * FPS):
                clearing.setdefault(tid, {"table": tid, "fromT": r3(start / FPS), "shownT": frame["t"]})
                clear.append(tid)

        frame["counts"] = {
            "inStore": len(persons), "seated": sum(p[5] is not None for p in persons),
            "inStoreRaw": len(raw), "seatedRaw": sum(p[5] is not None for p in raw),
            "occupiedTables": [table["id"] for table in tables if table["id"] in occupied],
            "tablesToClear": clear,
        }
    for event in clearing.values():
        events.append(dict(event, toT=frames[-1]["t"], hiddenT=r3(len(frames) / FPS)))
    return sorted(events, key=lambda event: event["fromT"]), {k: round(n / FPS, 1) for k, n in occupied_frames.items()}


def finalize_sample(people, cups, raw_people, cfg):
    sx, sy = cfg["image_size"]
    tables = [{"id": zone["id"], "name": zone["name"],
               "polygon": [[r3(x / sx), r3(y / sy)] for x, y in zone["polygon"]]}
              for zone in cfg["tables"]]
    seat_tables = [dict(table, maxBoxH=zone["maxBoxH"], minBoxTop=zone.get("minBoxTop", 0) / sy)
                   for table, zone in zip(tables, cfg["tables"])]
    seats = stable_seats(assign_seats(people, seat_tables, cfg["footFrac"]))
    raw_seats = assign_seats(raw_people, seat_tables, cfg["footFrac"])
    frames = [{"t": r3(i / FPS), "persons": persons, "cups": cs}
              for i, (persons, cs) in enumerate(zip(seats, stable_cups(cups, people)))]
    events, occupancy = table_counts(frames, tables, raw_seats)
    headcounts = [f["counts"]["inStore"] for f in frames]
    return {
        "source": "Team-recorded store sample", "fps": FPS, "frameCount": len(frames),
        "width": W, "height": H, "frames": frames, "tables": tables,
        "summary": {
            "avgInStore": round(sum(headcounts) / len(frames), 2),
            "maxInStore": max(headcounts), "tableOccupiedSeconds": occupancy,
            "tablesToClearEvents": events,
            "smoothing": {"minTrackFrames": MIN_TRACK_FRAMES, "personGapFrames": PERSON_GAP,
                          "cupGapFrames": CUP_GAP, "cupTimeoutSeconds": CUP_TIMEOUT / FPS},
        }
    }

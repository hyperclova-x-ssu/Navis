"""Table zones: format, invariants, RLE and file store (T-068, DATA_MODEL 12.2, API-18).

Self-contained on purpose: contracts.py (T-066) may define the same names;
server.py can adapt via to_dict()/from_dict().
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import tempfile
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

import numpy as np

log = logging.getLogger(__name__)

COLS, ROWS = 160, 90
CELLS = COLS * ROWS
MIN_ZONE_CELLS = 12
MAX_ZONES = 32
MAX_BODY_BYTES = 256 * 1024
_ID_RE = re.compile(r"^z[0-9a-z]{8}$")
_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


class InvalidZones(ValueError):
    """Invariant violated (HTTP 422 INVALID_ZONES). `rule` = 1..7 of DATA_MODEL 12.2."""

    def __init__(self, rule: int, message: str):
        super().__init__(f"rule {rule}: {message}")
        self.rule = rule
        self.detail = message


class RevisionConflict(Exception):
    """baseRevision differs (HTTP 409 REVISION_CONFLICT)."""

    def __init__(self, current: "ZoneSet"):
        super().__init__("revision conflict")
        self.current = current


@dataclass
class Zone:
    id: str
    number: int
    source: str  # 'suggested' | 'drawn'
    mask: dict   # {"cols":160,"rows":90,"runs":[...]}

    def to_dict(self) -> dict:
        return {"id": self.id, "number": self.number, "source": self.source,
                "mask": {"cols": COLS, "rows": ROWS, "runs": list(self.mask["runs"])}}

    @staticmethod
    def from_dict(d: dict) -> "Zone":
        if not isinstance(d, dict):
            raise InvalidZones(1, "zone must be an object")
        m = d.get("mask")
        if not isinstance(m, dict) or m.get("cols") != COLS or m.get("rows") != ROWS \
                or not isinstance(m.get("runs"), list):
            raise InvalidZones(1, "mask must be {cols:160, rows:90, runs:[...]}")
        return Zone(id=d.get("id"), number=d.get("number"), source=d.get("source"),
                    mask={"cols": COLS, "rows": ROWS, "runs": m["runs"]})


@dataclass
class ZoneSetIn:
    frame_aspect: Optional[float]
    zones: list = field(default_factory=list)

    @staticmethod
    def from_dict(d: dict) -> "ZoneSetIn":
        if not isinstance(d, dict) or not isinstance(d.get("zones"), list):
            raise InvalidZones(1, "body must have zones[]")
        fa = d.get("frameAspect")
        if fa is not None and (isinstance(fa, bool) or not isinstance(fa, (int, float)) or fa <= 0):
            raise InvalidZones(1, "frameAspect must be a positive number")
        return ZoneSetIn(frame_aspect=fa, zones=[Zone.from_dict(z) for z in d["zones"]])


@dataclass
class ZoneSet:
    revision: int = 0
    saved_at: Optional[str] = None
    frame_aspect: Optional[float] = None
    zones: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"revision": self.revision, "savedAt": self.saved_at,
                "frameAspect": self.frame_aspect, "zones": [z.to_dict() for z in self.zones]}

    @staticmethod
    def from_dict(d: dict) -> "ZoneSet":
        return ZoneSet(revision=int(d["revision"]), saved_at=d.get("savedAt"),
                       frame_aspect=d.get("frameAspect"),
                       zones=[Zone.from_dict(z) for z in d.get("zones", [])])


# ---------------------------------------------------------------- RLE

def decode_runs(runs: list) -> np.ndarray:
    """runs -> bool array (ROWS, COLS). Raises InvalidZones(1) when malformed."""
    if not isinstance(runs, list) or not runs:
        raise InvalidZones(1, "runs must be a non-empty list")
    total = 0
    for i, v in enumerate(runs):
        if isinstance(v, bool) or not isinstance(v, int):
            raise InvalidZones(1, "runs must be integers")
        if v < 0 or (v == 0 and i > 0):
            raise InvalidZones(1, "runs must be >= 0 (only the first may be 0)")
        total += v
        if total > CELLS:
            raise InvalidZones(1, f"runs sum exceeds {CELLS}")
    if total != CELLS:
        raise InvalidZones(1, f"runs sum must be {CELLS}, got {total}")
    flat = np.zeros(CELLS, dtype=bool)
    pos, val = 0, False
    for v in runs:
        if val:
            flat[pos:pos + v] = True
        pos += v
        val = not val
    return flat.reshape(ROWS, COLS)


def encode_mask(mask: np.ndarray) -> list:
    """bool/0-1 array (ROWS, COLS) -> runs starting with a (possibly 0) run of zeros."""
    m = np.asarray(mask).astype(bool).reshape(-1)
    if m.size != CELLS:
        raise ValueError(f"mask must have {CELLS} cells")
    change = np.flatnonzero(m[1:] != m[:-1]) + 1
    bounds = np.concatenate(([0], change, [CELLS]))
    lens = np.diff(bounds).tolist()
    return lens if not m[0] else [0] + lens


def new_zone_id(taken: set | None = None) -> str:
    taken = taken or set()
    while True:
        zid = "z" + "".join(secrets.choice(_ALPHABET) for _ in range(8))
        if zid not in taken:
            return zid


# ---------------------------------------------------------------- invariants

def validate_zones(zones: list, body_bytes: int | None = None) -> None:
    """DATA_MODEL 12.2 invariants 1..7. Raises InvalidZones(rule)."""
    if body_bytes is not None and body_bytes > MAX_BODY_BYTES:
        raise InvalidZones(7, f"body exceeds {MAX_BODY_BYTES} bytes")
    if len(zones) > MAX_ZONES:
        raise InvalidZones(6, f"more than {MAX_ZONES} zones")
    seen_ids: set = set()
    seen_numbers: set = set()
    used = np.zeros((ROWS, COLS), dtype=bool)
    for z in zones:
        grid = decode_runs(z.mask["runs"])                          # 1
        if int(grid.sum()) < MIN_ZONE_CELLS:                        # 2
            raise InvalidZones(2, f"zone {z.id} has fewer than {MIN_ZONE_CELLS} cells")
        if (used & grid).any():                                     # 3
            raise InvalidZones(3, f"zone {z.id} overlaps another zone")
        used |= grid
        if isinstance(z.number, bool) or not isinstance(z.number, int) or z.number in seen_numbers:
            raise InvalidZones(4, f"zone {z.id} has an invalid or duplicate number")
        seen_numbers.add(z.number)
        if not isinstance(z.id, str) or not _ID_RE.match(z.id) or z.id in seen_ids:  # 5
            raise InvalidZones(5, f"invalid or duplicate id {z.id!r}")
        seen_ids.add(z.id)
        if z.source not in ("suggested", "drawn"):
            raise InvalidZones(1, f"invalid source {z.source!r}")
    if seen_numbers and seen_numbers != set(range(1, len(zones) + 1)):  # 4
        raise InvalidZones(4, "numbers must be exactly 1..n")


def zone_grids(zs: ZoneSet) -> list:
    return [(z, decode_runs(z.mask["runs"])) for z in zs.zones]


# ---------------------------------------------------------------- store

class FileZoneStore:
    """JSON file store: atomic write, revision, idempotent retry, change callbacks."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._listeners: list[Callable[[ZoneSet], None]] = []

    def on_change(self, cb: Callable[[ZoneSet], None]) -> None:
        self._listeners.append(cb)

    def _read(self) -> ZoneSet:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return ZoneSet.from_dict(json.load(f))
        except FileNotFoundError:
            return ZoneSet()
        except (ValueError, KeyError, TypeError, InvalidZones):
            log.exception("zones file unreadable, treating as empty: %s", self.path)
            return ZoneSet()

    def load(self) -> ZoneSet:
        with self._lock:
            return self._read()

    def save(self, zs: ZoneSetIn, base_revision: int) -> ZoneSet:
        with self._lock:
            cur = self._read()
            same_body = (zs.frame_aspect == cur.frame_aspect and
                         [z.to_dict() for z in zs.zones] == [z.to_dict() for z in cur.zones])
            if base_revision == cur.revision - 1 and same_body:
                return cur  # retry of the request that produced `cur`
            if base_revision != cur.revision:
                raise RevisionConflict(cur)
            body = json.dumps([z.to_dict() for z in zs.zones]).encode()
            validate_zones(zs.zones, body_bytes=len(body))
            new = ZoneSet(revision=cur.revision + 1,
                          saved_at=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                          frame_aspect=zs.frame_aspect, zones=list(zs.zones))
            self._write_atomic(new)
        for cb in list(self._listeners):
            try:
                cb(new)
            except Exception:
                log.exception("zones change listener failed")
        return new

    def _write_atomic(self, zs: ZoneSet) -> None:
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".zones-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(zs.to_dict(), f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

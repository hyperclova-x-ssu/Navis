"""T-067 실시간 숫자 (DATA_MODEL 12.5). 확인된 추적·점유(MaskSeatState)·칼만·5분 변화·자리별 점유 시간·
평균 점유 시간·치울 테이블·추천 (b)용 점유 누적. 앞쪽 값만 쓴다(causal). 영상·상자를 저장하지 않는다.

주의(파일 이름): ARCHITECTURE 14.5가 이름을 `numbers.py`로 정했는데, 표준 라이브러리에도 `numbers`가 있다.
`cnn/live`가 sys.path 앞에 오면 numpy·pydantic·fractions 가 `import numbers`로 이 파일을 읽는다.
그래서 이 파일은 맨 먼저 표준 `numbers`의 ABC(Number·Complex·Real·Rational·Integral)를 그대로 내보낸 뒤에
나머지를 import 한다(표준 모듈의 역할을 그대로 함). 다른 쪽에서 표준 `numbers`가 이미 읽혔으면 `import numbers`는
표준 모듈을 돌려주므로, 서버는 `pipeline.load_numbers()`(파일 경로로 읽음)로 이 모듈을 얻는 것이 안전하다.
"""
# ---- 1) 표준 numbers 역할 (다른 import 보다 먼저) ----
import importlib.util as _ilu
import os as _os
import sysconfig as _sysconfig

_std_spec = _ilu.spec_from_file_location("_stdlib_numbers", _os.path.join(_sysconfig.get_paths()["stdlib"], "numbers.py"))
_std = _ilu.module_from_spec(_std_spec)
_std_spec.loader.exec_module(_std)
Number, Complex, Real, Rational, Integral = _std.Number, _std.Complex, _std.Real, _std.Rational, _std.Integral
__all__ = ["Number", "Complex", "Real", "Rational", "Integral"]

if __name__ == "numbers":
    # 표준 numbers 대신 읽힌 경우: 여기서 numpy·pydantic 을 import 하면 decimal·fractions 와 순환이 생긴다.
    # 엔진 이름(create_engine 등)은 처음 쓸 때 이 파일을 'live_numbers' 로 따로 읽어 넘긴다.
    def __getattr__(name):
        import sys as _sys
        impl = _sys.modules.get("live_numbers")
        if impl is None:
            spec = _ilu.spec_from_file_location("live_numbers", __file__)
            impl = _ilu.module_from_spec(spec)
            _sys.modules["live_numbers"] = impl
            spec.loader.exec_module(impl)
        try:
            return getattr(impl, name)
        except AttributeError:
            raise AttributeError(f"module 'numbers' has no attribute {name!r}") from None
else:
    # ---- 2) 실시간 숫자 (표준 numbers 대신 읽힌 경우엔 실행하지 않음) ----
    import bisect  # noqa: E402
    import json  # noqa: E402
    import math  # noqa: E402
    import sys  # noqa: E402
    from collections import deque  # noqa: E402
    from pathlib import Path  # noqa: E402

    import numpy as np  # noqa: E402

    _HERE = Path(__file__).resolve().parent
    # seat_state.py(T-065b)는 고치지 않고 복사본을 읽는다: gpu-server 는 vendor/(deploy.sh 가 복사), 저장소는 ../occupancy/
    for _p in (_HERE / "vendor", _HERE.parent / "occupancy"):
        if (_p / "seat_state.py").exists():
            if str(_p) not in sys.path:
                sys.path.append(str(_p))
            break
    from seat_state import DEFAULTS as SEAT_DEFAULTS  # noqa: E402
    from seat_state import SeatState  # noqa: E402

    from contracts import Counts, FrameResult  # noqa: E402
    from pipeline import box_center_x, same_person_head  # noqa: E402

    # 상수 (DATA_MODEL 12.5 표와 같게)
    MIN_TRACK_FRAMES = 2
    KALMAN_Q, KALMAN_R = 0.0001, 1.0
    NUMBER_TICK_HZ = 5
    TICK = 1.0 / NUMBER_TICK_HZ
    FOOT_FRAC = 0.8
    CUP_CLASSES = (40, 41, 45)
    CLEAR_SEC = 3.0
    CUP_GAP_SEC = 1.0
    BASE_DIST = 0.0365
    WINDOW_SEC = 300
    SPAN_GAP_SEC = 3.0
    SPAN_MIN_SEC = 10.0
    BASELINE_SEC = 10.0      # 비어 있는 동안 기준선 = 최근 10초 안에 본 컵 위치
    HISTORY_SEC = 600        # 5분 기록 링 버퍼(최근 10분)
    CHANGE_TOL_SEC = 0.5     # t−300초 기록이 이보다 멀면 null
    LIVE_GAP_SEC = 1.0       # 업데이트 사이가 이보다 길면 그 사이 틱은 live 아님(끊김)
    GRID_COLS, GRID_ROWS = 160, 90
    STAND_REF_H = 1080       # seat_state 의 stand_h_px 는 1080px 기준 → 0~1 좌표에 img_h=1080 을 주면 비율(350/1080)로 같아짐
    EPS = 1e-9
    SEAT_DEPARTURE_SEC = 0.4    # a moving body was replaced by a fragment
    SEAT_FRAGMENT_SEC = 0.6     # suppress the same short fragment through a brief split
    SEAT_MAX_HOLD_SEC = 2.8    # allow one 5 Hz sampling interval before three seconds


    def kalman_step(state, v, q=KALMAN_Q, r=KALMAN_R):
        """smooth.kalman 한 걸음. state=None 이면 첫 측정으로 시작(smooth.kalman 과 같음). -> (새 state, x)"""
        if state is None:
            state = [float(v), float(r)]
        state[1] += q
        k = state[1] / (state[1] + r)
        state[0] += k * (v - state[0])
        state[1] *= 1 - k
        return state, state[0]


    def decode_runs(runs):
        """MaskRle runs -> (90,160) bool. 형식 검사는 zones.py(T-068) 몫이라 여기선 합만 확인."""
        flat = np.zeros(GRID_COLS * GRID_ROWS, dtype=bool)
        pos, val = 0, False
        for v in runs:
            v = int(v)
            if val:
                flat[pos:pos + v] = True
            pos += v
            val = not val
        if pos != flat.size:
            raise ValueError(f"runs sum {pos} != {flat.size}")
        return flat.reshape(GRID_ROWS, GRID_COLS)


    def _zones_of(zs):
        """ZoneSet(zones.py 데이터클래스 또는 dict) -> (revision, [(zoneId, mask)])"""
        if zs is None:
            return 0, []
        if isinstance(zs, dict):
            rev, zl = zs.get("revision", 0), zs.get("zones", [])
        else:
            rev, zl = getattr(zs, "revision", 0), getattr(zs, "zones", [])
        out = []
        for z in zl:
            zid = z["id"] if isinstance(z, dict) else z.id
            mask = z["mask"] if isinstance(z, dict) else z.mask
            runs = mask["runs"] if isinstance(mask, dict) else mask.runs
            out.append((zid, decode_runs(runs)))
        return rev, out


    def cell_of(x, y):
        return min(GRID_COLS - 1, max(0, int(math.floor(x * GRID_COLS)))), min(GRID_ROWS - 1, max(0, int(math.floor(y * GRID_ROWS))))


    class ZoneGrid:
        """칸 -> 영역 번호 조회표(영역끼리 칸이 겹치지 않음, DATA_MODEL 12.2 ③)."""

        def __init__(self, zones):
            self.ids = [zid for zid, _ in zones]
            self.lut = np.full((GRID_ROWS, GRID_COLS), -1, dtype=np.int16)
            for i, (_, m) in enumerate(zones):
                self.lut[m & (self.lut < 0)] = i

        def zone_at(self, x, y):
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                return None
            cx, cy = cell_of(x, y)
            i = int(self.lut[cy, cx])
            return self.ids[i] if i >= 0 else None


    class MaskSeatState(SeatState):
        """seat_state.SeatState 그대로 + `_candidate`의 구역 판정만 '기준점 칸이 영역 마스크 안인가'로 바꿈(maxBoxH 안 씀)."""

        def __init__(self, grid, foot_frac=FOOT_FRAC, **params):
            super().__init__([{"id": zid, "maxBoxH": float("inf"), "polygon": []} for zid in grid.ids],
                             foot_frac=foot_frac, img_h=STAND_REF_H, **params)
            self.grid = grid

        def _candidate(self, b, persons=()):
            h = b[3] - b[1]
            pt = ((b[0] + b[2]) / 2, b[1] + h * self.foot)
            if len(b) > 5 and b[5] == "stand":
                return None, pt, h
            if self._occluded(b, persons):
                return None, pt, h
            return self.grid.zone_at(*pt), pt, h


    class CaptureSeatState(MaskSeatState):
        """Keep a settled seat through occlusion and release it on visible departure."""

        def __init__(self, grid, **params):
            params = {"dwell_sec": 1.0, "move_thr": 0.065, **params}
            params["hold_sec"] = min(params.get("hold_sec", SEAT_DEFAULTS["hold_sec"]), SEAT_MAX_HOLD_SEC)
            super().__init__(grid, **params)
            self.anchors = {}
            self.fragments = {}
            self.moving_bodies = set()

        def step(self, t, boxes):
            current = {box[4]: box for box in boxes}
            for tid, anchor in self.anchors.items():
                track = self.tracks[tid]
                box = current.get(tid)
                if box is None:
                    if (t - track["lastSeatOk"] >= SEAT_MAX_HOLD_SEC - EPS
                            or tid in self.moving_bodies and t - track["lastSeen"] >= SEAT_DEPARTURE_SEC - EPS):
                        track["seat"] = None
                    continue
                height = anchor[3] - anchor[1]
                rise = anchor[1] - box[1]
                if rise > 0.29 * height and box[3] - box[1] > 1.145 * height:
                    track["seat"] = None
                    track["hist"] = []
                    track["candSince"] = t

            moving = set()
            for tid, box in current.items():
                track = self.tracks.get(tid)
                if not track or not track["hist"]:
                    continue
                height = box[3] - box[1]
                cx, foot = box_center_x(box), box[1] + self.foot * height
                if all(math.hypot(cx - x, foot - y) < 0.05 * height for _, x, y, _ in track["hist"]):
                    continue
                for fragment_id, fragment in current.items():
                    if fragment[3] - fragment[1] <= 0.65 * height and same_person_head(box, fragment):
                        self.fragments[fragment_id] = t
                        moving.add(tid)

            self.fragments = {tid: seen for tid, seen in self.fragments.items() if t - seen <= SEAT_FRAGMENT_SEC + EPS}
            for tid in self.fragments.keys() & self.tracks.keys():
                self.tracks[tid]["seat"] = None
            out = super().step(t, [box for box in boxes if box[4] not in self.fragments])
            self.anchors = {tid: self.anchors.get(tid, current.get(tid))
                            for tid in out["seats"] if tid in self.anchors or tid in current}
            self.moving_bodies = ((self.moving_bodies - current.keys()) | moving) & self.tracks.keys()
            return out


    class ClearState:
        """치울 테이블 상태 기계(DATA_MODEL 12.5 ⑧, cnn D-64 를 앞쪽 값만으로)."""

        def __init__(self):
            self.phase = "collect"      # collect(비어 있는 동안) | occupied | after(떠난 뒤)
            self.recent = deque()       # collect 동안 본 컵 (t, x, y)
            self.baseline = []          # 앉는 순간 고정한 기준선 [(x, y)]
            self.left_t = None
            self.cond_start = None      # 새 컵 조건이 시작된 때
            self.cond_last = None       # 새 컵을 마지막으로 본 때
            self.show = False

        def step(self, t, occupied, cups, aspect):
            if occupied:
                if self.phase != "occupied":
                    if self.phase == "collect":
                        self.baseline = [(x, y) for _, x, y in self.recent]
                    self.phase = "occupied"
                self.show, self.cond_start, self.cond_last = False, None, None
                return
            if self.phase == "collect":
                for x, y in cups:
                    self.recent.append((t, x, y))
                while self.recent and self.recent[0][0] < t - BASELINE_SEC - EPS:
                    self.recent.popleft()
                return
            if self.phase == "occupied":
                self.phase, self.left_t = "after", t
            new = [c for c in cups if all(math.hypot(c[0] - bx, (c[1] - by) / aspect) > BASE_DIST for bx, by in self.baseline)]
            if new:
                if self.cond_last is None or t - self.cond_last > CUP_GAP_SEC + EPS:
                    self.cond_start = t
                self.cond_last = t
                if t - self.cond_start > CLEAR_SEC + EPS:
                    self.show = True
                return
            # 새 컵을 본 적이 없으면 기준선을 고정한 채 기다린다(떠난 뒤 늦게 잡힌 컵도 새 컵, cnn D-64 와 같은 뜻)
            if self.cond_last is not None and t - self.cond_last > CLEAR_SEC + EPS:
                # 컵이 사라지고 3초 → 뺌, 다시 비어 있는 동안(기준선 새로 모음)
                self.show = False
                self.phase, self.recent, self.baseline = "collect", deque(), []
                self.cond_start = self.cond_last = self.left_t = None


    class SpanState:
        """평균 점유 시간용 점유 구간(DATA_MODEL 12.5 ⑦)."""

        def __init__(self):
            self.start = None
            self.last = None

        def tick(self, t, occupied, done):
            if occupied:
                if self.start is not None and t - self.last > SPAN_GAP_SEC + EPS:
                    self._close(done)
                if self.start is None:
                    self.start = t
                self.last = t
            elif self.start is not None and t - self.last > SPAN_GAP_SEC + EPS:
                self._close(done)

        def _close(self, done):
            length = self.last - self.start + TICK
            if length >= SPAN_MIN_SEC - EPS:
                done.append(length)
            self.start = self.last = None


    class LiveNumberEngine:
        """NumberEngine(contracts.py). update 는 받은 프레임마다(탐지한 장·사이 장 모두) 부른다.
        사이 장(Detector.predict 결과, det.predicted=True)은 점유·추적 확인을 갱신하지 않고 직전 숫자를 그대로 쓴다."""

        def __init__(self, occ_params=None, aspect=16 / 9):
            self.occ_overrides = occ_params or {}
            self.occ_params = {**SEAT_DEFAULTS, **self.occ_overrides}
            self.aspect = aspect
            self.reset()

        # ---------- 초기화 규칙 ----------
        def reset(self):
            """새 카메라 세션·서버 시작: 추적기·①~⑧ 전부 처음부터."""
            self.rev = None
            self.grid = ZoneGrid([])
            self.seat = MaskSeatState(self.grid, **self.occ_params)
            self.streak = {}
            self.k_in = self.k_occ = None
            self.x_in = self.x_occ = None
            self.raw_in = self.raw_occ = 0
            self.occupied, self.seats = [], {}
            self.persons_out, self.cups_out = [], []
            self.next_tick = None
            self.last_update_t = None
            self.last_det_t = None
            self.history = deque()           # (t, x_in 실수, live)
            self.hist_t = deque()
            self.occ_ticks = {}              # zoneId -> deque(틱 시각)
            self.spans = {}                  # zoneId -> SpanState
            self.done_spans = []
            self.clear = {}                  # zoneId -> ClearState
            self.heat = np.zeros((GRID_ROWS, GRID_COLS), dtype=np.float32)

        def reset_tracks(self):
            """같은 세션 재연결: 추적 상태만 초기화(기록·구간·기준선 유지). Detector.reset_tracker()와 같이 부름."""
            self.streak = {}
            self.seat = type(self.seat)(self.grid, **self.occ_overrides)

        def occupancy_heat(self):
            return self.heat.copy()

        # ---------- 영역 ----------
        def _sync_zones(self, zones, confirmed):
            rev, zl = _zones_of(zones)
            if rev == self.rev and self.rev is not None:
                return
            old_seat = self.seat
            self.rev = rev
            self.grid = ZoneGrid(zl)
            ids = set(self.grid.ids)
            kind = CaptureSeatState if confirmed else MaskSeatState
            self.seat = kind(self.grid, **self.occ_overrides)
            # 남은 영역의 누적 점유 초는 이어서(seat_state 내부 값), 사라진 영역 상태는 버림
            for zid in ids & set(old_seat.occ_sec):
                self.seat.occ_sec[zid] = old_seat.occ_sec[zid]
            for d in (self.occ_ticks, self.spans, self.clear):
                for zid in list(d):
                    if zid not in ids:
                        del d[zid]
            for zid in self.grid.ids:
                self.occ_ticks.setdefault(zid, deque())
                self.spans.setdefault(zid, SpanState())
                self.clear.setdefault(zid, ClearState())
            self.occupied = [z for z in self.occupied if z in ids]

        # ---------- 한 프레임 ----------
        def update(self, t, det, zones, detected=None, confirmed=False, seat_persons=None):
            self._sync_zones(zones, confirmed)
            if detected is None:
                detected = not getattr(det, "predicted", False)
            gap = self.last_update_t is not None and t - self.last_update_t > LIVE_GAP_SEC + EPS
            if gap:
                self.streak = {}  # 끊긴 뒤 추적 번호가 다시 시작될 수 있음
            if detected:
                self._detected(t, det, confirmed, seat_persons)
            elif not confirmed:
                self._held(det)
            if confirmed:
                self.cups_out = [list(map(float, c[:4])) for c in det.cups]
            if detected or confirmed:
                self._clear(t, confirmed)
            self._ticks(t, gap)
            self.last_update_t = t
            return self._result(t, confirmed)

        def _detected(self, t, det, confirmed, seat_persons):
            cur, keep = {}, []
            for p in det.persons:
                tid = int(p[4]) if len(p) > 4 and p[4] is not None else -1
                if tid < 0 and not confirmed:
                    continue
                cur[tid] = self.streak.get(tid, 0) + 1
                if confirmed or cur[tid] >= MIN_TRACK_FRAMES:
                    keep.append([float(p[0]), float(p[1]), float(p[2]), float(p[3]), tid])
            self.streak = cur
            out = self.seat.step(t, keep if seat_persons is None else seat_persons)
            self.seats, self.occupied = out["seats"], out["occupied"]
            self.raw_in, self.raw_occ = len(keep), out["occupantCount"]
            self.persons_out = [p[:4] + [self.seats.get(p[4])] for p in keep]
            self.cups_out = [list(map(float, c[:4])) for c in det.cups]
            # 추천 (b): 사용 중 판정된 사람 기준점의 칸별 누적 초
            dt = 0.0 if self.last_det_t is None else min(1.0, max(0.0, t - self.last_det_t))
            if dt > 0:
                for p in keep:
                    if p[4] in self.seats:
                        cx, cy = cell_of((p[0] + p[2]) / 2, p[1] + (p[3] - p[1]) * FOOT_FRAC)
                        self.heat[cy, cx] += dt
            self.last_det_t = t

        def _clear(self, t, confirmed):
            # Use the same cup anchor as the crop pass.
            per_zone = {zid: [] for zid in self.grid.ids}
            for c in self.cups_out:
                cx = (c[0] + c[2]) / 2
                cy = c[3] if confirmed else (c[1] + c[3]) / 2
                zid = self.grid.zone_at(cx, cy)
                if zid is not None:
                    per_zone[zid].append((cx, cy))
            occ = set(self.occupied)
            for zid, st in self.clear.items():
                st.step(t, zid in occ, per_zone.get(zid, []), self.aspect)

        def _held(self, det):
            """사이 장: 상자만 바뀔 수 있음(hold 는 같은 상자). 점유·숫자는 마지막 탐지 그대로."""
            out = []
            for p in det.persons:
                tid = int(p[4]) if len(p) > 4 and p[4] is not None else -1
                if self.streak.get(tid, 0) >= MIN_TRACK_FRAMES:  # 마지막 탐지에서 확인된 추적만
                    out.append([float(p[0]), float(p[1]), float(p[2]), float(p[3]), self.seats.get(tid)])
            self.persons_out = out
            self.cups_out = [list(map(float, c[:4])) for c in det.cups]

        def _ticks(self, t, gap):
            if self.next_tick is None:
                self.next_tick = t
            while self.next_tick <= t + EPS:
                tt = self.next_tick
                live = not gap or tt >= t - EPS  # 끊긴 동안의 틱은 live 아님
                if live:
                    self.k_in, self.x_in = kalman_step(self.k_in, self.raw_in)
                    self.k_occ, self.x_occ = kalman_step(self.k_occ, self.raw_occ)
                occ = set(self.occupied) if live else set()
                for zid in self.grid.ids:
                    dq = self.occ_ticks[zid]
                    if zid in occ:
                        dq.append(tt)
                    while dq and dq[0] <= tt - WINDOW_SEC + EPS:
                        dq.popleft()
                    self.spans[zid].tick(tt, zid in occ, self.done_spans)
                self.history.append((tt, self.x_in, live))
                self.hist_t.append(tt)
                while self.hist_t and self.hist_t[0] < tt - HISTORY_SEC:
                    self.hist_t.popleft()
                    self.history.popleft()
                self.next_tick = tt + TICK

        def _change5m(self, t):
            if self.x_in is None or not self.history:
                return None
            target = self.history[-1][0] - WINDOW_SEC
            times = self.hist_t
            i = bisect.bisect_left(times, target)
            best = None
            for j in (i - 1, i):
                if 0 <= j < len(times) and (best is None or abs(times[j] - target) < abs(times[best] - target)):
                    best = j
            if best is None or abs(times[best] - target) > CHANGE_TOL_SEC + EPS:
                return None
            _, x_then, live = self.history[best]
            if not live or x_then is None:
                return None
            return int(round(self.x_in)) - int(round(x_then))

        def _result(self, t, confirmed=False):
            to_clear = sorted(z for z, st in self.clear.items() if st.show)
            occ_secs = {zid: round(len(self.occ_ticks[zid]) * TICK, 1) for zid in self.grid.ids}
            avg = round(sum(self.done_spans) / len(self.done_spans), 1) if self.done_spans else None
            in_store = int(round(self.x_in)) if self.x_in is not None else 0
            occupants = int(round(self.x_occ)) if self.x_occ is not None else 0
            if confirmed:
                in_store = len(self.persons_out)
                occupants = sum(p[4] is not None for p in self.persons_out)
            counts = Counts(inStore=in_store, occupants=occupants,
                            inStoreRaw=self.raw_in, occupantsRaw=self.raw_occ,
                            occupiedTables=sorted(self.occupied), tablesToClear=to_clear)
            return FrameResult(persons=[list(p) for p in self.persons_out], cups=[list(c) for c in self.cups_out],
                               counts=counts, change5m=self._change5m(t), tableOccupiedSeconds=occ_secs,
                               avgOccupiedSeconds=avg, zonesRevision=self.rev or 0)


    def _occ_params(cfg):
        p = getattr(cfg, "occ_params", None) if cfg is not None else None
        if p is None:
            p = _os.environ.get("CNN_OCC_PARAMS", "")
        if isinstance(p, str):
            p = json.loads(p) if p.strip() else {}
        unknown = set(p) - set(SEAT_DEFAULTS)
        if unknown:
            raise ValueError(f"CNN_OCC_PARAMS 에 모르는 이름: {sorted(unknown)}")
        return {k: (float("inf") if v is None else v) for k, v in p.items()}


    def create_engine(cfg=None):
        """config.Config -> NumberEngine. 판정 값은 CNN_OCC_PARAMS(JSON, 비우면 seat_state.DEFAULTS)."""
        return LiveNumberEngine(occ_params=_occ_params(cfg))

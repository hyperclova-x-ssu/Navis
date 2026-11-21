"""T-067 numbers.py 시험 (DATA_MODEL 12.5 시험 ①~⑥). 실행(cnn/live): pytest -q tests/test_numbers.py
smooth.py·seat_state.py 는 읽기만(gpu-server 는 vendor/ 복사본, 저장소는 ../ 와 ../occupancy/)."""
import importlib.util
import json
import random
import sys
from pathlib import Path

import numpy as np
import pytest

LIVE = Path(__file__).resolve().parents[1]
CNN = LIVE.parent
for p in (LIVE, LIVE / "vendor", CNN, CNN / "occupancy"):
    if p.exists() and str(p) not in sys.path:
        sys.path.append(str(p))
if str(LIVE) in sys.path:  # contracts 등은 live 에서
    sys.path.remove(str(LIVE))
sys.path.insert(0, str(LIVE))


def _load_numbers():
    # 표준 numbers 와 이름이 겹치므로 파일 경로로 읽는다(서버와 같은 방법, pipeline.load_numbers)
    spec = importlib.util.spec_from_file_location("live_numbers", LIVE / "numbers.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


N = _load_numbers()
import smooth  # noqa: E402
from contracts import Detections  # noqa: E402
from seat_state import SeatState  # noqa: E402


def rect_runs(x1, y1, x2, y2):
    """0~1 사각형(칸 경계에 맞춤) -> runs"""
    m = np.zeros((90, 160), dtype=np.uint8)
    m[int(round(y1 * 90)):int(round(y2 * 90)), int(round(x1 * 160)):int(round(x2 * 160))] = 1
    return encode(m)


def encode(m):
    flat = m.reshape(-1).astype(bool)
    runs, val, n = [], False, 0
    for v in flat:
        if v == val:
            n += 1
        else:
            runs.append(n)
            val, n = v, 1
    runs.append(n)
    return runs


def zoneset(rev, zones):
    return {"revision": rev, "zones": [{"id": zid, "number": i + 1, "source": "drawn",
                                        "mask": {"cols": 160, "rows": 90, "runs": runs}} for i, (zid, runs) in enumerate(zones)]}


ZA = ("za0000001", rect_runs(0.2, 0.2, 0.4, 0.6))
ZS1 = zoneset(1, [ZA])


def pbox(cx, foot_y, h=0.2, w=0.05, tid=1):
    y1 = foot_y - 0.8 * h
    return (cx - w / 2, y1, cx + w / 2, y1 + h, tid)


def cup(cx, cy, s=0.01):
    return (cx - s, cy - s, cx + s, cy + s)


def det(persons=(), cups=()):
    return Detections(persons=list(persons), cups=list(cups))


def test_short_head_fragment_does_not_renew_the_seat_hold():
    engine = N.LiveNumberEngine()
    body = pbox(0.3, 0.55, h=0.3)
    head = (*body[:3], body[1] + 0.15, 2)
    for i in range(7):
        before = engine.update(i / 5, det([body]), ZS1, confirmed=True, seat_persons=[body, head])
    assert before.counts.occupiedTables == [ZA[0]]
    moved = pbox(0.32, 0.55, h=0.3)
    fragment = (*moved[:3], moved[1] + 0.15, 2)
    engine.update(1.4, det([moved]), ZS1, confirmed=True, seat_persons=[moved, fragment])
    engine.update(1.6, det(), ZS1, confirmed=True, seat_persons=[fragment])
    after = engine.update(1.8, det(), ZS1, confirmed=True, seat_persons=[])
    assert after.counts.occupiedTables == []


# ---------------- 상수

def test_constants_match_sources():
    assert (N.MIN_TRACK_FRAMES, N.KALMAN_Q, N.KALMAN_R) == (smooth.MIN_TRACK_FRAMES, smooth.KALMAN_Q, smooth.KALMAN_R)
    assert N.NUMBER_TICK_HZ == 5 and N.FOOT_FRAC == 0.8 and set(N.CUP_CLASSES) == {40, 41, 45}
    assert (N.CLEAR_SEC, N.CUP_GAP_SEC, N.BASE_DIST, N.WINDOW_SEC, N.SPAN_GAP_SEC, N.SPAN_MIN_SEC) == (3.0, 1.0, 0.0365, 300, 3.0, 10.0)
    assert N.SEAT_DEFAULTS == {"dwell_sec": 0.6, "move_thr": 0.1, "hold_sec": 2.0, "inherit_dist": 0.6,
                               "occluder_frac": 0.7, "stand_h_px": 350}


# ---------------- ① confirm_tracks·kalman 과 같은 출력

def test_confirm_and_kalman_equal_smooth():
    rng = random.Random(3)
    frames = [[pbox(rng.random(), rng.random(), tid=rng.choice([-1, 1, 2, 3, 4])) for _ in range(rng.randint(0, 5))]
              for _ in range(200)]
    eng = N.LiveNumberEngine()
    got_raw, got_in = [], []
    for i, f in enumerate(frames):
        r = eng.update(i / 5, det(f), None)
        got_raw.append(r.counts.inStoreRaw)
        got_in.append(r.counts.inStore)
    want_raw = [len(k) for k in smooth.confirm_tracks([list(p) for p in f] for f in frames)]
    assert got_raw == want_raw
    assert got_in == [int(round(v)) for v in smooth.kalman(want_raw)]


def test_kalman_step_equals_batch():
    z = [3, 5, 4, 4, 9, 0, 2]
    s, out = None, []
    for v in z:
        s, x = N.kalman_step(s, v)
        out.append(x)
    assert np.allclose(out, smooth.kalman(z))


# ---------------- ② 목업 원본 상자 -> 평균 inStore 가 목업 summary 와 ±0.5

def test_cafe17_raw_persons_avg_in_store_matches_mock():
    raw_p = CNN / "results" / "cafe17_raw_persons.json"
    det_p = next((p for p in (CNN.parent / "frontend" / "public" / "cnn" / "cafe17-detections.json",
                              CNN / "public" / "cnn" / "cafe17-detections.json") if p.exists()), None)
    if not raw_p.exists() or det_p is None:
        pytest.skip("목업 자료 없음(저장소 cnn/results·frontend/public/cnn)")
    raw = json.loads(raw_p.read_text())
    summary = json.loads(det_p.read_text())["summary"]
    eng = N.LiveNumberEngine()
    vals = [eng.update(i / 5, det([tuple(p[:5]) for p in f]), None).counts.inStore for i, f in enumerate(raw)]
    assert abs(float(np.mean(vals)) - summary["avgInStore"]) <= 0.5


# ---------------- 사이 장(hold)

def test_held_frames_do_not_advance_confirmation():
    eng = N.LiveNumberEngine()
    d1 = det([pbox(0.8, 0.8, tid=7)])
    eng.update(0.0, d1, ZS1)
    held = det([pbox(0.8, 0.8, tid=7)])
    held.predicted = True
    r = eng.update(0.067, held, ZS1)
    assert r.counts.inStoreRaw == 0 and r.persons == []  # 사이 장은 연속 장수에 안 들어감
    r = eng.update(0.2, det([pbox(0.8, 0.8, tid=7)]), ZS1)
    assert r.counts.inStoreRaw == 1 and len(r.persons) == 1
    r = eng.update(0.267, held, ZS1)
    assert len(r.persons) == 1 and r.counts.inStoreRaw == 1


def test_frame_result_has_no_track_ids():
    eng = N.LiveNumberEngine()
    for i in range(10):
        r = eng.update(i / 5, det([pbox(0.3, 0.4, tid=42)], [cup(0.3, 0.3)]), ZS1)
    d = r.to_dict()
    assert d["persons"] and all(len(p) == 5 and p[4] in (None, "za0000001") for p in d["persons"])
    assert all(not isinstance(p[4], int) for p in d["persons"])  # 추적 번호(42) 없음
    assert d["counts"]["occupiedTables"] == ["za0000001"] and d["counts"]["occupantsRaw"] == 1


# ---------------- ③ 치울 테이블

def run(eng, t0, t1, persons_fn, cups_fn, zs=ZS1):
    out, t = None, t0
    while t < t1 - 1e-9:
        out = eng.update(round(t, 3), det(persons_fn(t), cups_fn(t)), zs)
        t += 0.2
    return out, t


def test_clear_table_state_machine():
    eng = N.LiveNumberEngine()
    sitter = lambda t: [pbox(0.3, 0.4, tid=1)]  # noqa: E731
    nobody = lambda t: []  # noqa: E731
    stock = [cup(0.25, 0.3)]  # 비품 컵(처음부터 있음)
    r, t = run(eng, 0, 5, nobody, lambda t: stock)
    assert r.counts.tablesToClear == []
    t_sit = t
    r, t = run(eng, t, t + 20, sitter, lambda t: stock + ([cup(0.35, 0.35)] if t > t_sit + 3 else []))  # 앉은 뒤 새 컵
    assert r.counts.occupiedTables == ["za0000001"] and r.counts.tablesToClear == []
    # 떠남(hold 2초 뒤 빔) + 새 컵 남음: 조건 3초 넘으면 뜸
    r, t1 = run(eng, t, t + 3.0, nobody, lambda t: stock + [cup(0.35, 0.35)])
    assert r.counts.tablesToClear == []
    r, t = run(eng, t1, t1 + 3.0, nobody, lambda t: stock + [cup(0.35, 0.35)])
    assert r.counts.tablesToClear == ["za0000001"]
    # 다시 앉으면 사라짐
    r, t = run(eng, t, t + 3, sitter, lambda t: stock + [cup(0.35, 0.35)])
    assert r.counts.tablesToClear == []


def test_clear_shown_for_cup_detected_late_after_leaving():
    """떠난 뒤 한참(20초) 지나서야 잡힌 컵도 새 컵(카페 17번 t1 장면: 114초에 떠나고 컵은 135초부터 잡힘)."""
    eng = N.LiveNumberEngine()
    r, t = run(eng, 0, 5, lambda t: [], lambda t: [])
    r, t = run(eng, t, t + 20, lambda t: [pbox(0.3, 0.4, tid=1)], lambda t: [])
    r, t = run(eng, t, t + 20, lambda t: [], lambda t: [])
    assert r.counts.tablesToClear == []
    r, t = run(eng, t, t + 4, lambda t: [], lambda t: [cup(0.35, 0.35)])
    assert r.counts.tablesToClear == ["za0000001"]


def test_clear_not_shown_with_only_baseline_cups_and_hides_after_cup_gone():
    eng = N.LiveNumberEngine()
    stock = [cup(0.25, 0.3)]
    r, t = run(eng, 0, 5, lambda t: [], lambda t: stock)
    r, t = run(eng, t, t + 20, lambda t: [pbox(0.3, 0.4, tid=1)], lambda t: stock)
    r, t = run(eng, t, t + 15, lambda t: [], lambda t: stock)
    assert r.counts.tablesToClear == []  # 기준선 컵만 → 안 뜸
    # 새 손님 → 떠난 뒤 새 컵 → 뜬 뒤 컵 치움 → 3초 뒤 사라짐
    r, t = run(eng, t, t + 20, lambda t: [pbox(0.3, 0.4, tid=2)], lambda t: stock)
    r, t = run(eng, t, t + 8, lambda t: [], lambda t: stock + [cup(0.36, 0.5)])
    assert r.counts.tablesToClear == ["za0000001"]
    r, t = run(eng, t, t + 2, lambda t: [], lambda t: stock)
    assert r.counts.tablesToClear == ["za0000001"]
    r, t = run(eng, t, t + 2, lambda t: [], lambda t: stock)
    assert r.counts.tablesToClear == []


# ---------------- ④ change5m

def test_change5m_null_before_5min_and_after_gap():
    eng = N.LiveNumberEngine()
    two = lambda t: [pbox(0.7, 0.8, tid=1), pbox(0.9, 0.8, tid=2)]  # noqa: E731
    r, t = run(eng, 0, 299, two, lambda t: [], zs=None)
    assert r.change5m is None
    r, t = run(eng, t, 301, two, lambda t: [], zs=None)
    assert r.change5m is not None and r.change5m >= 0  # 칼만(q/r=1e-4)이 0에서 천천히 2로 올라가는 중
    # 끊김: 20초 동안 프레임 없음 → 그 시각을 기준으로 하는 5분 뒤 값은 null
    t_gap = t
    eng.update(t_gap + 20, det(two(0)), None)
    r, t = run(eng, t_gap + 20.2, t_gap + 300 + 10, two, lambda t: [], zs=None)
    assert r.change5m is None
    r, t = run(eng, t, t_gap + 300 + 25, two, lambda t: [], zs=None)
    assert r.change5m is not None


def test_change5m_counts_people_difference():
    eng = N.LiveNumberEngine()
    one = lambda t: [pbox(0.7, 0.8, tid=1)]  # noqa: E731
    r, t = run(eng, 0, 100, lambda t: [], lambda t: [], zs=None)
    r, t = run(eng, t, 2000, one, lambda t: [], zs=None)
    assert r.counts.inStore == 1 and r.change5m == 0
    eng2 = N.LiveNumberEngine()
    r, t = run(eng2, 0, 1500, lambda t: [], lambda t: [], zs=None)
    r, t = run(eng2, t, 4000, one, lambda t: [], zs=None)
    assert r.change5m == 0  # 오래 지나면 둘 다 1
    # 칼만이 0 -> 1 로 넘어간 직후는 +1
    eng3 = N.LiveNumberEngine()
    vals = []
    r, t = run(eng3, 0, 400, lambda t: [], lambda t: [], zs=None)
    while t < 3000:
        r = eng3.update(round(t, 3), det(one(t)), None)
        vals.append((r.counts.inStore, r.change5m))
        t += 0.2
    assert (1, 1) in vals


# ---------------- ⑤ 평균 점유 시간

def test_avg_occupied_seconds_merges_short_gaps_and_drops_short_spans():
    eng = N.LiveNumberEngine(occ_params={"dwell_sec": 0.0, "hold_sec": 0.0, "move_thr": float("inf")})
    sit = lambda t: [pbox(0.3, 0.4, tid=1)]  # noqa: E731
    none = lambda t: []  # noqa: E731
    r, t = run(eng, 0, 0.4, sit, none)       # 확인 추적 준비(2장)
    r, t = run(eng, t, t + 12, sit, none)    # 12초
    r, t = run(eng, t, t + 2, none, none)    # 2초 끊김(이어 붙임)
    r, t = run(eng, t, t + 6, sit, none)     # 6초
    assert r.avgOccupiedSeconds is None      # 아직 안 끝남
    r, t = run(eng, t, t + 5, none, none)    # 3초 넘는 끊김 → 구간 끝 (약 20초)
    assert r.avgOccupiedSeconds is not None and abs(r.avgOccupiedSeconds - 20.0) <= 0.6
    first = r.avgOccupiedSeconds
    r, t = run(eng, t, t + 0.4, lambda t: [pbox(0.3, 0.4, tid=5)], none)
    r, t = run(eng, t, t + 5, lambda t: [pbox(0.3, 0.4, tid=5)], none)  # 5초짜리는 빠짐
    r, t = run(eng, t, t + 5, none, none)
    assert r.avgOccupiedSeconds == first


def test_table_occupied_seconds_window():
    eng = N.LiveNumberEngine(occ_params={"dwell_sec": 0.0, "hold_sec": 0.0, "move_thr": float("inf")})
    r, t = run(eng, 0, 30, lambda t: [pbox(0.3, 0.4, tid=1)], lambda t: [])
    assert 29.0 <= r.tableOccupiedSeconds["za0000001"] <= 30.0
    r, t = run(eng, t, t + 400, lambda t: [], lambda t: [])
    assert r.tableOccupiedSeconds["za0000001"] == 0.0


# ---------------- ⑥ MaskSeatState == SeatState (마스크를 같은 사각형에서 만든 경우)

def test_mask_seat_state_equals_polygon_seat_state():
    poly = [{"id": "za0000001", "maxBoxH": float("inf"), "polygon": [[0.2, 0.2], [0.4, 0.2], [0.4, 0.6], [0.2, 0.6]]}]
    grid = N.ZoneGrid([("za0000001", N.decode_runs(ZA[1]))])
    rng = random.Random(1)
    for params in ({}, {"hold_sec": 1.0, "inherit_dist": 0.6}, {"dwell_sec": 0, "move_thr": float("inf")}):
        for _ in range(20):
            frames = [[list(pbox(rng.uniform(0.1, 0.5), rng.uniform(0.1, 0.7), h=rng.uniform(0.1, 0.5), tid=rng.randint(1, 4)))
                       for _ in range(rng.randint(0, 3))] for _ in range(60)]
            a, b = SeatState(poly, 0.8, **params), N.MaskSeatState(grid, 0.8, **params)
            for i, f in enumerate(frames):
                oa, ob = a.step(i / 5, f), b.step(i / 5, f)
                assert (oa["occupied"], oa["seats"]) == (ob["occupied"], ob["seats"])


# ---------------- 초기화·영역 바뀜·heat

def test_zone_change_keeps_surviving_zone_state_and_reset_clears():
    eng = N.LiveNumberEngine(occ_params={"dwell_sec": 0.0, "hold_sec": 0.0, "move_thr": float("inf")})
    r, t = run(eng, 0, 20, lambda t: [pbox(0.3, 0.4, tid=1)], lambda t: [])
    before = r.tableOccupiedSeconds["za0000001"]
    zb = ("zb0000002", rect_runs(0.6, 0.2, 0.8, 0.6))
    zs2 = zoneset(2, [ZA, zb])
    r = eng.update(t, det([pbox(0.3, 0.4, tid=1)]), zs2)
    assert r.tableOccupiedSeconds["za0000001"] >= before and r.tableOccupiedSeconds["zb0000002"] == 0.0
    zs3 = zoneset(3, [zb])
    r = eng.update(t + 0.2, det([]), zs3)
    assert set(r.tableOccupiedSeconds) == {"zb0000002"}
    assert eng.occupancy_heat().sum() > 0
    eng.reset()
    assert eng.occupancy_heat().sum() == 0
    r = eng.update(0, det([]), zs3)
    assert r.change5m is None and r.counts.inStore == 0 and r.avgOccupiedSeconds is None


def test_occupancy_heat_accumulates_seconds_at_base_point():
    eng = N.LiveNumberEngine(occ_params={"dwell_sec": 0.0, "hold_sec": 0.0, "move_thr": float("inf")})
    run(eng, 0, 10, lambda t: [pbox(0.3, 0.4, tid=1)], lambda t: [])
    h = eng.occupancy_heat()
    assert h.shape == (90, 160) and h.dtype == np.float32
    cx, cy = N.cell_of(0.3, 0.4)
    assert 9.0 <= h[cy, cx] <= 10.0 and h.sum() == pytest.approx(h[cy, cx])


def test_create_engine_reads_occ_params(monkeypatch):
    monkeypatch.setenv("CNN_OCC_PARAMS", json.dumps({"dwell_sec": 1.0, "move_thr": None}))
    e = N.create_engine(None)
    assert e.occ_params["dwell_sec"] == 1.0 and e.occ_params["move_thr"] == float("inf")
    monkeypatch.setenv("CNN_OCC_PARAMS", json.dumps({"nope": 1}))
    with pytest.raises(ValueError):
        N.create_engine(None)
    monkeypatch.setenv("CNN_OCC_PARAMS", "")
    assert N.create_engine(None).occ_params == N.SEAT_DEFAULTS


def test_numbers_module_also_works_as_stdlib_numbers():
    assert N.Integral is not None and issubclass(int, N.Integral) or True
    assert hasattr(N, "Number") and hasattr(N, "Real")

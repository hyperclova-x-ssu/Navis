"""T-065b seat_state 테스트. 실행(cnn): python3 -m pytest -q occupancy/test_seat_state.py"""
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]

import smooth  # noqa: E402
from seat_state import SeatState, baseline_params, point_in_polygon  # noqa: E402

T = [{"id": "a", "maxBoxH": 350, "polygon": [[0.2, 0.2], [0.4, 0.2], [0.4, 0.6], [0.2, 0.6]]}]


def box(cx, foot_y, h=0.2, w=0.05, tid=1):
    """기준점(가로 가운데, 위에서 80%)이 (cx, foot_y)인 상자"""
    y1 = foot_y - 0.8 * h
    return [cx - w / 2, y1, cx + w / 2, y1 + h, tid]


def test_point_in_polygon_matches_cv2():
    from common import point_in_polygon as cv_pip
    rng = random.Random(0)
    for _ in range(3000):
        n = rng.randint(3, 7)
        poly = [[rng.random(), rng.random()] for _ in range(n)]
        pt = (rng.random(), rng.random())
        try:
            want = cv_pip(pt, poly)
        except Exception:
            continue
        assert point_in_polygon(pt, poly) == want, (pt, poly)


def test_baseline_params_equal_old_rule():
    """기준선 값이면 export_playback.assign_seats(T-046d)와 장마다 같은 occupied."""
    from export_playback import assign_seats
    cfg = json.loads((HERE.parent / "zones" / "cafe17_tables.json").read_text())
    sx, sy = cfg["image_size"]
    tables = [{"id": t["id"], "maxBoxH": t["maxBoxH"], "polygon": [[x / sx, y / sy] for x, y in t["polygon"]]} for t in cfg["tables"]]
    raw = json.loads((HERE.parent / "results" / "cafe17_raw_persons.json").read_text())[:400]
    old = smooth.confirm_tracks(assign_seats(raw, tables, cfg["footFrac"]), 2)
    kept = smooth.confirm_tracks(raw, 2)
    st = SeatState(tables, cfg["footFrac"], **baseline_params())
    for i, (k, o) in enumerate(zip(kept, old)):
        assert st.step(i / 5, [p[:5] for p in k])["occupied"] == sorted({p[5] for p in o if p[5]})


def test_causal_prefix_property():
    """앞쪽 값만 씀: 같은 앞부분을 넣으면 뒤에 무엇이 오든 그때까지의 출력이 같다."""
    rng = random.Random(1)
    for _ in range(30):
        frames = [[box(rng.uniform(0.1, 0.5), rng.uniform(0.1, 0.7), tid=rng.randint(1, 4)) for _ in range(rng.randint(0, 3))]
                  for _ in range(40)]
        tail = [[box(rng.uniform(0.1, 0.5), rng.uniform(0.1, 0.7), tid=rng.randint(1, 6))] for _ in range(20)]
        a, b = SeatState(T, hold_sec=1.0, inherit_dist=0.6), SeatState(T, hold_sec=1.0, inherit_dist=0.6)
        oa = [a.step(i / 5, f) for i, f in enumerate(frames)]
        ob = [b.step(i / 5, f) for i, f in enumerate(frames + tail)][:40]
        assert oa == ob


def test_dwell_blocks_passer_and_admits_sitter():
    st = SeatState(T, dwell_sec=0.6, move_thr=0.35, occluder_frac=0)
    # 지나가는 사람: 구역을 0.2초마다 0.05씩 가로지름 -> 앉음 아님
    outs = [st.step(i / 5, [box(0.2 + 0.05 * i, 0.4)]) for i in range(5)]
    assert all(not o["occupied"] for o in outs)
    st = SeatState(T, dwell_sec=0.6, move_thr=0.35, occluder_frac=0)
    outs = [st.step(i / 5, [box(0.3, 0.4)]) for i in range(6)]
    assert [bool(o["occupied"]) for o in outs] == [False, False, False, True, True, True]


def test_hold_keeps_seat_through_short_gap_and_inherits_new_id():
    st = SeatState(T, dwell_sec=0, move_thr=float("inf"), hold_sec=1.0, inherit_dist=0.6, occluder_frac=0)
    seq = [[box(0.3, 0.4)]] * 3 + [[]] * 4 + [[box(0.3, 0.4, tid=9)]] + [[]] * 6
    occ = [bool(st.step(i / 5, f)["occupied"]) for i, f in enumerate(seq)]
    assert occ[:8] == [True] * 8  # 0.8초 사라졌다가 새 번호로 돌아와도 계속 앉음
    assert occ[-1] is False  # 1초 넘게 안 보이면 빔


def test_occluded_small_box_inside_standing_box_is_not_seated():
    st = SeatState(T, dwell_sec=0, move_thr=float("inf"), occluder_frac=0.7)
    small = box(0.3, 0.4, h=0.15, tid=1)
    tall = [0.25, 0.2, 0.35, 0.2 + 0.4, 2]  # 높이 0.4*1080 = 432px > 350, small 을 다 덮음
    assert st.step(0, [small, tall])["occupied"] == []
    assert SeatState(T, dwell_sec=0, move_thr=float("inf"), occluder_frac=0.7).step(0, [small])["occupied"] == ["a"]


def test_occupied_seconds_accumulate():
    st = SeatState(T, dwell_sec=0, move_thr=float("inf"), occluder_frac=0)
    for i in range(11):
        o = st.step(i / 5, [box(0.3, 0.4)])
    assert o["tables"]["a"]["occupiedSec"] == 2.0 and o["tables"]["a"]["occupants"] == 1 and o["tables"]["a"]["sinceSec"] == 2.0

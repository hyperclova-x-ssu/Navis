"""T-065b 5: 약한 PC 설정(T-065, gpu-server CPU 4코어 흉내)의 탐지 결과로 테이블 사용 중/빈 자리 판정을 다시 계산.
입력: T-065 bench_cpu.py 가 남긴 cpu_frames/<모델>_<런타임>_<크기>_N<간격>_raw.json (탐지한 장만, 확인 전 상자+추적 번호)
      Mac 으로 복사(읽기만):
      scp 'user@gpu-server:~/navis-cnn-live/cnn/bench/results/cpu_frames/*_raw.json' ~/Datasets/cafe-sample/t065b/cpu_frames/
실행(cnn 에서, evaluate_occupancy.py 를 먼저 한 번): python3 occupancy/evaluate_weakpc.py -> occupancy/results/eval_weakpc.json
판정: 탐지한 장마다 확인된 추적(N=2) -> SeatState.step, 사이 장은 직전 결과 유지(bench_cpu.pipeline 과 같음).
설정마다 세 가지: baseline(T-046d 판정), gpuDefault(seat_state.DEFAULTS), perConfig(그 설정 탐지로 앞쪽 절반에서 고른 값,
뒤쪽 절반 검증 — D-376 '판정 값은 탐지 설정별로'). 정답 정의는 evaluate_occupancy 와 같음(occupied 주, seatedOld 나란히)."""
import itertools
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent), str(HERE)]

import smooth  # noqa: E402
from evaluate_occupancy import EXT, RES, fmt, ground_truth_cached, load_cfg, metrics, objective  # noqa: E402
from seat_state import DEFAULTS, SeatState, baseline_params  # noqa: E402

FPS = 5
SRC = EXT / "cpu_frames"
GRID = {"dwell_sec": [0.0, 0.6, 1.0], "move_thr": [0.1, float("inf")], "hold_sec": [0.0, 1.0, 2.0, 3.0],
        "inherit_dist": [-1.0, 0.6], "occluder_frac": [0.0, 0.7, 0.9]}
# 허용선(D-373, 임시): 기준선(맥 YOLO11s 1280 + T-046d 판정) 대비 손님 수 +2%p, 점유 정확도·머문 인원 오차 3%p


def run_sparse(det_frames, n, tables, foot, params):
    """det_frames: [{"i", "persons": [[x1,y1,x2,y2,tid]]}] (탐지한 장만) -> n장 출력(사이 장은 직전 유지), 손님 수"""
    kept = smooth.confirm_tracks([[list(p[:5]) + [None] for p in f["persons"]] for f in det_frames], smooth.MIN_TRACK_FRAMES)
    by_i = {f["i"]: k for f, k in zip(det_frames, kept)}
    st = SeatState(tables, foot, **params)
    outs, ins, last, li = [], [], {"occupied": [], "occupantCount": 0}, 0
    for i in range(n):
        if i in by_i:
            last = st.step(i / FPS, [p[:5] for p in by_i[i]])
            li = len(by_i[i])
        outs.append(last)
        ins.append(li)
    return outs, ins


def short(m):
    return {"occInclude": m["occupancy"]["include"]["all"], "occExclude": m["occupancy"]["exclude"]["all"],
            "perTableInclude": m["occupancy"]["include"]["perTable"],
            "occupantsInclude": m["occupants"]["include"]["smoothed"], "occupantsExclude": m["occupants"]["exclude"]["smoothed"],
            "inStore": m["inStore"]}


def main():
    cfg, tables, _ = load_cfg()
    tids = [t["id"] for t in tables]
    foot = cfg.get("footFrac", 0.8)
    gt_in, TR = ground_truth_cached()
    truth = TR["occupied"]
    n = len(truth)
    A, Bh = slice(0, n // 2), slice(n // 2, n)
    srcs = [("mac_yolo11s_mps_1280_N1", None)] + [(p.stem.replace("_raw", ""), p) for p in sorted(SRC.glob("*_raw.json"))]
    rows = []
    for tag, path in srcs:
        if path is None:
            raw = json.loads((HERE.parent / "results" / "cafe17_raw_persons.json").read_text())
            det, info = [{"i": i, "persons": [p[:5] for p in ps]} for i, ps in enumerate(raw)], {"source": "1920x1080 원본 jpg (기준선 입력)"}
        else:
            d = json.loads(path.read_text())
            det, info = d["frames"], {k: d.get(k) for k in ("model", "runtime", "imgsz", "interval", "source")}
        grid = []
        for vals in itertools.product(*GRID.values()):
            p = dict(zip(GRID, vals))
            if p["hold_sec"] == 0 and p["inherit_dist"] >= 0:
                continue
            o, ins = run_sparse(det, n, tables, foot, p)
            grid.append((p, metrics(o, ins, gt_in, truth, tids, A)))
        b_o, b_ins = run_sparse(det, n, tables, foot, baseline_params())
        lim = metrics(b_o, b_ins, gt_in, truth, tids, A)["occupants"]["include"]["smoothed"] + 0.03
        per_p = max([g for g in grid if g[1]["occupants"]["include"]["smoothed"] <= lim], key=lambda g: objective(g[1]))[0]
        row = {"config": tag, **info, "perConfigParams": fmt(per_p)}
        for name, p in (("baseline", baseline_params()), ("gpuDefault", DEFAULTS), ("perConfig", per_p)):
            o, ins = run_sparse(det, n, tables, foot, p)
            row[name] = {"occupied": short(metrics(o, ins, gt_in, truth, tids)),
                         "occupiedSecondHalf": short(metrics(o, ins, gt_in, truth, tids, Bh)),
                         "seatedOld": short(metrics(o, ins, gt_in, TR["seatedOld"], tids))}
        rows.append(row)
        r = row["perConfig"]["occupied"]
        print(tag, "base", row["baseline"]["occupied"]["occInclude"], row["baseline"]["occupied"]["occExclude"],
              "-> perConfig", r["occInclude"], r["occExclude"], "occupants", r["occupantsInclude"], "inStore", r["inStore"], fmt(per_p), flush=True)
    ref = {d: rows[0]["baseline"][d] for d in ("occupied", "seatedOld")}
    for row in rows:
        for d in ("occupied", "seatedOld"):
            r, b = row["perConfig"][d], ref[d]
            row.setdefault("withinTolerance", {})[d] = {
                "inStore": r["inStore"] <= b["inStore"] + 0.02, "occInclude": r["occInclude"] >= b["occInclude"] - 0.03,
                "occExclude": r["occExclude"] >= b["occExclude"] - 0.03, "occupantsInclude": r["occupantsInclude"] <= b["occupantsInclude"] + 0.03}
            row["withinTolerance"][d]["all"] = all(row["withinTolerance"][d].values())
    out = {"measuredAt": time.strftime("%Y-%m-%d %H:%M %Z"), "frames": n, "gpuDefault": fmt(DEFAULTS),
           "grid": {k: [None if v == float("inf") else v for v in vs] for k, vs in GRID.items()},
           "reference": "허용선 기준 = rows[0].baseline (맥 YOLO11s 1280 + T-046d 판정), 정의별", "rows": rows}
    RES.mkdir(exist_ok=True)
    (RES / "eval_weakpc.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()

"""T-065b: seat_state.SeatState(테이블 사용 중/빈 자리 판정 보강)를 기준선(T-046d)과 비교.
정답 정의 두 가지를 나란히 낸다(D-376):
 - occupied(새, 주 비교): 테이블 구역에 머무는 손님 = 정답 행동이 줄 서기(1)·주문(2)이 아닌 사람(Fighting 포함).
   정답 상자는 가려진 다리까지 그린 상자라 탐지 상자보다 길다 -> 정답 상자의 기준점 높이 GT_FOOT 를
   '탐지 상자 80% 지점과 같은 몸 위치'로 맞춘다. 값은 앞쪽 절반에서 짝지은 상자(IoU>=0.5, 구역 안)의 중앙값으로 자동 결정.
 - seatedOld(옛, T-046d 와 같음): 앉는 활동(식사·작업·셀카) + 정답 상자 80% 지점.
 두 정의 모두 outlier(무리 밖, 행동 7) 포함/제외 두 경우. '머문 인원' 오차 = 칼만 후 상대 오차.
 - 값 고르기: 앞쪽 절반(0~858장)에서 occupied 정의로 격자 탐색 -> 뒤쪽 절반(859~1717장)으로 검증, 이웃 값 흔들림
 - 치울 테이블: export_playback.analyze 에 새 점유를 넣어 다시 계산
실행(cnn 에서): python3 occupancy/evaluate_occupancy.py   -> occupancy/results/eval_mac.json (약 1분, 모델 불필요)
정답 gt_tracks.txt·사진 목록(~/Datasets/cafe-sample, 읽기만) 필요."""
import itertools
import json
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CNN = HERE.parent
sys.path[:0] = [str(CNN), str(HERE)]

import smooth  # noqa: E402
from posture import Posture  # noqa: E402
from seat_state import DEFAULTS, SeatState, baseline_params, point_in_polygon  # noqa: E402

FPS = 5
RES = HERE / "results"
EXT = Path.home() / "Datasets/cafe-sample/t065b"  # 저장소 밖 캐시(정답 숫자·pose·약한 PC 탐지)
GT_CACHE = EXT / "gt_cafe17_v2.json"
POSE = EXT / "pose_yolo11s-pose_1280.json"  # extract_pose.py 결과
MOVING_ACTS = {1, 2}  # 줄 서기, 주문: 테이블에 머무는 손님이 아님
OUTLIER = 7
GRID = {"dwell_sec": [0.0, 0.6, 1.0, 2.0, 3.0],
        "move_thr": [0.1, 0.2, 0.35, float("inf")],
        "hold_sec": [0.0, 0.6, 1.0, 2.0, 3.0],
        "inherit_dist": [-1.0, 0.6],
        "occluder_frac": [0.0, 0.5, 0.7, 0.9]}


def load_cfg():
    cfg = json.loads((CNN / "zones" / "cafe17_tables.json").read_text())
    sx, sy = cfg["image_size"]
    tables = [{"id": t["id"], "maxBoxH": t["maxBoxH"], "polygon": [[x / sx, y / sy] for x, y in t["polygon"]]}
              for t in cfg["tables"]]
    supply = [[[x / sx, y / sy] for x, y in s["polygon"]] for s in cfg.get("supply", [])]
    return cfg, tables, supply


def gt_frames():
    """프레임별 정답 상자([0..1] 좌표, 행동). 프레임 순서 = export 와 같음."""
    from common import CLIP_FROM, CLIP_TO, DATA, frame_index, load_gt
    gt, out, cnt = load_gt(), [], []
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        for n, _ in frame_index(DATA / "Dataset/cafe/17" / str(clip)):
            boxes = gt.get((clip, n), [])
            cnt.append(len(boxes))  # 손님 수 정답 = 전원(smooth.ground_truth 와 같음)
            out.append([[x1 / 1280, y1 / 720, x2 / 1280, y2 / 720, act] for x1, y1, x2, y2, _g, act in boxes if x1 >= 0])
    return out, cnt


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    return i / max(1e-12, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i)


def calibrate_gt_foot(gtf, kept, tables, foot, frames):
    """짝지은 정답·탐지 상자(IoU>=0.5, 탐지 기준점이 테이블 구역 안 + 높이<=maxBoxH)에서 탐지 기준점이
    정답 상자 위에서 몇 % 높이인지의 중앙값 -> 정답 기준점 높이. frames 범위(앞쪽 절반)만 사용."""
    r = []
    for i in frames:
        for g in gtf[i]:
            best = max(kept[i], key=lambda p: iou(g, p), default=None)
            if best is None or iou(g, best) < 0.5:
                continue
            h = best[3] - best[1]
            pt = ((best[0] + best[2]) / 2, best[1] + foot * h)
            if any(h * 1080 <= t["maxBoxH"] and point_in_polygon(pt, t["polygon"]) for t in tables):
                r.append((pt[1] - g[1]) / (g[3] - g[1]))
    return round(statistics.median(r), 3), len(r)


def make_truth(gtf, tables, gt_foot, keep_act):
    """프레임별 {tid: (확실한 사람 수, outlier 수)} — smooth.table_scores 와 같은 형식."""
    out = []
    for boxes in gtf:
        row = {t["id"]: [0, 0] for t in tables}
        for x1, y1, x2, y2, act in boxes:
            if not keep_act(act):
                continue
            pt = ((x1 + x2) / 2, y1 + (y2 - y1) * gt_foot)
            for t in tables:
                if point_in_polygon(pt, t["polygon"]):
                    row[t["id"]][1 if act == OUTLIER else 0] += 1
                    break
        out.append({k: tuple(v) for k, v in row.items()})
    return out


def truths(cfg, tables, kept, foot, half):
    """{'occupied': ..., 'seatedOld': ...} 와 보정값. 정답에서 뽑은 숫자는 저장소 밖에 캐시."""
    gtf, gt_in = gt_frames()
    gt_foot, npairs = calibrate_gt_foot(gtf, kept, tables, foot, range(half))
    occ = make_truth(gtf, tables, gt_foot, lambda a: a not in MOVING_ACTS)
    old = make_truth(gtf, tables, cfg.get("footFrac", 0.8), lambda a: a in smooth.SIT_ACTS or a == OUTLIER)
    return gt_in, {"occupied": occ, "seatedOld": old}, {"gtFoot": gt_foot, "pairs": npairs}, gtf


def run(persons_frames, tables, foot, params, times=None, pose=None, pose_every=1, thigh_thr=0.6):
    st = SeatState(tables, foot, **params)
    post = Posture(thigh_thr=thigh_thr) if pose is not None else None
    outs = []
    for i, pers in enumerate(persons_frames):
        now = i / FPS if times is None else times[i]
        ps = [p[:5] for p in pers]
        if post is not None:
            ps = post.update(now, ps, pose[i] if i % pose_every == 0 else None)
        outs.append(st.step(now, ps))
    return outs


def metrics(outs, in_store, gt_in, truth, tids, sl=slice(None)):
    occ = [o["occupied"] for o in outs][sl]
    tr = truth[sl]
    sc = smooth.table_scores(occ, None, tr, tids)
    cnt_sm = [int(round(v)) for v in smooth.kalman([o["occupantCount"] for o in outs])][sl]
    cnt_raw = [o["occupantCount"] for o in outs][sl]
    return {"occupancy": {m: {"all": sc[m]["occupancyAccuracy"], "perTable": sc[m]["perTable"]} for m in ("include", "exclude")},
            "occupants": {m: {"smoothed": smooth.score(cnt_sm, smooth.seated_gt_counts(tr, m))["relative"],
                              "raw": smooth.score(cnt_raw, smooth.seated_gt_counts(tr, m))["relative"]} for m in ("include", "exclude")},
            "inStore": smooth.score([int(round(v)) for v in smooth.kalman(in_store)][sl], gt_in[sl])["relative"]}


def objective(m):
    """점유 정확도(outlier 포함·제외 평균)."""
    return (m["occupancy"]["include"]["all"] + m["occupancy"]["exclude"]["all"]) / 2


def clear_events(outs, objs, tables, supply):
    import export_playback as ep
    frames = [{"persons": [[0, 0, 0, 0, -1, t] for t in o["occupied"]], "cups": [x[:4] for x in ob if x[4] in ep.CUP_CLASSES]}
              for o, ob in zip(outs, objs)]
    events, occ = ep.analyze(frames, tables, supply)
    return events, {k: round(v / FPS, 1) for k, v in occ.items()}


def neighbors(best):
    out = []
    for k, vals in GRID.items():
        i = vals.index(best[k])
        out += [{**best, k: vals[j]} for j in (i - 1, i + 1) if 0 <= j < len(vals)]
    return out


def fmt(p):
    return {k: (None if v == float("inf") else v) for k, v in p.items()}


def changed_cells(a, b, tids):
    """두 정답에서 '사용 중' 판단(outlier 포함)이 다른 칸 수와 방향"""
    on = off = 0
    for ra, rb in zip(a, b):
        for t in tids:
            x, y = sum(ra[t]) > 0, sum(rb[t]) > 0
            on += (not x) and y
            off += x and not y
    return {"emptyToOccupied": on, "occupiedToEmpty": off, "total": on + off}


def error_breakdown(outs, truth, gtf, tables, gt_foot, kept):
    """occupied 정의(outlier 포함)에서 틀린 칸 분류: 놓침(FN) / 사용 중 오표시(FP: 구역 안 정답이 줄·주문 손님 / 정답 없음)"""
    tids = [t["id"] for t in tables]
    poly = {t["id"]: t["polygon"] for t in tables}
    res = {t: {"FN": 0, "FP_queueOrder": 0, "FP_noGT": 0} for t in tids}
    for i, (o, row) in enumerate(zip(outs, truth)):
        for t in tids:
            g, p = sum(row[t]) > 0, t in o["occupied"]
            if g and not p:
                res[t]["FN"] += 1
            elif p and not g:
                acts = {b[4] for b in gtf[i] if point_in_polygon(((b[0] + b[2]) / 2, b[1] + (b[3] - b[1]) * gt_foot), poly[t])}
                res[t]["FP_queueOrder" if acts & MOVING_ACTS else "FP_noGT"] += 1
    return res


def main():
    t0 = time.time()
    cfg, tables, supply = load_cfg()
    tids = [t["id"] for t in tables]
    foot = cfg.get("footFrac", 0.8)
    raw = json.loads((CNN / "results" / "cafe17_raw_persons.json").read_text())
    kept = smooth.confirm_tracks(raw, smooth.MIN_TRACK_FRAMES)
    in_store = [len(k) for k in kept]
    n = len(kept)
    half = n // 2
    A, Bh = slice(0, half), slice(half, n)
    gt_in, TR, calib, gtf = truths(cfg, tables, kept, foot, half)
    truth = TR["occupied"]
    # 정의 바뀜으로 달라진 칸: 활동 규칙만(80% 지점 그대로) / 기준점 보정까지
    act_only = make_truth(gtf, tables, foot, lambda a: a not in MOVING_ACTS)
    changes = {"activityRuleOnly": changed_cells(TR["seatedOld"], act_only, tids),
               "activityPlusGtFoot": changed_cells(TR["seatedOld"], truth, tids), "cells": n * len(tids)}

    base_out = run(kept, tables, foot, baseline_params())
    base_a = metrics(base_out, in_store, gt_in, truth, tids, A)
    rows = []
    for vals in itertools.product(*GRID.values()):
        p = dict(zip(GRID, vals))
        if p["hold_sec"] == 0 and p["inherit_dist"] >= 0:
            continue
        o = run(kept, tables, foot, p)
        rows.append((p, metrics(o, in_store, gt_in, truth, tids, A), metrics(o, in_store, gt_in, truth, tids, Bh)))
    lim = base_a["occupants"]["include"]["smoothed"] + 0.03  # 머문 인원 오차가 기준선 앞쪽 절반 +3%p 넘으면 제외
    ok = [r for r in rows if r[1]["occupants"]["include"]["smoothed"] <= lim]
    best_p = max(ok, key=lambda r: objective(r[1]))[0]

    def only(*conds):
        cand = [r for r in ok if all(c(r[0]) for c in conds)]
        return max(cand, key=lambda r: objective(r[1]))[0] if cand else None

    still = lambda p: p["dwell_sec"] > 0 or p["move_thr"] != float("inf")  # noqa: E731
    variants = {"baseline": baseline_params(),
                "still": only(lambda p: p["hold_sec"] == 0, lambda p: p["occluder_frac"] == 0),
                "hold": only(lambda p: not still(p), lambda p: p["occluder_frac"] == 0),
                "stillPlusHold": only(lambda p: p["occluder_frac"] == 0),
                "occlusion": only(lambda p: not still(p), lambda p: p["hold_sec"] == 0),
                "previousRecommendation(seatedOld)": {**DEFAULTS, "dwell_sec": 0.6, "move_thr": 0.35, "hold_sec": 0.0,
                                                      "inherit_dist": -1.0, "occluder_frac": 0.7},
                "best": best_p}
    pose = json.loads(POSE.read_text())["frames"] if POSE.exists() else None
    pose_rows = []
    if pose is not None:  # ③ 자세 판정을 고른 값 위에 얹어 thigh_thr 를 앞쪽 절반으로 고름 + 3장마다
        for thr in (0.45, 0.6, 0.8, 1.0):
            o = run(kept, tables, foot, best_p, pose=pose, thigh_thr=thr)
            pose_rows.append((thr, objective(metrics(o, in_store, gt_in, truth, tids, A))))
        thr = max(pose_rows, key=lambda r: r[1])[0]
        variants["best+pose"] = (best_p, {"pose": pose, "thigh_thr": thr})
        variants["best+pose/3장마다"] = (best_p, {"pose": pose, "thigh_thr": thr, "pose_every": 3})
    objs = json.loads((CNN / "results" / "cafe17_raw_objects.json").read_text())
    methods = {}
    for name, p in variants.items():
        p, kw = p if isinstance(p, tuple) else (p, {})
        o = run(kept, tables, foot, p, **kw)
        ev, occ_sec = clear_events(o, objs, tables, supply)
        methods[name] = {"params": {**fmt(p), **{k: v for k, v in kw.items() if k != "pose"}},
                         "occupied": {"all": metrics(o, in_store, gt_in, truth, tids),
                                      "firstHalf": metrics(o, in_store, gt_in, truth, tids, A),
                                      "secondHalf": metrics(o, in_store, gt_in, truth, tids, Bh)},
                         "seatedOld": {"all": metrics(o, in_store, gt_in, TR["seatedOld"], tids),
                                       "secondHalf": metrics(o, in_store, gt_in, TR["seatedOld"], tids, Bh)},
                         "tablesToClearEvents": ev, "tableOccupiedSeconds": occ_sec}
        if name in ("baseline", "best"):
            methods[name]["errorBreakdownOccupied"] = error_breakdown(o, truth, gtf, tables, calib["gtFoot"], kept)
    sens = []
    for p in neighbors(best_p):
        m = metrics(run(kept, tables, foot, p), in_store, gt_in, truth, tids)
        sens.append({"params": fmt(p), "occInclude": m["occupancy"]["include"]["all"], "occExclude": m["occupancy"]["exclude"]["all"],
                     "occupantsInclude": m["occupants"]["include"]["smoothed"]})
    top = sorted(rows, key=lambda r: -objective(r[1]))[:10]
    out = {"measuredAt": time.strftime("%Y-%m-%d %H:%M %Z"), "frames": n, "split": {"firstHalf": [0, half - 1], "secondHalf": [half, n - 1]},
           "input": "results/cafe17_raw_persons.json (YOLO11s imgsz 1280 mps, ByteTrack) + 확인된 추적 N=2",
           "definition": {"occupied": "정답 행동이 줄 서기·주문이 아닌 사람의 기준점(정답 상자 위에서 gtFoot)이 테이블 구역 안 = 사용 중. outlier 포함/제외",
                          "seatedOld": "T-046d 그대로: 식사·작업·셀카 + 80% 지점",
                          "occupants": "테이블에 머문 인원 오차 = 칼만(q=0.0001) 후 상대 오차, 같은 정답 정의",
                          "inStore": "손님 수(판정과 무관, 확인된 추적 수, 칼만 후)"},
           "gtFootCalibration": calib, "definitionChanges": changes,
           "objective": "앞쪽 절반 occupied 점유 정확도(outlier 포함·제외 평균), 머문 인원 오차(포함)가 기준선 앞쪽 절반 +3%p 이내",
           "grid": {k: [None if v == float("inf") else v for v in vs] for k, vs in GRID.items()}, "gridRuns": len(rows),
           "chosen": fmt(best_p), "poseThighFirstHalf": pose_rows, "methods": methods, "sensitivity": sens,
           "topFirstHalf": [{"params": fmt(p), "firstHalf": round(objective(a), 4), "secondHalf": round(objective(b), 4)} for p, a, b in top],
           "elapsedSec": round(time.time() - t0, 1)}
    RES.mkdir(exist_ok=True)
    (RES / "eval_mac.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    EXT.mkdir(parents=True, exist_ok=True)
    GT_CACHE.write_text(json.dumps({"inStore": gt_in, "gtFoot": calib["gtFoot"], **{k: [{t: list(v) for t, v in r.items()} for r in tr]
                                                                                   for k, tr in TR.items()}}, separators=(",", ":")))
    for k, v in methods.items():
        a = v["occupied"]["all"]
        print(k, a["occupancy"]["include"]["all"], a["occupancy"]["exclude"]["all"], a["occupants"]["include"]["smoothed"], v["params"])
    print("chosen", fmt(best_p), "gtFoot", calib, "elapsed", out["elapsedSec"])


def ground_truth_cached():
    """evaluate_weakpc 용: 캐시된 정답(없으면 main 을 먼저 실행)"""
    g = json.loads(GT_CACHE.read_text())
    conv = lambda tr: [{t: tuple(v) for t, v in r.items()} for r in tr]  # noqa: E731
    return g["inStore"], {"occupied": conv(g["occupied"]), "seatedOld": conv(g["seatedOld"])}


if __name__ == "__main__":
    main()

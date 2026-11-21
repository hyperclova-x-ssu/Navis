"""숫자 안정화(T-046): 확인된 추적만 세기 + 1차원 칼만 필터(앞쪽 값만 쓰는 causal) + 정답 대비 보정 전후 비교.
team/CNN.md 4.7절. 모델 없이 프레임별 persons 만 있으면 다시 계산할 수 있다."""
import numpy as np

MIN_TRACK_FRAMES = 2  # 연속 이 장수 이상 잡힌 추적부터 센다 (README 에 선택 근거)
KALMAN_Q = 0.0001  # 공정 잡음: 실제 인원이 한 장 사이에 바뀔 수 있는 정도(작을수록 천천히 따라감)
KALMAN_R = 1.0  # 측정 잡음: 한 장 탐지 숫자의 흔들림 (q/r 비율만 결과에 영향)


def confirm_tracks(raw_persons, min_frames=MIN_TRACK_FRAMES):
    """프레임별 persons(원본, [x1,y1,x2,y2,trackId,seat]) -> 확인된 추적만 남긴 프레임별 persons.
    같은 trackId 가 연속 min_frames 장 이상 잡힌 장부터 센다(그 전 장들은 제외). 추적 번호 없음(-1)은 제외."""
    streak, out = {}, []
    for persons in raw_persons:
        cur, keep = {}, []
        for p in persons:
            if p[4] < 0:
                continue
            cur[p[4]] = streak.get(p[4], 0) + 1
            if cur[p[4]] >= min_frames:
                keep.append(p)
        streak = cur
        out.append(keep)
    return out


def kalman(z, q=KALMAN_Q, r=KALMAN_R):
    """수준(level) 모델 1차원 칼만 필터. 각 시점은 그 시점까지의 값만 사용(causal)."""
    x, P, out = float(z[0]), float(r), []
    for v in z:
        P += q
        k = P / (P + r)
        x += k * (v - x)
        P *= 1 - k
        out.append(x)
    return out


def changes_per_minute(values, fps):
    v = np.asarray(values)
    return float((np.diff(v) != 0).sum() / (len(v) / fps / 60))


def score(pred, truth):
    p, g = np.asarray(pred, float), np.asarray(truth, float)
    return {"mae": round(float(np.abs(p - g).mean()), 3), "relative": round(float(np.abs(p - g).sum() / g.sum()), 3)}


def ground_truth():
    """Café 정답 -> 프레임별 (손님 수, 앉은 인원). 프레임 순서는 export 와 같다(클립 순서, N 순서)."""
    from common import CLIP_FROM, CLIP_TO, DATA, frame_index, load_gt
    from evaluate import gt_counts
    gt, a, b = load_gt(), [], []
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        for n, _ in frame_index(DATA / "Dataset/cafe/17" / str(clip)):
            g = gt_counts(gt.get((clip, n), []))
            a.append(g["persons"])
            b.append(g["seated"])
    return a, b


STAND_OR_NONE = {1, 2, 5}  # Queueing, Ordering, Fighting: 서 있음(앉음 아님)
SIT_ACTS = {3, 4, 6}  # Eating/Drinking, Working/Studying, TakingSelfie
OUTLIER_ACT = 7  # 무리 밖(outlier): 앉음 여부를 알 수 없음


def seated_truth(tables_px, foot_frac=0.8, scale=1.5):
    """T-046c 정답 다시 정의. tables_px = [{id, polygon}] (1920x1080 픽셀). 정답 상자(1280x720 기준, x1.5)의
    같은 기준점(가로 가운데, 위에서 foot_frac)이 테이블 구역 안이고 행동이 앉는 활동이면 '앉은 사람',
    outlier 이면 '알 수 없음'. 반환: 프레임별 {tid: (확실히 앉은 수, outlier 수)}."""
    from common import CLIP_FROM, CLIP_TO, DATA, frame_index, load_gt, point_in_polygon
    gt, out = load_gt(), []
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        for n, _ in frame_index(DATA / "Dataset/cafe/17" / str(clip)):
            row = {t["id"]: [0, 0] for t in tables_px}
            for x1, y1, x2, y2, _g, act in gt.get((clip, n), []):
                if x1 < 0 or (act not in SIT_ACTS and act != OUTLIER_ACT):
                    continue
                pt = ((x1 + x2) / 2 * scale, (y1 + (y2 - y1) * foot_frac) * scale)
                for t in tables_px:
                    if point_in_polygon(pt, t["polygon"]):
                        row[t["id"]][0 if act in SIT_ACTS else 1] += 1
                        break
            out.append(row)
    return out


def table_scores(frames_occ, frames_seat_raw, truth, tids):
    """frames_occ: 프레임별 예측 occupiedTables, frames_seat_raw: 프레임별 {tid: 예측 앉은 수}.
    포함 = outlier 도 앉은 사람으로 셈, 제외 = outlier 는 정답에서 빼고, 점유 비교에서는 outlier만 있는 칸(애매)을 뺌."""
    res = {}
    for mode in ("include", "exclude"):
        ok = tot = 0
        per = {t: [0, 0] for t in tids}
        for occ, row in zip(frames_occ, truth):
            for t in tids:
                sure, out_n = row[t]
                if mode == "exclude" and sure == 0 and out_n > 0:
                    continue
                gt_occ = (sure + (out_n if mode == "include" else 0)) > 0
                hit = (t in occ) == gt_occ
                ok += hit
                tot += 1
                per[t][0] += hit
                per[t][1] += 1
        res[mode] = {"occupancyAccuracy": round(ok / tot, 3), "cells": tot,
                     "perTable": {t: round(a / b, 3) if b else None for t, (a, b) in per.items()}}
    return res


def seated_gt_counts(truth, mode):
    return [sum(s + (o if mode == "include" else 0) for s, o in row.values()) for row in truth]


def evaluate(raw_in, raw_seat, sm_in, sm_seat, fps, gt_in, gt_seat):
    """raw/smoothed: 최상위 mae·relative 는 inStore(손님 수) 기준, inStore·seated 하위에 각각."""
    i, s = score(raw_in, gt_in), score(raw_seat, gt_seat)
    si, ss = score(sm_in, gt_in), score(sm_seat, gt_seat)
    ev = {"raw": {**i, "inStore": i, "seated": s}, "smoothed": {**si, "inStore": si, "seated": ss}}
    ev["changesPerMinute"] = {"raw": round(changes_per_minute(raw_in, fps), 1),
                              "smoothed": round(changes_per_minute(sm_in, fps), 1),
                              "seated": {"raw": round(changes_per_minute(raw_seat, fps), 1),
                                         "smoothed": round(changes_per_minute(sm_seat, fps), 1)}}
    return ev

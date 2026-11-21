"""T-046b: 정답(앉은 사람 상자 아래쪽 점)으로 테이블 구역을 다시 만들고 앉음 판정 값을 고른다.
실행: .venv/bin/python tune_tables.py [--write]   (--write 면 zones/cafe17_tables.json 갱신)"""
import json
import sys
from pathlib import Path

import numpy as np

import smooth
from common import CLIP_FROM, CLIP_TO, DATA, SEATED, frame_index, load_gt
from make_zones import cluster, hull, trim

HERE = Path(__file__).parent
W, H = 1920, 1080
GS = 1.5  # 정답 좌표는 1280x720 기준 -> 1920x1080 으로 키움
FY = 0.8  # 상자 위에서 80% 지점(아래 20%)의 y, x는 가운데


def gt_frames():
    gt, out = load_gt(), []
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        for n, _ in frame_index(DATA / "Dataset/cafe/17" / str(clip)):
            out.append(gt.get((clip, n), []))
    return out


def foot(b, fy=FY):
    return ((b[0] + b[2]) / 2 / (1 if b[2] <= 1.5 else W) , 0)  # unused helper placeholder


def build(gtf, pad, link=150, minpts=40, fyb=0.8):
    pts = []
    for boxes in gtf:
        for x1, y1, x2, y2, _g, act in boxes:
            if act in SEATED and x1 >= 0:
                pts.append(((x1 + x2) / 2 * GS, (y1 + (y2 - y1) * fyb) * GS))
    grid = {(int(x // 20), int(y // 20)): (x, y) for x, y in pts}
    cl = [c for c in cluster(list(grid.values()), link) if len(c) >= minpts]
    cl.sort(key=lambda c: np.mean([p[0] for p in c]))
    return [hull(trim(c, 3), pad) for c in cl], len(pts)


def pip(pt, poly):
    import cv2
    return cv2.pointPolygonTest(np.array(poly, np.float32).reshape(-1, 1, 2), (float(pt[0]), float(pt[1])), False) >= 0


def seated_counts(kept, polys, fy, maxh, scale=1.0):
    out = []
    for pers in kept:
        n = 0
        for p in pers:
            x1, y1, x2, y2 = p[0] * W, p[1] * H, p[2] * W, p[3] * H
            if (y2 - y1) > maxh:
                continue
            if any(pip(((x1 + x2) / 2, y1 + (y2 - y1) * fy), poly) for poly in polys):
                n += 1
        out.append(n)
    return out


# T-046c: 장면(1280x720 화면)에서 눈으로 그린 실제 테이블·자리 구역. 점은 '앉은 사람 상자 위에서 80% 지점'이 들어갈 곳.
HAND_TABLES = [
    ("창가 부스 왼쪽 자리", [(195, 240), (335, 232), (340, 372), (205, 380)]),
    ("부스 안쪽 자리", [(335, 228), (490, 232), (492, 345), (338, 350)]),
    ("긴 테이블 안쪽 자리", [(745, 285), (870, 262), (892, 332), (882, 440), (790, 452), (745, 400)]),
    ("긴 테이블 앞쪽 자리", [(790, 458), (950, 432), (966, 560), (930, 628), (800, 622)]),
]


def write_hand_zones(maxh=350, foot=0.8):
    cfg = {"note": "T-046c: 장면에 보이는 실제 테이블·자리를 눈으로 그린 구역(좌표는 1280x720 화면 x1.5 = 1920x1080). 앉음 = 상자 위에서 footFrac 지점이 구역 안 + 상자 높이 <= maxBoxH. 정답 앉은 사람도 같은 점·같은 구역으로 판정(smooth.seated_truth).",
           "image_size": [W, H], "footFrac": foot,
           "tables": [{"id": "t%d" % (i + 1), "name": n, "maxBoxH": maxh,
                       "polygon": [[round(x * GS), round(y * GS)] for x, y in poly]} for i, (n, poly) in enumerate(HAND_TABLES)]}
    (HERE / "zones" / "cafe17_tables.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=1))
    return cfg


def write_zones(pad=80, link=150, minpts=80, fyb=0.5, foot=0.8, maxh=350):
    gtf = gt_frames()
    polys, _ = build(gtf, pad, link, minpts, fyb)
    names = ["창가 테이블 구역", "가운데 테이블 구역", "안쪽 테이블 구역", "앞쪽 테이블 구역"]
    cfg = {"note": "정답(Eating/Drinking·Working/Studying) 사람 상자 아래쪽 점(위에서 %d%% 지점, 정답 좌표 x1.5)을 묶어 만든 구역(T-046b, tune_tables.py). 앉음 = 상자 위에서 footFrac 지점이 구역 안 + 상자 높이 <= maxBoxH(서 있는 사람 제외). 장면을 보고 이름을 붙임." % round(fyb * 100),
           "image_size": [W, H], "footFrac": foot,
           "tables": [{"id": "t%d" % (i + 1), "name": names[i], "maxBoxH": maxh, "polygon": p} for i, p in enumerate(polys)]}
    (HERE / "zones" / "cafe17_tables.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=1))
    return cfg


def main():
    if "--write-hand" in sys.argv:
        print(json.dumps(write_hand_zones(), ensure_ascii=False)[:200])
        return
    if "--write" in sys.argv:
        print(json.dumps(write_zones(), ensure_ascii=False))
        return
    raw = json.loads((HERE / "results" / "cafe17_raw_persons.json").read_text())
    kept = smooth.confirm_tracks(raw, smooth.MIN_TRACK_FRAMES)
    _, gt_seat = smooth.ground_truth()
    gtf = gt_frames()
    best = None
    for pad, link, minpts, bfy in [(p, l, m, b) for p in (0, 20, 40, 80) for l in (60, 100, 150) for m in (20, 40, 80) for b in (0.8, 1.0)]:
        polys, npts = build(gtf, pad, link, minpts, bfy)
        if 1:
            for fy, maxh in [(f, h) for f in (0.7, 0.8, 0.9, 1.0) for h in (250, 300, 350, 420, 1e9)]:
                c = seated_counts(kept, polys, fy, maxh)
                sc = smooth.score([int(round(v)) for v in smooth.kalman(c)], gt_seat)
                rs = smooth.score(c, gt_seat)
                if best is None or sc["relative"] < best[0]:
                    best = (sc["relative"], pad, link, minpts, bfy, fy, maxh, sc, rs, len(polys))
    print("BEST", best)
    return best, gtf


if __name__ == "__main__":
    main()

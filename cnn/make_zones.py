"""정답 라벨로 구역 다각형을 만든다(실험 편의). 결과: zones/cafe17.json
줄·주문 구역 = Queueing/Ordering 사람 상자 중심점의 볼록 껍질(바깥 5% 제외, 약간 키움).
테이블 구역 = 앉은 사람(Eating/Working) 상자 중심점을 가까운 것끼리 묶어 각 묶음의 볼록 껍질(약간 키움)."""
import json
from pathlib import Path

import cv2
import numpy as np

from common import QUEUE, SEATED, box_center, load_gt

PAD = 80  # 껍질을 바깥으로 키우는 픽셀
LINK = 200  # 이 거리(px) 이내 중심점은 같은 테이블로 묶음


def hull(points, pad=PAD):
    pts = np.array(points, dtype=np.float32)
    h = cv2.convexHull(pts).reshape(-1, 2)
    c = h.mean(axis=0)
    d = h - c
    n = np.linalg.norm(d, axis=1, keepdims=True) + 1e-6
    return (h + d / n * pad).round().astype(int).tolist()


def trim(points, q=5):
    p = np.array(points)
    lo, hi = np.percentile(p, q, axis=0), np.percentile(p, 100 - q, axis=0)
    return p[((p >= lo) & (p <= hi)).all(axis=1)]


def cluster(points, link=LINK):
    p = np.array(points)
    parent = list(range(len(p)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(p)):
        for j in range(i + 1, len(p)):
            if np.linalg.norm(p[i] - p[j]) < link:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(len(p)):
        groups.setdefault(find(i), []).append(p[i])
    return list(groups.values())


def main():
    gt = load_gt()
    q_pts, s_pts = [], []
    for boxes in gt.values():
        for x1, y1, x2, y2, _g, act in boxes:
            c = ((x1 + x2) / 2, y2)  # 정답 상자 아래쪽 중앙(정답 상자가 탐지 상자보다 위쪽·작아서, 아래 중앙이 탐지 상자 중심과 비슷함)
            if act in QUEUE:
                q_pts.append(c)
            elif act in SEATED:
                s_pts.append(c)
    zones = {"queue": {"id": "queue", "polygon": hull(trim(q_pts))}, "tables": []}
    # 앉은 자리: 점이 너무 많으니 20px 격자로 줄여서 묶음
    grid = {(int(x // 20), int(y // 20)): (x, y) for x, y in s_pts}
    clusters = [c for c in cluster(list(grid.values())) if len(c) >= 15]
    clusters.sort(key=lambda c: (np.mean([p[0] for p in c])))
    for i, c in enumerate(clusters, 1):
        zones["tables"].append({"id": f"table{i}", "polygon": hull(trim(c, 3))})
    out = Path(__file__).parent / "zones" / "cafe17.json"
    out.parent.mkdir(exist_ok=True)
    zones["note"] = "정답 라벨(gt_tracks)로 만든 실험용 구역. 실제 매장에서는 사장님이 한 번 그림."
    zones["image_size"] = [1920, 1080]
    out.write_text(json.dumps(zones, ensure_ascii=False, indent=1))
    print("queue pts", len(q_pts), "seated pts", len(s_pts), "tables", len(zones["tables"]))
    for t in zones["tables"]:
        a = np.array(t["polygon"])
        print(t["id"], a.min(0), a.max(0))
    a = np.array(zones["queue"]["polygon"])
    print("queue", a.min(0), a.max(0))


if __name__ == "__main__":
    main()

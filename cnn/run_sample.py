"""Café 17번 영상 클립 354~403(약 5분)에서 YOLO11s + ByteTrack 으로 손님 수·줄·자리 숫자를 뽑고 정답과 비교.
실행: .venv/bin/python run_sample.py   (결과: results/cafe17_354-403.json, 숫자만)"""
import json
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from ultralytics import YOLO

from common import CLIP_FROM, CLIP_TO, DATA, FRAME_SEC, VIDEO, box_center, frame_index, load_gt, point_in_polygon
from evaluate import errors, gt_counts

HERE = Path(__file__).parent
MODEL = Path.home() / "Datasets/cafe-sample/models/yolo11s.pt"  # 저장소 밖
COCO = {"person": 0, "cup": 41, "chair": 56, "dining table": 60}
IMGSZ = 1280
SEAT_MAX_H = 400  # px(1080p). 이보다 큰 상자는 앞쪽에 선 사람으로 보고 테이블 구역에서 뺀다
CLIPS_PER_MIN = 10  # 클립 6초 -> 1분 = 10클립


def pick_device():
    return "mps" if torch.backends.mps.is_available() else "cpu"


def in_any(pt, zones):
    return any(point_in_polygon(pt, z["polygon"]) for z in zones)


def count_frame(res, zones):
    """한 프레임 탐지 결과 -> 숫자 (사람 수, 줄 인원, 테이블별 앉은 인원, 테이블별 컵 수, 추적 번호)"""
    persons, cups = [], []
    for b, cls, tid in zip(res.boxes.xyxy.tolist(), res.boxes.cls.tolist(),
                           (res.boxes.id.tolist() if res.boxes.id is not None else [None] * len(res.boxes))):
        if int(cls) == COCO["person"]:
            persons.append((box_center(b), tid, b[3] - b[1]))
        elif int(cls) == COCO["cup"]:
            cups.append(box_center(b))
    tables = zones["tables"]
    seated = {t["id"]: 0 for t in tables}
    cup_n = {t["id"]: 0 for t in tables}
    queue = 0
    for c, _, h in persons:
        # 앉은 손님은 안쪽(카메라에서 멀어 상자가 작음), 줄 선 손님은 앞쪽(상자가 큼): 상자 높이로 구분
        at = [t for t in tables if h <= SEAT_MAX_H and point_in_polygon(c, t["polygon"])]
        if at:
            seated[at[0]["id"]] += 1
        elif point_in_polygon(c, zones["queue"]["polygon"]):
            queue += 1
    for c in cups:
        for t in tables:
            if point_in_polygon(c, t["polygon"]):
                cup_n[t["id"]] += 1
    return len(persons), queue, seated, cup_n, [tid for _, tid, _ in persons if tid is not None]


def main():
    zones = json.loads((HERE / "zones" / "cafe17.json").read_text())
    tids = [t["id"] for t in zones["tables"]]
    gt = load_gt()
    device = pick_device()
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(MODEL))  # 없으면 내려받음
    classes = list(COCO.values())
    kw = dict(persist=True, tracker="bytetrack.yaml", classes=classes, conf=0.25, imgsz=IMGSZ,
              device=device, verbose=False)
    first = frame_index(DATA / "Dataset/cafe/17" / str(CLIP_FROM))[0][1]
    model.track(cv2.imread(str(first)), **kw)  # 예열
    model.predictor.trackers[0].reset()

    clips, ms_list = [], []
    pred = {k: [] for k in ("persons", "queue", "seated")}
    truth = {k: [] for k in ("persons", "queue", "seated", "seated_groups")}
    all_tracks = set()
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        rows = []
        for n, path in frame_index(DATA / "Dataset/cafe/17" / str(clip)):
            img = cv2.imread(str(path))
            t0 = time.perf_counter()
            res = model.track(img, **kw)[0]
            ms_list.append((time.perf_counter() - t0) * 1000)
            persons, queue, seated, cup_n, ids = count_frame(res, zones)
            all_tracks.update(ids)
            g = gt_counts(gt.get((clip, n), []))
            rows.append({"persons": persons, "queue": queue, "seated_by_table": seated,
                         "cups_by_table": cup_n, "tracks": set(ids)})
            pred["persons"].append(persons)
            pred["queue"].append(queue)
            pred["seated"].append(sum(seated.values()))
            for k in truth:
                truth[k].append(g[k])
        clips.append((clip, rows))
        print("clip", clip, "frames", len(rows), flush=True)

    # --- 집계(숫자만) ---
    def clip_summary(clip, rows):
        s = [sum(r["seated_by_table"].values()) for r in rows]
        return {"clip": clip, "frames": len(rows),
                "persons_mean": round(float(np.mean([r["persons"] for r in rows])), 2),
                "persons_max": max(r["persons"] for r in rows),
                "queue_mean": round(float(np.mean([r["queue"] for r in rows])), 2),
                "queue_max": max(r["queue"] for r in rows),
                "seated_mean": round(float(np.mean(s)), 2), "seated_max": max(s)}

    minutes = []
    for m in range(0, (CLIP_TO - CLIP_FROM + 1) // CLIPS_PER_MIN):
        rows = [r for c, rs in clips if (c - CLIP_FROM) // CLIPS_PER_MIN == m for r in rs]
        tracks = set().union(*[r["tracks"] for r in rows])
        per_table, cleanup = {}, []
        for t in tids:
            occ = sum(1 for r in rows if r["seated_by_table"][t] > 0)
            empty_cup = sum(1 for r in rows if r["seated_by_table"][t] == 0 and r["cups_by_table"][t] > 0)
            per_table[t] = {"occupied_sec": round(occ * FRAME_SEC, 1),
                            "occupied_ratio": round(occ / len(rows), 2),
                            "seated_mean": round(float(np.mean([r["seated_by_table"][t] for r in rows])), 2),
                            "seated_max": max(r["seated_by_table"][t] for r in rows),
                            "empty_with_cup_ratio": round(empty_cup / len(rows), 2)}
            if empty_cup / len(rows) >= 0.5:
                cleanup.append(t)
        seated = [sum(r["seated_by_table"].values()) for r in rows]
        minutes.append({
            "minute": m + 1, "frames": len(rows),
            "customer": {"persons_mean": round(float(np.mean([r["persons"] for r in rows])), 2),
                         "persons_max": max(r["persons"] for r in rows), "unique_tracks": len(tracks)},
            "queue_minutely": {"mean": round(float(np.mean([r["queue"] for r in rows])), 2),
                               "max": max(r["queue"] for r in rows)},
            "table_occupancy": {"seated_mean": round(float(np.mean(seated)), 2), "seated_max": max(seated),
                                "tables": per_table, "cleanup_candidates": cleanup}})
    seat_sec = {t: round(sum(m["table_occupancy"]["tables"][t]["occupied_sec"] for m in minutes), 1) for t in tids}

    ev = {"customers": errors(pred["persons"], truth["persons"]),
          "queue": errors(pred["queue"], truth["queue"]),
          "seated_vs_people": errors(pred["seated"], truth["seated"]),
          "seated_vs_groups": errors(pred["seated"], truth["seated_groups"])}
    ms = np.array(ms_list)
    out = {
        "source": "Café(Kim et al., ECCV 2024) video 17 clips %d-%d" % (CLIP_FROM, CLIP_TO),
        "model": "yolo11s.pt (COCO pretrained, ByteTrack)", "imgsz": IMGSZ, "conf": 0.25,
        "frame_seconds": round(FRAME_SEC, 3), "frames": len(ms_list), "clips": CLIP_TO - CLIP_FROM + 1,
        "total_unique_tracks": len(all_tracks),
        "total_gt_unique_people_note": "정답 추적 번호는 클립마다 새로 매겨져 5분 합산 불가",
        "speed": {"device": device, "ms_per_frame_mean": round(float(ms.mean()), 1),
                  "ms_per_frame_median": round(float(np.median(ms)), 1), "ms_per_frame_p95": round(float(np.percentile(ms, 95)), 1)},
        "per_minute": minutes,
        "per_clip": [clip_summary(c, r) for c, r in clips],
        "table_occupied_sec_total": seat_sec,
        "evaluation": ev,
    }
    dst = HERE / "results" / "cafe17_354-403.json"
    dst.parent.mkdir(exist_ok=True)
    dst.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(json.dumps({"speed": out["speed"], "evaluation": ev, "tracks": out["total_unique_tracks"]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()

"""T-065b ③: YOLO11-pose 로 1,718장 전체의 사람 관절(17점)을 한 번 뽑아 저장소 밖에 캐시.
실행(cnn 에서, Mac mps 약 1~2분): python3 occupancy/extract_pose.py [--model yolo11s-pose] [--imgsz 1280]
결과: ~/Datasets/cafe-sample/t065b/pose_<model>_<imgsz>.json  (프레임별 [[x1,y1,x2,y2,conf, kx,ky,kc *17]], [0..1] 좌표)
모델 가중치는 ~/Datasets/cafe-sample/models/ 에 내려받는다(저장소에 넣지 않음)."""
import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import cv2  # noqa: E402
import torch  # noqa: E402
from ultralytics import YOLO  # noqa: E402

from common import CLIP_FROM, CLIP_TO, DATA, frame_index  # noqa: E402

MODELS = Path(os.path.expanduser("~/Datasets/cafe-sample/models"))
OUT = Path(os.path.expanduser("~/Datasets/cafe-sample/t065b"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo11s-pose")
    ap.add_argument("--imgsz", type=int, default=1280)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    w = MODELS / f"{a.model}.pt"
    if not w.exists():
        cwd = os.getcwd()
        os.chdir(MODELS)  # ultralytics 는 현재 폴더로 내려받는다
        YOLO(f"{a.model}.pt")
        os.chdir(cwd)
    model = YOLO(str(w))
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    paths = []
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        paths += [p for _, p in frame_index(DATA / "Dataset/cafe/17" / str(clip))]
    frames, t0, ms = [], time.time(), []
    for i, p in enumerate(paths):
        img = cv2.imread(str(p))
        h, w_ = img.shape[:2]
        t1 = time.time()
        r = model.predict(img, imgsz=a.imgsz, conf=0.25, device=dev, verbose=False)[0]
        ms.append((time.time() - t1) * 1000)
        rows = []
        if r.keypoints is not None:
            for b, c, kp in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist(), r.keypoints.data.tolist()):
                row = [round(b[0] / w_, 4), round(b[1] / h, 4), round(b[2] / w_, 4), round(b[3] / h, 4), round(c, 3)]
                for x, y, kc in kp:
                    row += [round(x / w_, 4), round(y / h, 4), round(kc, 2)]
                rows.append(row)
        frames.append(rows)
        if i % 300 == 0:
            print(i, len(paths), flush=True)
    path = OUT / f"pose_{a.model}_{a.imgsz}.json"
    path.write_text(json.dumps({"model": a.model, "imgsz": a.imgsz, "device": dev,
                                "msPerFrame_mean": round(sum(ms) / len(ms), 1), "frames": frames}, separators=(",", ":")))
    print("saved", path, "ms/frame", round(sum(ms) / len(ms), 1), "total s", round(time.time() - t0, 1))


if __name__ == "__main__":
    main()

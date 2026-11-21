"""T-046d: 컵·그릇·병·의자·테이블 탐지를 클래스 번호와 함께 한 번 저장(사람 추적은 그대로).
실행: .venv/bin/python detect_objects.py   (결과: results/cafe17_raw_objects.json, 프레임별 [x1,y1,x2,y2,cls,conf] 0..1)"""
import json
from pathlib import Path

import cv2
import torch
from ultralytics import YOLO

from common import CLIP_FROM, CLIP_TO, DATA, frame_index
from run_sample import IMGSZ, MODEL

OBJ = {39: "bottle", 40: "wine glass", 41: "cup", 45: "bowl", 56: "chair", 60: "dining table"}
OUT = Path(__file__).parent / "results" / "cafe17_raw_objects.json"
SX, SY = 1920, 1080

if __name__ == "__main__":
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = YOLO(str(MODEL))
    paths = []
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        paths += [p for _, p in frame_index(DATA / "Dataset/cafe/17" / str(clip))]
    rows = []
    for i, p in enumerate(paths):
        r = model.predict(cv2.imread(str(p)), classes=list(OBJ), conf=0.25, imgsz=IMGSZ, device=device, verbose=False)[0]
        rows.append([[round(b[0] / SX, 3), round(b[1] / SY, 3), round(b[2] / SX, 3), round(b[3] / SY, 3), int(c), round(float(s), 2)]
                     for b, c, s in zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist())])
        if i % 200 == 0:
            print(i, len(paths), flush=True)
    OUT.write_text(json.dumps(rows, separators=(",", ":")))
    print("done", len(rows))

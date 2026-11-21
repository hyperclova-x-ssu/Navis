"""T-046d 확인 그림: python vis_tables.py <frame_index> <out.jpg>  (구역·사람·컵류 탐지 그리기)"""
import json, sys
from pathlib import Path
import cv2, numpy as np
from common import CLIP_FROM, CLIP_TO, DATA, frame_index
H = Path(__file__).parent
CLS = {39: "bottle", 40: "glass", 41: "cup", 45: "bowl", 56: "chair", 60: "table"}

def draw(i, out, show_obj=True, events=None):
    paths = []
    for c in range(CLIP_FROM, CLIP_TO + 1):
        paths += [p for _, p in frame_index(DATA / "Dataset/cafe/17" / str(c))]
    im = cv2.imread(str(paths[i]))
    cfg = json.loads((H / "zones/cafe17_tables.json").read_text())
    d = json.loads((H.parent / "frontend/public/cnn/cafe17-detections.json").read_text())
    c = d["frames"][i]["counts"]
    for t in cfg["tables"]:
        col = (0, 0, 255) if t["id"] in c["tablesToClear"] else ((0, 200, 0) if t["id"] in c["occupiedTables"] else (255, 160, 0))
        cv2.polylines(im, [np.array(t["polygon"])], True, col, 4)
        cv2.putText(im, t["id"], tuple(t["polygon"][0]), 0, 1.5, col, 4)
    for s in cfg.get("supply", []):
        cv2.polylines(im, [np.array(s["polygon"])], True, (200, 0, 200), 3)
        cv2.putText(im, "supply", tuple(s["polygon"][0]), 0, 1.2, (200, 0, 200), 3)
    for p in d["frames"][i]["persons"]:
        cv2.rectangle(im, (int(p[0]*1920), int(p[1]*1080)), (int(p[2]*1920), int(p[3]*1080)), (255, 255, 255), 2)
    for b in d["frames"][i]["cups"]:
        cv2.rectangle(im, (int(b[0]*1920), int(b[1]*1080)), (int(b[2]*1920), int(b[3]*1080)), (0, 255, 255), 3)
    cv2.putText(im, f"t={i/5:.1f}s counts={c}", (20, 50), 0, 1.2, (0, 255, 255), 3)
    cv2.imwrite(out, cv2.resize(im, (1440, 810)))

if __name__ == "__main__":
    draw(int(sys.argv[1]), sys.argv[2])

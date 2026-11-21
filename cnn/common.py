"""공통 도우미: 데이터 경로, 구역 판정, 정답 읽기. (목업 실험용)"""
import os
from pathlib import Path

import cv2
import numpy as np

DATA = Path(os.path.expanduser("~/Datasets/cafe-sample/Cafe_Dataset"))
VIDEO, CLIP_FROM, CLIP_TO = 17, 354, 403
FRAME_SEC = 6 / 29.94  # frames_N 은 원본 29.94fps의 N번째 프레임, 6장 간격 = 약 0.2초
SEATED = {3, 4}  # Eating/Drinking, Working/Studying
QUEUE = {1, 2}  # Queueing, Ordering


def point_in_polygon(pt, poly):
    """pt=(x,y), poly=[[x,y],...] -> 안(경계 포함)이면 True"""
    contour = np.array(poly, dtype=np.float32).reshape(-1, 1, 2)
    return cv2.pointPolygonTest(contour, (float(pt[0]), float(pt[1])), False) >= 0


def box_center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def frame_index(clip_dir: Path):
    """frames_N.jpg 를 N 숫자 순서(시간 순)로 정렬해 [(N, path)] 반환"""
    items = []
    for p in (clip_dir / "images").glob("frames_*.jpg"):
        items.append((int(p.stem.split("_")[1]), p))
    return sorted(items)


def load_gt():
    """gt_tracks.txt -> {(clip, frame_N): [(x1,y1,x2,y2,group,action), ...]}"""
    gt = {}
    for line in (DATA / "evaluation" / "gt_tracks.txt").read_text().splitlines():
        v = line.split()
        if len(v) < 9 or int(v[0]) != VIDEO:
            continue
        clip = int(v[1])
        if not CLIP_FROM <= clip <= CLIP_TO:
            continue
        gt.setdefault((clip, int(v[2])), []).append(
            (*map(float, v[3:7]), int(v[7]), int(v[8]))
        )
    return gt

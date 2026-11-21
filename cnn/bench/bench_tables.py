"""측정 3: 테이블 추천 영역 후보를 실제 테이블 4개(zones/cafe17_tables.json, 사람이 그린 '윗면+앉는 자리' 다각형)와 비교.
 A. yolo11s-seg 의 dining table 마스크 (한 장 / 여러 장 투표)
 B. yolo11s(탐지, 이미 돌고 있는 모델) 의 dining table 상자 (여러 장 투표) - 추가 GPU 비용 0
 C. 앉은 사람 흔적: 탐지된 사람 중 상자 높이<=350(1080 기준)인 상자의 아래 절반을 영상 전체에 누적
입력: cafe17.mp4 960x540 (A·B 는 균등 간격 60장, C 는 1,718장 전체). 시간은 A 의 한 장 처리(predict 1회, FP16).
비교: 실제 테이블마다 가장 잘 겹치는 후보의 IoU, 실제 테이블 '찾음' = IoU>=0.25 또는 후보 넓이의 60% 이상이 그 테이블 안.
결과: results/tables.json.  실행(gpu-server): venv/bin/python cnn/bench/bench_tables.py"""
import argparse
import json
import os

import cv2
import numpy as np
from ultralytics import YOLO

import benchlib as B

W, H = 960, 540
SAMPLE = 60
VOTE = 0.3  # 여러 장 투표: 이 비율 이상 장에서 나온 픽셀만 남김
MIN_AREA = 0.002 * W * H


def poly_mask(poly):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.round(np.asarray(poly)).astype(np.int32)], 1)
    return m.astype(bool)


def components(mask):
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    return [lab == i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= MIN_AREA]


def match(cands, gts):
    """cands: [bool mask], gts: {id: bool mask} -> 테이블별 최고 IoU, 찾음 여부, 실제 테이블과 안 겹치는 후보 수"""
    per, used = {}, set()
    for tid, g in gts.items():
        best = {"iou": 0.0, "insideFrac": 0.0}
        for j, c in enumerate(cands):
            inter = np.logical_and(c, g).sum()
            iou = inter / max(1, np.logical_or(c, g).sum())
            inside = inter / max(1, c.sum())
            if iou > best["iou"] or (iou == best["iou"] and inside > best["insideFrac"]):
                best = {"iou": round(float(iou), 3), "insideFrac": round(float(inside), 3), "cand": j}
        best["found"] = bool(best["iou"] >= 0.25 or best["insideFrac"] >= 0.6)
        if best["found"]:
            used.add(best["cand"])
        per[tid] = best
    allg = np.any(list(gts.values()), axis=0)
    false_c = sum(1 for c in cands if np.logical_and(c, allg).sum() / max(1, c.sum()) < 0.2)
    return {"candidates": len(cands), "found": sum(p["found"] for p in per.values()), "of": len(gts),
            "meanBestIoU": round(float(np.mean([p["iou"] for p in per.values()])), 3),
            "falseCandidates": false_c, "perTable": per}


def seg_masks(r):
    if r.masks is None:
        return []
    return [poly_mask(xy) for xy, c in zip(r.masks.xy, r.boxes.cls.tolist()) if int(c) == B.TABLE and len(xy) >= 3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="0", help="0 = GPU, cpu = 매장 PC 흉내(run_cpu.sh 와 같은 조건으로 실행)")
    ap.add_argument("--sample", type=int, default=SAMPLE)
    a = ap.parse_args()
    dev = 0 if a.device == "0" else "cpu"
    if dev == "cpu":
        import torch
        torch.set_num_threads(int(os.environ.get("NAVIS_THREADS", "4")))
    frames = B.video_frames()
    idx = np.linspace(0, len(frames) - 1, a.sample).astype(int)
    tables, _ = B.load_tables(W, H)
    gts = {t["id"]: poly_mask(t["px"]) for t in tables}
    out = {"input": f"cafe17.mp4 {W}x{H}", "sampleFrames": a.sample, "device": a.device, "vote": VOTE, "segModel": "yolo11s-seg.pt (COCO)",
           "gtNote": "실제 테이블 다각형은 '테이블 윗면 + 앉는 자리'라 테이블 윗면만 덮는 마스크는 IoU 가 낮게 나온다. insideFrac 도 같이 본다.",
           "A_seg": [], }
    seg = YOLO(str(B.MODELS / "yolo11s-seg.pt"))
    for size in (640, 960, 1280):
        kw = dict(imgsz=size, half=dev == 0, classes=[B.TABLE], conf=0.25, device=dev, verbose=False, retina_masks=False)
        for i in range(10):
            seg.predict(frames[i], **kw)
        if dev == 0:
            B.gpu_mem_reset()
        ms, single, acc = [], [], np.zeros((H, W), np.float32)
        for i in idx:
            B.sync()
            t0 = B.now_ms()
            r = seg.predict(frames[i], **kw)[0]
            B.sync()
            ms.append(B.now_ms() - t0)
            ms_ = seg_masks(r)
            single.append(match(ms_, gts))
            if ms_:
                acc += np.any(ms_, axis=0)
        voted = components(acc / len(idx) >= VOTE)
        out["A_seg"].append({"imgsz": size, "precision": "fp16" if dev == 0 else "fp32", "time": B.stats(ms), "gpuMem": B.gpu_mem() if dev == 0 else None,
                             "singleFrame": {"meanFound": round(float(np.mean([s["found"] for s in single])), 2),
                                             "meanCandidates": round(float(np.mean([s["candidates"] for s in single])), 2),
                                             "meanBestIoU": round(float(np.mean([s["meanBestIoU"] for s in single])), 3)},
                             "voted": match(voted, gts)})
        print(json.dumps(out["A_seg"][-1]["time"]), out["A_seg"][-1]["voted"]["found"], flush=True)
    del seg
    if dev == "cpu":  # CPU 조건에서는 A 의 시간만 잰다(B·C 는 탐지 모델 결과를 쓰므로 추가 시간 없음)
        return B.save("tables_cpu.json", out)

    det = YOLO(str(B.MODELS / "yolo11s.pt"))
    kw = dict(imgsz=960, half=True, classes=[B.PERSON, B.TABLE], conf=0.25, device=dev, verbose=False)
    acc_b, acc_c = np.zeros((H, W), np.float32), np.zeros((H, W), np.float32)
    sample = set(idx.tolist())
    for i, f in enumerate(frames):
        r = det.predict(f, **kw)[0]
        boxes = r.boxes.xyxy.cpu().numpy()
        cls = r.boxes.cls.cpu().numpy().astype(int)
        if i in sample:
            m = np.zeros((H, W), bool)
            for b, c in zip(boxes, cls):
                if c == B.TABLE:
                    x1, y1, x2, y2 = np.round(b).astype(int)
                    m[y1:y2, x1:x2] = True
            acc_b += m
        m = np.zeros((H, W), bool)
        for b, c in zip(boxes, cls):
            if c == B.PERSON and (b[3] - b[1]) / H * 1080 <= 350:
                x1, y1, x2, y2 = np.round(b).astype(int)
                m[(y1 + y2) // 2:y2, x1:x2] = True
        acc_c += m
    out["B_detBoxes"] = {"imgsz": 960, "note": "탐지 모델이 이미 내는 상자라 추가 시간 없음", "voted": match(components(acc_b / len(idx) >= VOTE), gts)}
    best_c = None
    for thr in (0.05, 0.1, 0.2):
        res = match(components(acc_c / len(frames) >= thr), gts)
        res["threshold"] = thr
        if best_c is None or (res["found"], res["meanBestIoU"]) > (best_c["found"], best_c["meanBestIoU"]):
            best_c = res
    out["C_seatedTrace"] = {"frames": len(frames), "note": "영상을 오래 볼수록 정확(손님이 앉아야 생김). 임계값 3개 중 가장 좋은 것", "voted": best_c}
    B.save("tables.json", out)


if __name__ == "__main__":
    main()

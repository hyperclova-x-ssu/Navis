"""GPU 없는 매장 PC(CPU 4코어, RAM 8GB) 흉내 측정(D-373). run_cpu.sh 가 설정 하나마다 이 스크립트를 새 프로세스로
CUDA_VISIBLE_DEVICES="" + taskset 4코어 + 스레드 4 + MemoryMax=8G 로 돌리고, 한 줄씩 results/cpu_rows.jsonl 에 붙인다.

 --mode latency : 1280x720 사진 1장 탐지 시간(predict 1회, 전처리+추론+NMS)
 --mode pipeline: cafe17.mp4 1,718장 전체 = JPEG 디코딩 + 탐지·ByteTrack(N장마다) + 확인 추적·앉음·칼만 + 컵 구역.
                  정답(data/gt_cafe17.json) 대비 손님 수·앉은 인원 오차와, N장마다 탐지할 때 사이 장 상자 예측(등속) 정확도.
실행 예: bash run_cpu.sh  (직접: python bench_cpu.py --mode latency --model yolo11n --runtime openvino --size 416)"""
import argparse
import json
import os
import resource
import shutil
import time

THREADS = int(os.environ.get("NAVIS_THREADS", "4"))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

torch.set_num_threads(THREADS)
cv2.setNumThreads(THREADS)

# ultralytics 는 ONNX Runtime·OpenVINO 의 스레드 수를 정하지 않아 기본값(모든 코어)을 쓴다 -> 4로 고정
try:
    import onnxruntime as ort
    _Sess = ort.InferenceSession

    def _sess(path, *a, **k):
        so = k.pop("sess_options", None) or ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = THREADS, 1
        return _Sess(path, *a, sess_options=so, **k)
    ort.InferenceSession = _sess
except ImportError:
    pass
try:
    import openvino as ov
    _compile = ov.Core.compile_model

    def _cm(self, model, device_name=None, config=None, **k):
        config = dict(config or {})
        config["INFERENCE_NUM_THREADS"] = THREADS
        return _compile(self, model, device_name, config, **k)
    ov.Core.compile_model = _cm
except ImportError:
    pass

from ultralytics import YOLO  # noqa: E402

import benchlib as B  # noqa: E402
import smooth  # noqa: E402
from common import box_center, point_in_polygon  # noqa: E402

RECT = {320: (192, 320), 416: (256, 416), 512: (288, 512), 640: (384, 640), 960: (544, 960), 1280: (736, 1280)}
GT = B.DATA / "gt_cafe17.json"


def model_file(name, runtime, size):
    pt = B.MODELS / f"{name}.pt"
    if runtime == "pt":
        return pt
    h, w = RECT[size]
    if runtime == "ov_int8":  # make_int8.py 가 만든 INT8 모델(후보 C)
        out = B.MODELS / f"{name}_{h}x{w}_int8_openvino_model"
        if not out.exists():
            raise FileNotFoundError(f"{out.name} 없음: make_int8.py 를 먼저 돌리세요")
        return out
    out = B.MODELS / (f"{name}_{h}x{w}.onnx" if runtime == "onnx" else f"{name}_{h}x{w}_openvino_model")
    if not out.exists():
        f = YOLO(str(pt)).export(format="onnx" if runtime == "onnx" else "openvino", imgsz=[h, w], device="cpu",
                                 simplify=False, half=False, dynamic=False, verbose=False)
        shutil.move(f, out)
    return out


def load(name, runtime, size):
    m = YOLO(str(model_file(name, runtime, size)), task="detect")
    return m, (size if runtime == "pt" else list(RECT[size]))


def peak_rss_mib():
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)


def latency(a):
    frames = B.clip720_frames()
    model, imgsz = load(a.model, a.runtime, a.size)
    kw = dict(imgsz=imgsz, classes=[B.PERSON, *B.CUP_CLASSES], conf=0.25, device="cpu", verbose=False)
    for i in range(5):
        model.predict(frames[i], **kw)
    ms = []
    for i in range(a.iters):
        t0 = B.now_ms()
        model.predict(frames[i % len(frames)], **kw)
        ms.append(B.now_ms() - t0)
    return {**B.stats(ms)}


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / max(1e-9, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def pipeline(a):
    cap, jpegs, frames = cv2.VideoCapture(str(B.VIDEO)), [], []  # 한 장씩 JPEG 로만 보관(메모리 최대값을 실제 서버에 가깝게)
    while True:
        ok, f = cap.read()
        if not ok:
            break
        jpegs.append(cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, B.JPEG_Q])[1].tobytes())
        if len(frames) < 5:
            frames.append(f)
    cap.release()
    w, h = 960, 540
    tables, foot = B.load_tables(1, 1)
    tids = [t["id"] for t in tables]
    model, imgsz = load(a.model, a.runtime, a.size)
    kw = dict(persist=True, tracker="bytetrack.yaml", classes=[B.PERSON, *B.CUP_CLASSES], conf=0.25,
              imgsz=imgsz, device="cpu", verbose=False)
    for i in range(5):
        model.track(frames[i], **kw)
    model.predictor.trackers[0].reset()
    live = B.LivePipeline(tables, foot)
    t = {"decode": [], "detect_track": [], "post": [], "extrapolate": []}
    outs, last, prev, hist, raw = [], None, {}, [], []  # prev: trackId -> (프레임, 상자) 직전 두 번 탐지
    for i, jb in enumerate(jpegs):
        t0 = B.now_ms()
        img = cv2.imdecode(np.frombuffer(jb, np.uint8), cv2.IMREAD_COLOR)
        t1 = B.now_ms()
        t["decode"].append(t1 - t0)
        if i % a.interval == 0:
            r = model.track(img, **kw)[0]
            t2 = B.now_ms()
            bx = r.boxes
            xyxy = bx.xyxy.numpy() / np.array([w, h, w, h])
            cls = bx.cls.numpy().astype(int)
            ids = bx.id.numpy().astype(int) if bx.id is not None else np.full(len(cls), -1)
            persons = [[*map(float, b), int(k)] for b, c, k in zip(xyxy, cls, ids) if c == B.PERSON]
            cups = [b for b, c in zip(xyxy, cls) if c != B.PERSON]
            raw.append({"i": i, "persons": [[round(v, 4) for v in p[:4]] + [p[4]] for p in persons],
                        "cups": [[round(float(v), 4) for v in c] for c in cups]})
            out = live.step(persons)
            out["cupTables"] = sorted({tb["id"] for c in cups for tb in tables if point_in_polygon(box_center(c), tb["polygon"])})
            t3 = B.now_ms()
            t["detect_track"].append(t2 - t1)
            t["post"].append(t3 - t2)
            for p in out["persons"]:
                prev[p[4]] = (prev.get(p[4], ()) + ((i, p[:4]),))[-2:]
            last = out
            boxes = {p[4]: p[:4] for p in out["persons"]}
        else:  # 사이 장: 확인된 추적 상자를 직전 두 번 탐지의 속도로 앞으로 밀어 그림(등속 = 칼만 예측 단계와 같은 모양)
            t2 = B.now_ms()
            boxes = {}
            for p in last["persons"]:
                hs = prev.get(p[4], ())
                if len(hs) == 2:
                    (fa, ba), (fb, bb) = hs
                    v = (np.asarray(bb) - np.asarray(ba)) / max(1, fb - fa)
                    boxes[p[4]] = (np.asarray(bb) + v * (i - fb)).tolist()
                else:
                    boxes[p[4]] = p[:4]
            t["extrapolate"].append(B.now_ms() - t2)
        outs.append(last)
        hist.append(boxes)
    res = {"times": {k: B.stats(v) for k, v in t.items() if v}}
    det_ms = np.mean(t["detect_track"]) + np.mean(t["post"])
    dec = np.mean(t["decode"])
    ext = np.mean(t["extrapolate"]) if t["extrapolate"] else 0.0
    res["perFrameCost_ms"] = round(float(dec + (det_ms + (a.interval - 1) * ext) / a.interval), 2)
    tag = f"{a.model}_{a.runtime}_{a.size}_N{a.interval}"
    res["accuracy"] = accuracy(outs, tids, B.RESULTS / "cpu_frames" / f"{tag}.json")
    # T-065b 용: 탐지한 장의 확인 전 원본 상자([0..1] x1,y1,x2,y2,trackId)와 컵 상자. 판정 로직을 바꿔 다시 계산할 수 있게
    (B.RESULTS / "cpu_frames" / f"{tag}_raw.json").write_text(json.dumps(
        {"source": "cafe17.mp4 960x540 5fps, JPEG q80", "model": a.model, "runtime": a.runtime, "imgsz": a.size,
         "interval": a.interval, "frames": raw}, separators=(",", ":")))
    if a.interval == 1:
        res["extrapolationIoU"] = extrapolation_check(hist)
    return res


def extrapolation_check(hist):
    """N=1 결과로 '만약 N장마다 탐지했다면' 사이 장의 등속 예측 상자가 실제 탐지 상자와 얼마나 겹치는지(같은 추적 번호).
    이 영상은 초당 5장이라 사이 간격이 0.2초씩 벌어진다(초당 15장 카메라의 0.067초보다 가혹)."""
    out = {}
    for n in (2, 3):
        ious = []
        for i in range(len(hist)):
            base = i - i % n
            if i % n == 0 or base < n:
                continue
            a, b = hist[base - n], hist[base]
            for tid, bb in b.items():
                if tid in a and tid in hist[i]:
                    v = (np.asarray(bb) - np.asarray(a[tid])) / n
                    ious.append(iou((np.asarray(bb) + v * (i - base)).tolist(), hist[i][tid]))
        hold = []
        for i in range(len(hist)):
            base = i - i % n
            if i % n == 0:
                continue
            for tid, bb in hist[base].items():
                if tid in hist[i]:
                    hold.append(iou(bb, hist[i][tid]))
        out[f"N{n}"] = {"constantVelocity_meanIoU": round(float(np.mean(ious)), 3), "hold_meanIoU": round(float(np.mean(hold)), 3),
                        "pairs": len(ious)}
    return out


def accuracy(outs, tids, save=None):
    """정답 비교. 기준선(cnn README T-046d)과 같은 함수·정의: 손님 수 = smooth.score, 점유·앉은 인원 = outlier 포함/제외 둘 다."""
    if not GT.exists():
        return None
    g = json.loads(GT.read_text())
    gt_in, truth = g["inStore"], [{k: tuple(v) for k, v in row.items()} for row in g["seatedTruth"]]
    occ = smooth.table_scores([o["occupiedTables"] for o in outs], None, truth, tids)
    seat = [o["seated"] for o in outs]
    if save:  # 프레임별 숫자(나중에 다시 계산용, 몇십 KB)
        save.parent.mkdir(parents=True, exist_ok=True)
        save.write_text(json.dumps({k: [o[k] for o in outs] for k in ("inStore", "seated", "occupiedTables")}))
    return {"inStore": smooth.score([o["inStore"] for o in outs], gt_in),
            "occupancy": {"include": occ["include"]["occupancyAccuracy"], "exclude": occ["exclude"]["occupancyAccuracy"]},
            "seated": {"include": smooth.score(seat, smooth.seated_gt_counts(truth, "include")),
                       "exclude": smooth.score(seat, smooth.seated_gt_counts(truth, "exclude"))}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["latency", "pipeline", "reference"], required=True)
    ap.add_argument("--model", default="yolo11n")
    ap.add_argument("--runtime", choices=["pt", "onnx", "openvino", "ov_int8"], default="openvino")
    ap.add_argument("--size", type=int, default=416)
    ap.add_argument("--interval", type=int, default=1)
    ap.add_argument("--iters", type=int, default=60)
    a = ap.parse_args()
    row = {"mode": a.mode, "model": a.model, "runtime": a.runtime, "imgsz": a.size, "interval": a.interval,
           "threads": THREADS, "affinity": sorted(os.sched_getaffinity(0)), "cudaVisible": torch.cuda.is_available()}
    t0 = time.time()
    try:
        if a.mode == "latency":
            row.update(latency(a))
        elif a.mode == "reference":  # 기존 재생 결과(YOLO11s, 1920 원본, imgsz 1280)를 같은 정답 비교 함수로
            ref = json.loads((B.DATA / "cafe17-detections.json").read_text())
            outs = [f["counts"] for f in ref["frames"]]
            row.update({"model": "yolo11s", "runtime": "mps(기존 export)", "imgsz": 1280, "source": "1920x1080 원본",
                        "accuracy": accuracy(outs, [t["id"] for t in ref["tables"]])})
        else:
            row.update(pipeline(a))
    except Exception as e:
        row["error"] = f"{type(e).__name__}: {e}"
    row["peakRssMiB"] = peak_rss_mib()
    row["wallSec"] = round(time.time() - t0, 1)
    row["measuredAt"] = time.strftime("%Y-%m-%d %H:%M %Z")
    print(json.dumps(row, ensure_ascii=False), flush=True)
    B.RESULTS.mkdir(parents=True, exist_ok=True)
    with open(B.RESULTS / "cpu_rows.jsonl", "a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()

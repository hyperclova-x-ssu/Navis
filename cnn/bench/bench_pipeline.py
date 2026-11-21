"""측정 2: 한 장당 전체 처리 시간 = JPEG 디코딩 + YOLO11s track(ByteTrack) + 확인된 추적(N=2) + 앉음 판정 + 칼만 필터
+ 테이블 구역 컵 판정. 입력 A = cafe17.mp4(960x540, 1,718장), 입력 B = 1280x720(Café 17-354 35장, 6바퀴, 바퀴마다 추적 초기화).
프레임은 미리 JPEG(품질 80)로 만들어 두고 매 장 cv2.imdecode 부터 잰다(휴대폰이 JPEG 를 보낸다는 가정).
결과: results/pipeline.json.  실행(gpu-server): venv/bin/python cnn/bench/bench_pipeline.py [--configs pt:960:fp16,...]"""
import argparse
import gc
import json

import numpy as np
import torch
from ultralytics import YOLO

import benchlib as B
import smooth
from bench_detect import RECT, engine_path
from common import box_center, point_in_polygon

DEFAULT = "pt:640:fp16,pt:960:fp16,pt:1280:fp16,pt:1280:fp32,engine:640:fp16,engine:960:fp16,engine:1280:fp16"
REF_JSON = B.DATA / "cafe17-detections.json"  # 저장소 public/cnn 의 기존 결과(1920 원본, imgsz 1280, mps) - 숫자 비교용


def load_model(backend, size, half):
    if backend == "pt":
        return YOLO(str(B.MODELS / "yolo11s.pt")), size
    p = engine_path(size, half)
    if not p.exists():
        raise FileNotFoundError(f"{p.name} 없음: bench_detect.py 를 먼저 돌려 엔진을 만드세요")
    return YOLO(str(p), task="detect"), list(RECT[size])


def run_source(model, imgsz, half, jpegs, w, h, loops=1):
    tables, foot = B.load_tables(1, 1)
    kw = dict(persist=True, tracker="bytetrack.yaml", classes=[B.PERSON, *B.CUP_CLASSES], conf=0.25,
              imgsz=imgsz, half=half, device=0, verbose=False)
    import cv2
    for i in range(10):  # 예열
        model.track(cv2.imdecode(np.frombuffer(jpegs[i % len(jpegs)], np.uint8), cv2.IMREAD_COLOR), **kw)
    B.gpu_mem_reset()
    t = {"decode": [], "track": [], "post": [], "total": []}
    outs, raws = [], []
    for loop in range(loops):
        model.predictor.trackers[0].reset()
        live = B.LivePipeline(tables, foot)
        for jb in jpegs:
            B.sync()
            t0 = B.now_ms()
            img = cv2.imdecode(np.frombuffer(jb, np.uint8), cv2.IMREAD_COLOR)
            t1 = B.now_ms()
            r = model.track(img, **kw)[0]
            B.sync()
            t2 = B.now_ms()
            bx = r.boxes
            xyxy = bx.xyxy.cpu().numpy() / np.array([w, h, w, h])
            cls = bx.cls.cpu().numpy().astype(int)
            ids = bx.id.cpu().numpy().astype(int) if bx.id is not None else np.full(len(cls), -1)
            persons = [[*map(float, b), int(i)] for b, c, i in zip(xyxy, cls, ids) if c == B.PERSON]
            cups = [b for b, c in zip(xyxy, cls) if c != B.PERSON]
            out = live.step(persons)
            out["cupTables"] = sorted({tb["id"] for c in cups for tb in tables if point_in_polygon(box_center(c), tb["polygon"])})
            t3 = B.now_ms()
            t["decode"].append(t1 - t0)
            t["track"].append(t2 - t1)
            t["post"].append(t3 - t2)
            t["total"].append(t3 - t0)
            if loop == 0:
                outs.append(out)
                raws.append([p + [live.seat(p)] for p in persons])
    return {k: B.stats(v) for k, v in t.items()}, B.gpu_mem(), outs, raws


def check_same_as_batch(outs, raws):
    """한 장 단위 LivePipeline 결과가 smooth.py 배치 함수(confirm_tracks + kalman)와 같은지"""
    kept = smooth.confirm_tracks(raws, smooth.MIN_TRACK_FRAMES)
    raw_in = [len(k) for k in kept]
    raw_seat = [sum(1 for p in k if p[5]) for k in kept]
    sm_in = [int(round(v)) for v in smooth.kalman(raw_in)]
    sm_seat = [int(round(v)) for v in smooth.kalman(raw_seat)]
    return (raw_in == [o["inStoreRaw"] for o in outs] and raw_seat == [o["seatedRaw"] for o in outs]
            and sm_in == [o["inStore"] for o in outs] and sm_seat == [o["seated"] for o in outs])


def compare_ref(outs):
    """기존 재생용 결과(cafe17-detections.json: 1920 원본 입력, imgsz 1280)와 프레임별 숫자 차이"""
    if not REF_JSON.exists():
        return None
    ref = json.loads(REF_JSON.read_text())["frames"]
    n = min(len(ref), len(outs))
    d = lambda k: round(float(np.mean([abs(ref[i]["counts"][k] - outs[i][k]) for i in range(n)])), 3)
    occ = np.mean([set(ref[i]["counts"]["occupiedTables"]) == set(outs[i]["occupiedTables"]) for i in range(n)])
    return {"frames": n, "inStoreRaw_MAE": d("inStoreRaw"), "inStore_MAE": d("inStore"), "seated_MAE": d("seated"),
            "occupiedTables_sameRate": round(float(occ), 3),
            "meanInStore": {"ref": round(float(np.mean([f["counts"]["inStore"] for f in ref[:n]])), 2),
                            "this": round(float(np.mean([o["inStore"] for o in outs[:n]])), 2)}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default=DEFAULT)
    a = ap.parse_args()
    vid = B.video_frames()
    clip = B.clip720_frames()
    src = {"cafe17_960x540": (B.to_jpeg(vid), 960, 540, 1), "clip354_1280x720": (B.to_jpeg(clip), 1280, 720, 6)}
    jpeg_kb = {k: round(float(np.mean([len(j) for j in v[0]])) / 1024, 1) for k, v in src.items()}
    rows = []
    for cfg in a.configs.split(","):
        backend, size, prec = cfg.split(":")
        size, half = int(size), prec == "fp16"
        model = None
        for name, (jpegs, w, h, loops) in src.items():
            row = {"config": cfg, "source": name}
            try:
                model, imgsz = load_model(backend, size, half)
                times, mem, outs, raws = run_source(model, imgsz, half, jpegs, w, h, loops)
                row.update({"times": times, "gpuMem": mem, "liveEqualsBatch": check_same_as_batch(outs, raws)})
                if name.startswith("cafe17"):
                    row["vsPlaybackJson"] = compare_ref(outs)
            except Exception as e:
                row["error"] = f"{type(e).__name__}: {e}"
            print(json.dumps(row, ensure_ascii=False), flush=True)
            rows.append(row)
            del model
            gc.collect()
            torch.cuda.empty_cache()
    B.save("pipeline.json", {"jpegQuality": B.JPEG_Q, "jpegMeanKB": jpeg_kb,
                             "stages": "decode=cv2.imdecode, track=model.track(ByteTrack 포함, cuda sync), post=확인 추적+앉음+칼만+컵 구역",
                             "rows": rows})


if __name__ == "__main__":
    main()

"""측정 1: YOLO11s(COCO) 사진 1장 처리 시간. 입력 크기 640/960/1280 x FP32/FP16 x PyTorch/TensorRT.
입력 = 1280x720 사진(Café 17-354 원본을 줄인 것, 휴대폰 해상도 가정). 시간 = model.predict 한 번
(전처리+추론+후처리, GPU 동기화 포함, JPEG 디코딩 제외). 결과: results/detect.json
실행(gpu-server): venv/bin/python cnn/bench/bench_detect.py [--backends pt,engine] [--iters 300]"""
import argparse
import gc
import shutil
import traceback

import torch
from ultralytics import YOLO

import benchlib as B

SIZES = (640, 960, 1280)
RECT = {640: (384, 640), 960: (544, 960), 1280: (736, 1280)}  # 16:9 입력을 stride 32 로 맞춘 (h, w). PyTorch rect 와 같은 크기
CLASSES = [B.PERSON, *B.CUP_CLASSES]


def engine_path(size, half):
    return B.MODELS / f"yolo11s_{RECT[size][0]}x{RECT[size][1]}_{'fp16' if half else 'fp32'}.engine"


def build_engine(size, half):
    out = engine_path(size, half)
    if out.exists():
        return out, None
    t0 = B.now_ms()
    src = B.MODELS / "yolo11s.pt"
    f = YOLO(str(src)).export(format="engine", imgsz=list(RECT[size]), half=half, device=0, workspace=4, verbose=False)
    shutil.move(f, out)
    onnx = src.with_suffix(".onnx")
    if onnx.exists():
        onnx.unlink()
    return out, round((B.now_ms() - t0) / 1000, 1)


def run(model, frames, size, half, iters, warm, engine):
    kw = dict(imgsz=list(RECT[size]) if engine else size, half=half, classes=CLASSES, conf=0.25, device=0, verbose=False)
    for i in range(warm):
        model.predict(frames[i % len(frames)], **kw)
    B.sync()
    B.gpu_mem_reset()
    ms, sp, nbox = [], {"preprocess": [], "inference": [], "postprocess": []}, []
    for i in range(iters):
        img = frames[i % len(frames)]
        B.sync()
        t0 = B.now_ms()
        r = model.predict(img, **kw)[0]
        B.sync()
        ms.append(B.now_ms() - t0)
        for k in sp:
            sp[k].append(r.speed[k])
        nbox.append(len(r.boxes))
    return {**B.stats(ms), "ultralyticsSpeed_mean_ms": {k: round(sum(v) / len(v), 2) for k, v in sp.items()},
            "boxesPerFrame_mean": round(sum(nbox) / len(nbox), 2),
            "gpuMem": B.gpu_mem(), "netInput_hw": list(RECT[size])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backends", default="pt,engine")
    ap.add_argument("--iters", type=int, default=300)
    ap.add_argument("--warm", type=int, default=30)
    a = ap.parse_args()
    frames = B.clip720_frames()
    rows = []
    for backend in a.backends.split(","):
        for size in SIZES:
            for half in (False, True):
                model = None
                row = {"backend": backend, "imgsz": size, "precision": "fp16" if half else "fp32"}
                try:
                    if backend == "pt":
                        model = YOLO(str(B.MODELS / "yolo11s.pt"))
                    else:
                        p, secs = build_engine(size, half)
                        row["engine"], row["engineBuildSec"] = p.name, secs
                        model = YOLO(str(p), task="detect")
                    row.update(run(model, frames, size, half, a.iters, a.warm, backend == "engine"))
                except Exception as e:
                    row["error"] = f"{type(e).__name__}: {e}"
                    traceback.print_exc()
                print(row, flush=True)
                rows.append(row)
                del model
                gc.collect()
                torch.cuda.empty_cache()
    B.save("detect.json", {"input": "1280x720 BGR (Café 17-354 원본 35장 축소, 순환)", "iters": a.iters,
                           "warmup": a.warm, "classes": CLASSES, "conf": 0.25,
                           "timing": "model.predict 1회 wall time(전처리+추론+NMS, cuda synchronize). JPEG 디코딩 제외",
                           "rows": rows})


if __name__ == "__main__":
    main()

"""후보 C: OpenVINO FP32 모델(bench_cpu.py 가 만든 *_openvino_model) -> NNCF 사후 양자화 INT8 모델.
ultralytics 의 int8 내보내기와 같은 설정(preset MIXED, 검출 머리의 Add/Sub/Mul/Div·dfl·Sigmoid 는 FP 유지)을 쓰되,
보정 데이터는 COCO 를 내려받지 않고 cafe17.mp4 에서 고른 300장을 쓴다(같은 카메라 영상이라 실제 매장에서 '그 매장 화면으로 보정'한 경우와 비슷).
실행(gpu-server, 측정 코어와 겹치지 않게): PYTHONPATH=extra:extra_cpu:extra_int8 taskset -c 10-19 bash run_moa.sh make_int8.py --model yolo11s --size 1280"""
import argparse
import shutil

import numpy as np

import benchlib as B
from bench_cpu import RECT, model_file

CALIB = 300


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo11s")
    ap.add_argument("--size", type=int, default=1280)
    a = ap.parse_args()
    import nncf
    import openvino as ov
    from ultralytics.data.augment import LetterBox

    h, w = RECT[a.size]
    src = model_file(a.model, "openvino", a.size)  # 없으면 FP32 로 먼저 내보냄
    out = B.MODELS / f"{a.model}_{h}x{w}_int8_openvino_model"
    if out.exists():
        print("이미 있음:", out)
        return
    xml = next(src.glob("*.xml"))
    frames = B.video_frames()
    pick = [frames[i] for i in np.linspace(0, len(frames) - 1, CALIB).astype(int)]
    lb = LetterBox(new_shape=(h, w), auto=False)

    def tf(img):
        x = lb(image=img)[..., ::-1].transpose(2, 0, 1)
        return np.ascontiguousarray(x, dtype=np.float32)[None] / 255.0

    t0 = B.now_ms()
    core = ov.Core()
    m = core.read_model(str(xml))
    head = "model.23"  # YOLO11 검출 머리 모듈 이름
    ignored = nncf.IgnoredScope(patterns=[f".*{head}/.*/Add", f".*{head}/.*/Sub*", f".*{head}/.*/Mul*",
                                          f".*{head}/.*/Div*", ".*\\.dfl.*"], types=["Sigmoid"], validate=False)
    q = nncf.quantize(m, nncf.Dataset(pick, tf), preset=nncf.QuantizationPreset.MIXED, subset_size=CALIB,
                      ignored_scope=ignored)
    out.mkdir(parents=True)
    ov.save_model(q, str(out / xml.name), compress_to_fp16=False)
    shutil.copy(src / "metadata.yaml", out / "metadata.yaml")
    print(f"저장: {out}  ({(B.now_ms() - t0) / 1000:.0f}초)")


if __name__ == "__main__":
    main()

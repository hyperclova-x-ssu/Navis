"""T-067 pipeline.py 시험. 실행(cnn/live): pytest -q tests/test_pipeline.py
- 기본: 가짜 모델(정해 둔 상자) + 실제 ByteTrack(ultralytics)로 탐지·추적·사이 장·초기화.
- 실제 모델(gpu-server): 확정 설정 INT8 모델 파일이 있으면 돌림(`-m model`이 아니어도 파일이 있으면 실행, 없으면 건너뜀).
- GPU: `-m gpu`(CUDA 있을 때만)."""
import os
import sys
from pathlib import Path

import numpy as np
import pytest

os.environ.setdefault("YOLO_AUTOINSTALL", "False")
os.environ.setdefault("YOLO_OFFLINE", "True")
LIVE = Path(__file__).resolve().parents[1]
if str(LIVE) not in sys.path:
    sys.path.insert(0, str(LIVE))

import pipeline as P  # noqa: E402
from contracts import FrameIn  # noqa: E402

torch = pytest.importorskip("torch")
pytest.importorskip("ultralytics")
from ultralytics.engine.results import Boxes  # noqa: E402

W, H = 1280, 720


class FakeModel:
    """predict(img) -> 정해 둔 상자 [x1,y1,x2,y2,conf,cls](픽셀) 목록을 차례로 돌려줌."""

    def __init__(self, seq):
        self.seq, self.i, self.kw = seq, 0, []

    def predict(self, img, **kw):
        self.kw.append(kw)
        rows = self.seq[min(self.i, len(self.seq) - 1)] if self.seq else []
        self.i += 1
        data = torch.tensor(rows, dtype=torch.float32) if rows else torch.zeros((0, 6))
        return [type("R", (), {"boxes": Boxes(data, img.shape[:2])})()]


def frame(i, t, img=None):
    f = FrameIn(frame_id=i, capture_t=t, recv_t=t, jpeg=b"", w=W, h=H)
    f.image = img if img is not None else np.zeros((H, W, 3), np.uint8)
    return f


def settings(**kw):
    s = P.resolve_settings(None)
    s.update(kw)
    return s


PERSON_A = [100, 200, 200, 600, 0.9, 0]
PERSON_B = [800, 100, 900, 500, 0.8, 0]
CUP = [500, 400, 540, 440, 0.7, 41]
CHAIR = [300, 300, 400, 400, 0.9, 56]


def test_resolve_settings_defaults_and_env(monkeypatch):
    for k in ("CNN_MODE", "CNN_RUNTIME", "CNN_MODEL", "CNN_IMGSZ", "CNN_DETECT_HZ", "CNN_BOX_PREDICT", "CNN_CPU_THREADS", "CNN_DEVICE"):
        monkeypatch.delenv(k, raising=False)
    s = P.resolve_settings(None)
    assert (s["mode"], s["runtime"], s["model"], s["imgsz"], s["detect_hz"], s["box_predict"], s["cpu_threads"], s["device"]) == \
        ("weak", "openvino-int8", "yolo11s", 960, 5.0, "hold", 4, "cpu")
    assert P.model_path(s).name == "yolo11s_544x960_int8_openvino_model"
    monkeypatch.setenv("CNN_MODE", "gpu")
    g = P.resolve_settings(None)
    assert (g["runtime"], g["imgsz"], g["device"]) == ("pt", 960, "cuda:0") and P.model_path(g).name == "yolo11s.pt"
    monkeypatch.setenv("CNN_BOX_PREDICT", "flow")
    with pytest.raises(ValueError):
        P.resolve_settings(None)


def test_resolve_settings_from_config_object():
    sys.path.insert(0, str(LIVE))
    import config
    cfg = config.Config(mode="gpu", runtime="torch", imgsz=1280, device="cuda:0", detect_hz=0)
    s = P.resolve_settings(cfg)
    assert s["runtime"] == "pt" and s["detect_hz"] == 0 and s["imgsz"] == 1280
    with pytest.raises(ValueError):
        P.resolve_settings(config.Config(detect_plan="unknown"))


def test_detect_tracks_persons_and_cups_only_in_unit_coords():
    m = FakeModel([[PERSON_A, PERSON_B, CUP, CHAIR]] * 5)
    d = P.YoloDetector(settings(), model=m)
    outs = [d.detect(frame(i, i * 0.2)) for i in range(3)]
    kw = m.kw[0]
    assert kw["classes"] == [0, 40, 41, 45] and kw["conf"] == 0.25 and kw["imgsz"] == [544, 960] and kw["device"] == "cpu"
    last = outs[-1]
    assert len(last.persons) == 2 and len(last.cups) == 1
    ids = sorted(p[4] for p in last.persons)
    assert ids[0] >= 1 and len(set(ids)) == 2  # 추적 번호 있음
    assert sorted(p[4] for p in outs[1].persons) == ids  # 같은 사람 = 같은 번호(persist)
    x1, y1, x2, y2, _ = next(p for p in last.persons if p[0] < 0.5)
    assert np.allclose([x1, y1, x2, y2], [100 / W, 200 / H, 200 / W, 600 / H], atol=0.01)
    assert all(0 <= v <= 1 for p in last.persons for v in p[:4])


def test_predict_hold_returns_previous_boxes_marked_predicted():
    d = P.YoloDetector(settings(), model=FakeModel([[PERSON_A, CUP]] * 3))
    for i in range(2):
        det = d.detect(frame(i, i * 0.2))
    held = d.predict(frame(9, 0.267), 0.067)
    assert held.persons == det.persons and held.cups == det.cups and held.predicted is True
    assert held is not det and not getattr(det, "predicted", False)


def test_predict_kalman_moves_at_constant_velocity():
    seq = [[[100 + 30 * i, 200, 200 + 30 * i, 600, 0.9, 0]] for i in range(6)]
    d = P.YoloDetector(settings(box_predict="kalman"), model=FakeModel(seq))
    for i in range(4):
        last = d.detect(frame(i, i * 0.2))
    p = d.predict(frame(10, 0.6 + 0.1), 0.1).persons[0]
    assert p[0] > last.persons[0][0]  # 오른쪽으로 계속 감


def test_reset_tracker_clears_boxes_and_keeps_ids_increasing():
    d = P.YoloDetector(settings(), model=FakeModel([[PERSON_A]] * 10))
    for i in range(3):
        before = d.detect(frame(i, i * 0.2))
    old = max(p[4] for p in before.persons)
    d.reset_tracker()
    assert d.predict(frame(5, 1.0), 0).persons == []
    for i in range(3):
        after = d.detect(frame(10 + i, 2 + i * 0.2))
    assert after.persons and min(p[4] for p in after.persons) > old


def test_track_buffer_is_seconds_based():
    d = P.YoloDetector(settings(detect_hz=5.0, track_sec=6.0), model=FakeModel([]))
    assert d.tracker.args.track_buffer == 30
    d = P.YoloDetector(settings(detect_hz=2.5, track_sec=6.0), model=FakeModel([]))
    assert d.tracker.args.track_buffer == 15


def test_detect_decodes_jpeg_when_no_image():
    cv2 = pytest.importorskip("cv2")
    img = np.full((H, W, 3), 127, np.uint8)
    jpeg = cv2.imencode(".jpg", img)[1].tobytes()
    d = P.YoloDetector(settings(), model=FakeModel([[PERSON_A]]))
    f = FrameIn(frame_id=0, capture_t=0.0, recv_t=0.0, jpeg=jpeg, w=W, h=H)
    d.detect(f)
    assert f.image is not None and f.image.shape == (H, W, 3)


def test_info_matches_health_fields():
    d = P.YoloDetector(settings(), model=FakeModel([]))
    assert d.info() == {"mode": "weak", "device": "cpu", "cpuThreads": 4, "runtime": "openvino-int8", "model": "yolo11s",
                        "imgsz": 960, "detectHz": 5.0, "boxPredict": "hold", "detectPlan": "full"}


def test_load_numbers_by_path():
    m = P.load_numbers()
    assert hasattr(m, "create_engine") and m.__name__ == "live_numbers"


_INT8 = P.model_path(P.resolve_settings(None))


@pytest.mark.skipif(not _INT8.exists(), reason=f"확정 설정 모델 없음: {_INT8} (gpu-server 에서 돌림)")
def test_real_int8_model_detects_people_on_cafe_frame():
    cv2 = pytest.importorskip("cv2")
    clip = Path(os.environ.get("NAVIS_LIVE", Path.home() / "navis-cnn-live")) / "data" / "clip354_1080"
    pics = sorted(clip.glob("frames_*.jpg"))
    if not pics:
        pytest.skip("카페 사진 없음")
    d = P.create_detector(None)
    img = cv2.resize(cv2.imread(str(pics[0])), (W, H))
    outs = [d.detect(frame(i, i * 0.2, img.copy())) for i in range(3)]
    assert len(outs[-1].persons) >= 5  # 카페 17번 장면은 손님 약 10명
    assert d.infer_ms < 500


@pytest.mark.gpu
def test_gpu_mode_detects():
    if not torch.cuda.is_available():
        pytest.skip("CUDA 없음")
    s = P.resolve_settings(type("C", (), {"mode": "gpu"})())
    if not P.model_path(s).exists():
        pytest.skip("yolo11s.pt 없음")
    d = P.YoloDetector(s)
    d.warmup()
    out = d.detect(frame(0, 0.0, np.zeros((H, W, 3), np.uint8)))
    assert out.persons == []

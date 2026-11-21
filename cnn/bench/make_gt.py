"""Mac 에서 한 번: Café 정답(~/Datasets) -> cafe17.mp4 프레임 순서의 프레임별 정답 숫자(gt_cafe17.json, 저장소 밖에 둠).
손님 수 = smooth.ground_truth, 앉은 사람 = smooth.seated_truth(테이블 구역 기준, T-046c 정의). gpu-server 로 복사해 bench_cpu.py 가 쓴다.
실행(Mac, cnn/bench): python3 make_gt.py <출력.json>"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import smooth  # noqa: E402

cfg = json.loads((Path(__file__).resolve().parent.parent / "zones" / "cafe17_tables.json").read_text())
gt_in, _ = smooth.ground_truth()
truth = smooth.seated_truth(cfg["tables"], cfg.get("footFrac", 0.8))
Path(sys.argv[1]).write_text(json.dumps({"inStore": gt_in, "seatedTruth": truth}))
print(len(gt_in), "frames")

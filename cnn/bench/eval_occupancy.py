"""T-065b 의 새 판정(occupancy/seat_state.py)·새 정답 정의(D-376)로 bench 결과 원본 상자(results/cpu_frames/*_raw.json)를 평가.
occupancy/evaluate_weakpc.py 를 그대로 쓰되, 입력 폴더와 출력 위치만 bench 안으로 바꾼다(그 작업의 결과 파일은 건드리지 않음).
실행(Mac, cnn/bench): python3 eval_occupancy.py [이름 일부 ...]  -> results/occupancy_eval.json
  정답 캐시는 ~/Datasets/cafe-sample/t065b/ (evaluate_occupancy.py 가 만든 것)를 읽기만 한다."""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent / "occupancy"), str(HERE.parent)]

import evaluate_weakpc as W  # noqa: E402

pats = sys.argv[1:]
src = HERE / "results" / "cpu_frames"
if pats:  # 고른 설정만: 임시 폴더 대신 glob 을 바꿔 끼운다
    class Sel:
        def glob(self, pat):
            return [p for p in sorted(src.glob(pat)) if any(s in p.name for s in pats)]
    W.SRC = Sel()
else:
    W.SRC = src
W.RES = HERE / "results"
_write = Path.write_text


def write_text(self, data, *a, **k):  # evaluate_weakpc 는 RES/eval_weakpc.json 에 쓴다 -> 이름만 바꿈
    if self.name == "eval_weakpc.json" and self.parent == W.RES:
        self = self.with_name("occupancy_eval.json")
    return _write(self, data, *a, **k)


Path.write_text = write_text
W.main()

"""정답(gt_tracks.txt) 프레임별 인원 세기, 예측과 오차 계산."""
import numpy as np

from common import QUEUE, SEATED


def gt_counts(boxes):
    """한 프레임의 정답 상자 목록 -> 사람 수·줄 인원·앉은 인원·앉은 무리 수"""
    seated = [b for b in boxes if b[5] in SEATED]
    return {
        "persons": len(boxes),
        "queue": sum(1 for b in boxes if b[5] in QUEUE),
        "seated": len(seated),
        "seated_groups": len({b[4] for b in seated}),
    }


def errors(pred, gt):
    """pred, gt: 같은 길이 숫자 목록 -> MAE, 상대 오차(합 |오차| / 합 정답), 평균 차이(예측-정답)"""
    p, g = np.array(pred, float), np.array(gt, float)
    mae = float(np.abs(p - g).mean())
    rel = float(np.abs(p - g).sum() / g.sum()) if g.sum() else None
    return {"mae": round(mae, 3), "relative_error": None if rel is None else round(rel, 3),
            "pred_mean": round(float(p.mean()), 3), "gt_mean": round(float(g.mean()), 3)}

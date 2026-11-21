"""T-065b ③ 자세 판정(선택): YOLO11-pose 관절 -> 추적 상자별 "stand"/"sit"/None.
pose 결과 한 줄 = [x1,y1,x2,y2,conf, kx,ky,kc *17] ([0..1] 좌표, COCO 17점 순서). 표준 라이브러리만 사용.
서 있음 = 엉덩이(11,12)·무릎(13,14)·어깨(5,6)가 보이고 (무릎y-엉덩이y)/(엉덩이y-어깨y) > thigh_thr
         (서 있으면 허벅지가 세로라 비율이 크고, 앉으면 허벅지가 눕거나 테이블에 가려 작다).
pose 를 매 장 못 돌리는 경우(약한 PC에서 몇 장마다) Posture.update 가 추적별 마지막 판정을 memory_sec 동안 기억한다."""

KP_CONF = 0.5
DEFAULTS = {"thigh_thr": 0.6, "match_iou": 0.3, "memory_sec": 2.0}


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    return i / max(1e-9, (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i)


def _avg(row, joints):
    v = [(row[5 + 3 * j], row[6 + 3 * j]) for j in joints if row[7 + 3 * j] >= KP_CONF]
    return (sum(x for x, _ in v) / len(v), sum(y for _, y in v) / len(v)) if v else None


def classify(row, thigh_thr=DEFAULTS["thigh_thr"]):
    sh, hp, kn = _avg(row, (5, 6)), _avg(row, (11, 12)), _avg(row, (13, 14))
    if not (sh and hp and kn) or hp[1] - sh[1] <= 1e-4:
        return None
    return "stand" if (kn[1] - hp[1]) / (hp[1] - sh[1]) > thigh_thr else "sit"


class Posture:
    def __init__(self, **params):
        self.p = {**DEFAULTS, **params}
        self.last = {}  # trackId -> (t, posture)

    def update(self, now, persons, pose_rows=None):
        """persons: [[x1,y1,x2,y2,trackId]]. pose_rows 가 None 이면(이번 장은 pose 안 돌림) 기억만 씀.
        반환: persons 각 줄 끝에 posture 를 붙인 새 목록."""
        out = []
        for b in persons:
            tid = b[4]
            post = None
            if pose_rows is not None:
                best = max(pose_rows, key=lambda r: iou(b, r), default=None)
                if best is not None and iou(b, best) >= self.p["match_iou"]:
                    post = classify(best, self.p["thigh_thr"])
                if post is not None:
                    self.last[tid] = (now, post)
            if post is None and tid in self.last and now - self.last[tid][0] <= self.p["memory_sec"] + 1e-9:
                post = self.last[tid][1]
            out.append(list(b[:5]) + [post])
        return out

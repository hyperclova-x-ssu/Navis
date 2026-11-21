"""T-065b 테이블 점유 판정 보강: 한 장씩 들어오는 확인된 추적 상자 -> 테이블별 앉음/빔·앉은 시간.
앞쪽 값만 쓰는 방식(causal)이라 실시간 서버가 그대로 가져다 쓴다. 의존성: 표준 라이브러리만(구역 판정은 직접 구현).

규칙(기준선 = 상자 위 footFrac 지점이 구역 안 + 상자 높이 <= maxBoxH 이면 그 장에서 바로 앉음):
 ① 정지 판정: 후보(기준선 조건을 만족)인 상태가 dwell_sec 넘게 이어지고, 그동안 상자 기준점이 거의 안 움직인
    추적만 앉음으로 올린다. 움직임 = 지난 dwell_sec 동안 기준점의 최대 이동 / 상자 높이(사람 크기로 정규화).
    지나가는 사람·서서 잠깐 걸린 상자를 뺀다.
 ② 짧은 가림 유지: 앉은 추적이 안 보이거나 후보 조건이 깨져도 hold_sec 동안은 앉음 유지.
    추적 번호가 바뀌어 다시 잡힌 사람(사라진 앉은 사람 자리 근처의 새 추적)은 앉음을 물려받는다.
 ③' 가림 상자 거르기(상자만 씀, 추가 모델 없음): 넓이의 occluder_frac 이상이 '서 있는 사람 상자'(높이 > stand_h_px,
    자기보다 큰 상자) 안에 들어간 작은 상자는 후보가 아니다. 서 있는 손님 몸이 앞 사람·테이블에 가려 위쪽만 잡힌
    상자(높이가 작아 앉은 사람처럼 보임)를 뺀다. occluder_frac <= 0 이면 끔.
 ③ 자세 판정(선택): persons 에 posture="stand" 가 붙은 사람은 후보 아님(posture.py).

사용:
    st = SeatState(tables, foot_frac=0.8)        # tables: [{id, maxBoxH, polygon:[[x,y]..]}]  ([0..1] 좌표)
    out = st.step(t_sec, persons)                 # persons: [[x1,y1,x2,y2,trackId(, posture)], ...] 확인된 추적만([0..1])
                                                  # posture(선택) = "stand"|"sit"|None (posture.py, 없으면 상자 규칙만)
    out == {"seats": {trackId: tableId}, "occupied": [tableId..], "occupantCount": n,
            "tables": {tableId: {"occupied": bool, "occupants": n, "occupiedSec": 누적초, "sinceSec": 이번 사용 시작부터 초|None}}}
    occupied = 화면의 "사용 중", 아니면 "빈 자리"(D-377). occupants = 그 테이블에 머문 인원.
"""

DEFAULTS = {"dwell_sec": 0.6, "move_thr": 0.1, "hold_sec": 2.0, "inherit_dist": 0.6,
            "occluder_frac": 0.7, "stand_h_px": 350}  # 기본값 = T-065b 추천(GPU 서버·YOLO11s 1280, evaluate_occupancy.py 의 occupied 정의 앞쪽 절반 선택). 약한 PC 설정별 값은 results/eval_weakpc.json


def point_in_polygon(pt, poly):
    """경계 포함 짝홀 규칙. common.point_in_polygon(cv2)과 같은 결과(경계는 안으로 봄)."""
    x, y = pt
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        # 경계 위
        cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        if abs(cross) < 1e-12 and min(x1, x2) - 1e-12 <= x <= max(x1, x2) + 1e-12 and min(y1, y2) - 1e-12 <= y <= max(y1, y2) + 1e-12:
            return True
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xi:
                inside = not inside
    return inside


class SeatState:
    def __init__(self, tables, foot_frac=0.8, img_h=1080, **params):
        self.tables = tables
        self.foot = foot_frac
        self.img_h = img_h
        self.p = {**DEFAULTS, **params}
        self.tracks = {}  # tid -> {"hist": [(t, x, y, h)], "cand": table|None, "candSince": t, "seat": table|None, "lastSeatOk": t, "lastSeen": t}
        self.lost = []  # 사라진 앉은 추적: [(table, x, y, h, lostAt)]
        self.occ_sec = {t["id"]: 0.0 for t in tables}
        self.since = {t["id"]: None for t in tables}
        self.prev_t = None

    def _occluded(self, b, persons):
        f = self.p["occluder_frac"]
        if f <= 0:
            return False
        area = max(1e-12, (b[2] - b[0]) * (b[3] - b[1]))
        for c in persons:
            if c is b or (c[3] - c[1]) * self.img_h <= self.p["stand_h_px"] or (c[3] - c[1]) <= (b[3] - b[1]):
                continue
            ix = max(0.0, min(b[2], c[2]) - max(b[0], c[0]))
            iy = max(0.0, min(b[3], c[3]) - max(b[1], c[1]))
            if ix * iy >= f * area:
                return True
        return False

    def _candidate(self, b, persons=()):
        h = b[3] - b[1]
        pt = ((b[0] + b[2]) / 2, b[1] + h * self.foot)
        if len(b) > 5 and b[5] == "stand":  # ③ 자세 판정(선택): 서 있다고 판정된 사람은 후보 아님
            return None, pt, h
        if self._occluded(b, persons):  # ③' 서 있는 사람 상자 안에 든 작은 상자
            return None, pt, h
        for t in self.tables:
            if h * self.img_h <= t["maxBoxH"] and point_in_polygon(pt, t["polygon"]):
                return t["id"], pt, h
        return None, pt, h

    def _still(self, tr, now):
        """지난 dwell_sec 동안 기준점 최대 이동(상자 높이로 나눔) <= move_thr 이고 그 기간을 다 덮는 기록이 있는가."""
        win = [s for s in tr["hist"] if s[0] >= now - self.p["dwell_sec"] - 1e-9]
        if not win or now - tr["candSince"] < self.p["dwell_sec"] - 1e-9:
            return False
        hm = sorted(s[3] for s in win)[len(win) // 2]
        xs, ys = [s[1] for s in win], [s[2] for s in win]
        span = ((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2) ** 0.5
        return span / max(hm, 1e-6) <= self.p["move_thr"]

    def step(self, now, persons):
        P = self.p
        dt = 0.0 if self.prev_t is None else max(0.0, now - self.prev_t)
        self.prev_t = now
        seen = set()
        for b in persons:
            tid = b[4]
            if tid is None or tid < 0:
                continue
            seen.add(tid)
            cand, pt, h = self._candidate(b, persons)
            tr = self.tracks.get(tid)
            if tr is None:
                tr = {"hist": [], "cand": None, "candSince": now, "seat": None, "lastSeatOk": now, "lastSeen": now}
                self.tracks[tid] = tr
                # ② 번호 바뀜: 같은 구역 후보이고 사라진 앉은 사람 자리 근처면 앉음 물려받기
                if cand is not None:
                    best = None
                    for k, (lt, lx, ly, lh, la) in enumerate(self.lost):
                        d = ((pt[0] - lx) ** 2 + (pt[1] - ly) ** 2) ** 0.5 / max(lh, h, 1e-6)
                        if lt == cand and d <= P["inherit_dist"] and (best is None or d < best[0]):
                            best = (d, k)
                    if best is not None:
                        tr["seat"] = cand
                        self.lost.pop(best[1])
            if cand != tr["cand"]:
                tr["cand"], tr["candSince"] = cand, now
                tr["hist"] = []
            tr["lastSeen"] = now
            if cand is not None:
                tr["hist"].append((now, pt[0], pt[1], h))
                tr["hist"] = [s for s in tr["hist"] if s[0] >= now - P["dwell_sec"] - 1e-9]
            if tr["seat"] is not None and cand == tr["seat"]:
                tr["lastSeatOk"] = now
            elif tr["seat"] is None and cand is not None and self._still(tr, now):  # ① 정지 판정
                tr["seat"], tr["lastSeatOk"] = cand, now
            elif tr["seat"] is not None and cand is not None and cand != tr["seat"] and self._still(tr, now):
                tr["seat"], tr["lastSeatOk"] = cand, now  # 다른 테이블로 옮겨 앉음
            if tr["seat"] is not None and now - tr["lastSeatOk"] > P["hold_sec"] + 1e-9:  # ② 후보가 hold_sec 넘게 깨지면 해제
                tr["seat"] = None
        # 안 보인 추적: 앉아 있었으면 hold_sec 동안 유지(사라진 자리로 기록), 넘으면 삭제
        for tid in list(self.tracks):
            if tid in seen:
                continue
            tr = self.tracks[tid]
            if tr["seat"] is not None and now - tr["lastSeen"] <= P["hold_sec"] + 1e-9:
                continue
            if tr["seat"] is not None and tr["hist"]:
                _, x, y, h = tr["hist"][-1]
                self.lost.append((tr["seat"], x, y, h, now))
            del self.tracks[tid]
        self.lost = [l for l in self.lost if now - l[4] <= P["hold_sec"] + 1e-9]
        seats = {tid: tr["seat"] for tid, tr in self.tracks.items() if tr["seat"] is not None}
        per = {t["id"]: 0 for t in self.tables}
        for s in seats.values():
            per[s] += 1
        out_tables = {}
        for tid_, n in per.items():
            occ = n > 0
            if occ:
                self.occ_sec[tid_] += dt
                if self.since[tid_] is None:
                    self.since[tid_] = now
            else:
                self.since[tid_] = None
            out_tables[tid_] = {"occupied": occ, "occupants": n, "occupiedSec": round(self.occ_sec[tid_], 2),
                                "sinceSec": None if self.since[tid_] is None else round(now - self.since[tid_], 2)}
        return {"seats": seats, "occupied": sorted(k for k, v in per.items() if v), "occupantCount": len(seats),
                "tables": out_tables}


def baseline_params():
    """기준선(T-046d)과 같은 동작: 정지 판정·유지·가림 거르기 없음."""
    return {"dwell_sec": 0.0, "move_thr": float("inf"), "hold_sec": 0.0, "inherit_dist": -1.0, "occluder_frac": 0.0}

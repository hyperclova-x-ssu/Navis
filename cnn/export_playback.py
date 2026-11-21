"""탐지 화면용 미리 계산: Café 17번 클립 354~403 -> 영상(cafe17.mp4) + 상자·숫자(cafe17-detections.json)
실행: .venv/bin/python export_playback.py   (결과: ../frontend/public/cnn/)"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import torch
from ultralytics import YOLO

from common import CLIP_FROM, CLIP_TO, DATA, VIDEO, box_center, frame_index, point_in_polygon
from run_sample import COCO, IMGSZ, MODEL
import smooth

HERE = Path(__file__).parent
OUT = HERE.parent / "frontend" / "public" / "cnn"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
W, H = 960, 540
FPS = 5  # cafe17.mp4 의 r_frame_rate 5/1 (프레임 i = i/5초)
CLEAR_SEC = 3.0  # 사람 없음 + 컵 있음이 이만큼 이어지면 치울 테이블
CUP_GAP_FRAMES = 5  # 컵이 1초 안에 잠깐 안 잡혀도 이어진 것으로 봄(탐지 깜빡임 보정)
CRF = 30


def r3(v):
    return round(float(v), 3)


def encode_only():
    """영상만 다시 만들기(탐지 json은 그대로): python export_playback.py --video-only"""
    OUT.mkdir(parents=True, exist_ok=True)
    paths = []
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        paths += [p for _, p in frame_index(DATA / "Dataset/cafe/17" / str(clip))]
    ff = subprocess.Popen([FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                           "-s", f"{W}x{H}", "-framerate", str(FPS), "-i", "-", "-an", "-c:v", "libx264",
                           "-preset", "medium", "-crf", str(CRF), "-pix_fmt", "yuv420p", "-g", "10",
                           "-movflags", "+faststart", str(OUT / "cafe17.mp4")], stdin=subprocess.PIPE)
    for p in paths:
        ff.stdin.write(cv2.resize(cv2.imread(str(p)), (W, H), interpolation=cv2.INTER_AREA).tobytes())
    ff.stdin.close()
    ff.wait()
    print("frames", len(paths), "ffmpeg rc", ff.returncode)


START_GRACE = 10  # 첫 점유가 영상 시작 후 이 프레임(2초) 안이면 처음부터 점유로 봄
BASE_PX = 70  # 기준선 컵과 이 거리(1920x1080 픽셀) 안이면 같은 컵(비품)으로 봄


def baseline_cups(frames, tables, frames_c):
    """T-046d: 구역별 기준선 = 첫 점유(사람 앉음) 전에 구역 안에 있던 컵 위치. 한 번도 점유 안 된 구역은 영상 전체가 기준선.
    -> {table: {"first": 첫 점유 프레임(없으면 None), "pts": [(x,y)...]}}"""
    out = {}
    for t in tables:
        tid = t["id"]
        first = next((i for i, f in enumerate(frames) if any(p[5] == tid for p in f["persons"])), None)
        if first is not None and first <= START_GRACE:  # 영상 시작부터 손님이 있던 구역: 그 컵은 손님 컵이므로 기준선 없음
            out[tid] = {"first": 0, "pts": []}
            continue
        end = len(frames) if first is None else first
        pts = [(box_center(c)[0] * 1920, box_center(c)[1] * 1080) for cs in frames_c[:end] for c in cs
               if point_in_polygon(box_center(c), t["polygon"])]
        out[tid] = {"first": first, "pts": pts}
    return out


def is_new_cup(c, b, i):
    """첫 점유 이전엔 전부 기준선(새 컵 아님). 점유 시작 뒤에는 기준선 컵 위치와 BASE_PX 이내면 비품, 아니면 새 컵."""
    if b["first"] is None or i < b["first"]:
        return False
    cx, cy = box_center(c)
    return not any(((cx * 1920 - x) ** 2 + (cy * 1080 - y) ** 2) ** 0.5 <= BASE_PX for x, y in b["pts"])


def analyze(frames, tables, supply=()):
    """frames(persons·cups)로 counts 와 치울 테이블 이벤트를 계산(모델 없이 json에서도 다시 계산 가능).
    조건 = 구역에 사람 없음 + cup 있음(1초 안 끊김은 이어진 것으로 봄). 조건이 연속 3초 이상이면 치울 테이블:
    조건 연속 3초 확인 시점부터 표시하고, 표시 중 조건이 연속 3초 끊기면 숨긴다(3초 안에 다시 성립하면 계속 표시).
    이벤트 {table, fromT(조건 시작), shownT(표시 시작), toT(조건 마지막 성립), hiddenT(끊김 3초 확인=숨김)}."""
    n = len(frames)
    need = round(CLEAR_SEC * FPS)
    if supply:  # 비품 구역 안 컵은 판정에서 제외(복사본 사용: json 의 cups 는 그대로)
        frames_c = [[c for c in f["cups"] if not any(point_in_polygon(box_center(c), s) for s in supply)] for f in frames]
    else:
        frames_c = [f["cups"] for f in frames]
    base = baseline_cups(frames, tables, frames_c)
    cond = {t["id"]: [False] * n for t in tables}
    occ_frames = {t["id"]: 0 for t in tables}
    gap = {t["id"]: 0 for t in tables}
    run = {t["id"]: 0 for t in tables}
    for i, f in enumerate(frames):
        occupied = []
        for t in tables:
            tid = t["id"]
            has_p = any(p[5] == tid for p in f["persons"])
            cup = any(point_in_polygon(box_center(c), t["polygon"]) and is_new_cup(c, base[tid], i)
                      for c in frames_c[i])
            gap[tid] = 0 if cup else gap[tid] + 1
            cup_on = gap[tid] <= CUP_GAP_FRAMES and (cup or run[tid] > 0)
            run[tid] = run[tid] + 1 if (not has_p and cup_on) else 0
            cond[tid][i] = run[tid] > 0
            if has_p:
                occupied.append(tid)
                occ_frames[tid] += 1
        f["counts"] = {"inStore": len(f["persons"]), "seated": sum(1 for p in f["persons"] if p[5]),
                       "occupiedTables": occupied, "tablesToClear": []}
    events = []
    for tid, fl in cond.items():
        shown = False
        start = last = hid = 0  # start=연속 조건 시작, last=조건 마지막 성립, hid=끊김 연속 길이
        ev = None
        for i in range(n):
            if fl[i]:
                if not shown:
                    start = i if (i == 0 or not fl[i - 1]) else start
                    if i - start >= need:
                        shown = True
                        ev = {"table": tid, "fromT": r3(start / FPS), "shownT": r3(i / FPS)}
                last, hid = i, 0
            elif shown:
                hid += 1
                if hid >= need:
                    ev["toT"], ev["hiddenT"] = r3(last / FPS), r3(i / FPS)
                    events.append(ev)
                    shown = False
            if shown:
                frames[i]["counts"]["tablesToClear"].append(tid)
        if shown:  # 영상 끝까지 표시 중
            ev["toT"], ev["hiddenT"] = r3(last / FPS), r3((n - 1 + need - hid) / FPS)  # 영상이 끝나 못 채운 끊김 확인분은 가정치
            events.append(ev)
    events.sort(key=lambda e: e["fromT"])
    return events, occ_frames


def assign_seats(raw_persons, tables, foot_frac, w=1, h=1):
    """앉음 판정: 상자 위에서 foot_frac 지점(아래쪽·엉덩이 근처)이 구역 안 + 상자 높이 <= maxBoxH(서 있는 사람 제외).
    persons 는 [0..1] 좌표, tables.polygon 도 [0..1]. maxBoxH 는 1080 기준 픽셀."""
    out = []
    for pers in raw_persons:
        row = []
        for p in pers:
            pt = ((p[0] + p[2]) / 2, p[1] + (p[3] - p[1]) * foot_frac)
            seat = next((t["id"] for t in tables if (p[3] - p[1]) * 1080 <= t["maxBoxH"]
                         and p[1] >= t.get("minBoxTop", 0) and point_in_polygon(pt, t["polygon"])), None)
            row.append(p[:5] + [seat])
        out.append(row)
    return out


OBJ_PATH = HERE / "results" / "cafe17_raw_objects.json"  # detect_objects.py 결과(클래스 번호 포함)
CUP_CLASSES = {40, 41, 45}  # wine glass, cup, bowl. chair·dining table·bottle 은 cups 에 넣지 않음


RAW_PATH = HERE / "results" / "cafe17_raw_persons.json"  # 확인 전 원본 사람 상자(추적 번호 포함). --recompute 의 입력


def finalize_frames(d, raw_persons, cfg):
    """확인된 추적만 남기고 프레임별 판정·칼만 필터·집계를 적용한다."""
    n = len(raw_persons)
    sx, sy = cfg["image_size"]
    d["tables"] = [{"id": t["id"], "name": t["name"], "polygon": [[r3(x / sx), r3(y / sy)] for x, y in t["polygon"]]}
                   for t in cfg["tables"]]
    seat_tables = [dict(table, maxBoxH=zone["maxBoxH"], minBoxTop=zone.get("minBoxTop", 0) / sy)
                   for table, zone in zip(d["tables"], cfg["tables"])]
    raw_persons = assign_seats(raw_persons, seat_tables, cfg.get("footFrac", 0.5))
    for i, (f, pers) in enumerate(zip(d["frames"], raw_persons)):
        f["t"] = r3(i / FPS)
        f["persons"] = pers
    kept = smooth.confirm_tracks(raw_persons, smooth.MIN_TRACK_FRAMES)
    for f, pers in zip(d["frames"], kept):
        f["persons"] = pers
    events, occ = analyze(d["frames"], d["tables"],
                           [[[r3(x / sx), r3(y / sy)] for x, y in s["polygon"]] for s in cfg.get("supply", [])])  # 확인된 추적 기준으로 counts·치울 테이블 계산
    raw_in = [f["counts"]["inStore"] for f in d["frames"]]
    raw_seat = [f["counts"]["seated"] for f in d["frames"]]
    sm_in = [int(round(v)) for v in smooth.kalman(raw_in)]
    sm_seat = [int(round(v)) for v in smooth.kalman(raw_seat)]
    for f, ri, rs, si, ss in zip(d["frames"], raw_in, raw_seat, sm_in, sm_seat):
        c = f["counts"]
        c["inStoreRaw"], c["seatedRaw"], c["inStore"], c["seated"] = ri, rs, si, ss
    d["fps"] = FPS
    d["summary"] = {"avgInStore": round(sum(sm_in) / n, 2), "maxInStore": max(sm_in),
                    "tableOccupiedSeconds": {k: round(v / FPS, 1) for k, v in occ.items()},
                    "tablesToClearEvents": events,
                    "smoothing": {"minTrackFrames": smooth.MIN_TRACK_FRAMES,
                                  "kalman": {"q": smooth.KALMAN_Q, "r": smooth.KALMAN_R}}}
    return raw_in, raw_seat, sm_in, sm_seat


def finalize(d, raw_persons):
    """Café 원본 상자에서 프레임을 완성하고 Café 정답에 비교한다."""
    cfg = json.loads((HERE / "zones" / "cafe17_tables.json").read_text())
    if OBJ_PATH.exists():  # T-046d: 먹고 마신 그릇(cup·wine glass·bowl)만 cups 로
        for f, objs in zip(d["frames"], json.loads(OBJ_PATH.read_text())):
            f["cups"] = [o[:4] for o in objs if o[4] in CUP_CLASSES]
    raw_in, raw_seat, sm_in, sm_seat = finalize_frames(d, raw_persons, cfg)
    gt_in, _old_seat = smooth.ground_truth()
    truth = smooth.seated_truth(cfg["tables"], cfg.get("footFrac", 0.8))  # T-046c: 테이블 구역 기준 정답
    gt_seat = smooth.seated_gt_counts(truth, "exclude")  # 기본 비교 = 무리 밖(outlier) 제외
    gt_seat_inc = smooth.seated_gt_counts(truth, "include")
    tids = [t["id"] for t in cfg["tables"]]
    seat_rows = [{t: sum(1 for p in f["persons"] if p[5] == t) for t in tids} for f in d["frames"]]
    ev = smooth.evaluate(raw_in, raw_seat, sm_in, sm_seat, FPS, gt_in, gt_seat)
    d["summary"]["smoothing"]["evaluation"] = ev
    ev["seatedTable"] = {
        "definition": "정답 앉은 사람 = 정답 상자 위 80% 지점이 테이블 구역 안 + 행동 Eating/Drinking·Working/Studying·TakingSelfie. outlier 는 포함/제외 두 경우",
        "occupancy": smooth.table_scores([f["counts"]["occupiedTables"] for f in d["frames"]], seat_rows, truth, tids),
        "seatedCount": {"excludeOutlier": {"raw": smooth.score(raw_seat, gt_seat), "smoothed": smooth.score(sm_seat, gt_seat)},
                        "includeOutlier": {"raw": smooth.score(raw_seat, gt_seat_inc), "smoothed": smooth.score(sm_seat, gt_seat_inc)}}}


def recompute():
    """모델 없이 results/cafe17_raw_persons.json 의 원본 상자로 확인·판정·칼만·비교를 다시: python export_playback.py --recompute"""
    path = OUT / "cafe17-detections.json"
    d = json.loads(path.read_text())
    if not RAW_PATH.exists():  # 처음 한 번: 아직 확인 전인 json 의 persons 를 원본으로 보관
        if "smoothing" in d.get("summary", {}):
            raise SystemExit("원본 상자 파일이 없고 json 은 이미 확인된 추적만 담고 있음: 전체 export 를 다시 실행하세요")
        RAW_PATH.write_text(json.dumps([f["persons"] for f in d["frames"]], separators=(",", ":")))
    finalize(d, json.loads(RAW_PATH.read_text()))
    path.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps(d["summary"], ensure_ascii=False))


def main():
    if "--recompute" in sys.argv:
        return recompute()
    if "--video-only" in sys.argv:
        return encode_only()
    cfg = json.loads((HERE / "zones" / "cafe17_tables.json").read_text())
    tables = cfg["tables"]
    sx, sy = cfg["image_size"]
    OUT.mkdir(parents=True, exist_ok=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = YOLO(str(MODEL))
    kw = dict(persist=True, tracker="bytetrack.yaml", classes=[COCO["person"], 40, 41, 45], conf=0.25,
              imgsz=IMGSZ, device=device, verbose=False)
    paths = []
    for clip in range(CLIP_FROM, CLIP_TO + 1):
        paths += [p for _, p in frame_index(DATA / "Dataset/cafe/17" / str(clip))]
    model.track(cv2.imread(str(paths[0])), **kw)  # 예열
    model.predictor.trackers[0].reset()

    ff = subprocess.Popen([FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                           "-s", f"{W}x{H}", "-framerate", str(FPS), "-i", "-", "-an", "-c:v", "libx264",
                           "-preset", "medium", "-crf", str(CRF), "-pix_fmt", "yuv420p", "-g", "10",
                           "-movflags", "+faststart", str(OUT / "cafe17.mp4")], stdin=subprocess.PIPE)
    frames = []
    for i, path in enumerate(paths):
        img = cv2.imread(str(path))
        res = model.track(img, **kw)[0]
        ff.stdin.write(cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA).tobytes())
        persons, cups = [], []
        ids = res.boxes.id.tolist() if res.boxes.id is not None else [None] * len(res.boxes)
        for b, cls, tid in zip(res.boxes.xyxy.tolist(), res.boxes.cls.tolist(), ids):
            box = [r3(b[0] / sx), r3(b[1] / sy), r3(b[2] / sx), r3(b[3] / sy)]
            if int(cls) == COCO["person"]:
                persons.append(box + [int(tid) if tid is not None else -1, None])  # 앉음은 finalize 의 assign_seats 가 정함
            else:
                cups.append((box, box_center(b)))
        frames.append({"t": r3(i / FPS), "persons": persons, "cups": [b for b, _ in cups]})
        if i % 200 == 0:
            print(i, len(paths), flush=True)
    ff.stdin.close()
    ff.wait()

    out = {"source": "Café dataset (Kim et al., ECCV 2024), video 17 clips 354-403",
           "fps": FPS, "frameCount": len(frames), "width": W, "height": H,
           "tables": [{"id": t["id"], "name": t["name"],
                       "polygon": [[r3(x / sx), r3(y / sy)] for x, y in t["polygon"]]} for t in tables],
           "frames": frames}
    # analyze 는 [0..1] 좌표 구역을 쓴다(위 tables 와 동일)
    raw_persons = [f["persons"] for f in frames]
    RAW_PATH.parent.mkdir(exist_ok=True)
    RAW_PATH.write_text(json.dumps(raw_persons, separators=(",", ":")))
    finalize(out, raw_persons)
    (OUT / "cafe17-detections.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(json.dumps(out["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()

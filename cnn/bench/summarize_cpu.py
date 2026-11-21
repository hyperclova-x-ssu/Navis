"""results/cpu_rows.jsonl(설정마다 한 줄씩 쌓임) -> results/cpu.json 과 README 용 표(마크다운) 출력.  실행(Mac): python3 summarize_cpu.py
- 같은 설정이 여러 번이면: 정확도·상자는 마지막 줄(원본 상자 *_raw.json 과 같은 실행), 시간은 가장 빠른 줄
  (04:04~04:12 KST 에 다른 코어에서 INT8 변환을 돌려 yolo11n 960·1280 다시 재기 두 줄의 시간이 부풀었음. 상자는 영향 없음).
- 속도 판정(D-373, 1.5배 여유): 휴대폰 15장/초, 한 장 CPU 시간 <= 44.4ms (= 66.7ms x 2/3).
  한 장 비용(추정) = 1280x720 디코딩 + (탐지+추적+뒤처리) / k + 사이 장 상자 예측(~0).
  k = 15 / 초당 탐지 횟수. 이 영상(5장/초)의 간격 N=1 -> 초당 5번(k=3), N=2 -> 2.5번(k=6), N=3 -> 1.67번(k=9).
  그리고 탐지 한 번(p95)이 다음 탐지 전에 끝나야 함(<= k x 66.7ms).
- 정확도: 새 판정·새 정의(T-065b, D-376·D-378) = occupancy/results/eval_weakpc.json(그 작업 결과, 읽기만)
  + results/occupancy_eval.json(eval_occupancy.py, INT8 등 이 작업이 더 잰 설정). 허용선: 손님 수 <= 7.3%,
  점유(포함·제외) >= 91.4%, 머문 인원 오차(포함) <= 26.6%. 옛 정의(T-046d) 숫자는 bench_cpu 가 잰 것을 나란히."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = HERE / "results"
FRAME_MS = 1000 / 15
BUDGET_MS = FRAME_MS * 2 / 3  # 44.4
LIMIT = {"inStore": 0.073, "occ": 0.914, "occupants": 0.266}
EVALS = [HERE.parent / "occupancy" / "results" / "eval_weakpc.json", R / "occupancy_eval.json"]


def decode_720_ms():
    d = json.loads((R / "pipeline.json").read_text())
    return max(r["times"]["decode"]["mean_ms"] for r in d["rows"] if r["source"].startswith("clip354") and "times" in r)


def new_def():
    out = {}
    for p in EVALS:
        if p.exists():
            for r in json.loads(p.read_text())["rows"]:
                out[r["config"]] = r["perConfig"]
    return out


def main():
    dec720 = decode_720_ms()
    nd = new_def()
    groups = {}
    for line in (R / "cpu_rows.jsonl").read_text().splitlines():
        r = json.loads(line)
        groups.setdefault((r["mode"], r["model"], r["runtime"], r["imgsz"], r.get("interval", 1)), []).append(r)
    lat, pipe, ref = [], [], None
    for k, rs in groups.items():
        if k[0] == "latency":
            lat.append(min(rs, key=lambda r: r.get("mean_ms", 1e9)))
        elif k[0] == "reference":
            ref = rs[-1]["accuracy"]
        else:
            ok = [r for r in rs if "times" in r and "occupancy" in r.get("accuracy", {})]
            if ok:
                last = dict(ok[-1])
                last["times"] = min(ok, key=lambda r: r["times"]["detect_track"]["mean_ms"])["times"]
                pipe.append(last)

    print("측정 1-CPU: 탐지 1장(1280x720 입력, predict 1회)\n")
    print("| 모델 | 실행기 | 입력 | 평균 ms | p95 ms | 초당 장수 | 메모리 최대 MiB |\n| :-- | :-- | --: | --: | --: | --: | --: |")
    for r in sorted(lat, key=lambda r: (r["model"], r["runtime"], r["imgsz"])):
        print(f"| {r['model']} | {r['runtime']} | {r['imgsz']} | {r['mean_ms']} | {r['p95_ms']} | {r['fps']} | {r['peakRssMiB']} |")

    verdict = []
    print("\n측정 2-CPU: 전체 파이프라인(cafe17.mp4 1,718장) + 정확도\n")
    print("| 설정 | 초당 탐지 | 탐지+추적 ms 평균/p95 | 한 장 비용 ms(15fps, 추정) | 속도 | 손님 수 | 점유 포함/제외 | 머문 인원 | 정확도(새 정의) | 옛 정의 점유 포함 | 메모리 MiB |")
    print("| :-- | --: | --: | --: | :-- | --: | --: | --: | :-- | --: | --: |")
    print(f"| 기준선 yolo11s·1280 GPU(mps, 1920 원본) | 5 | - | - | - | 5.3% | 94.4% / 93.7% | 23.6% | 기준 | {ref['occupancy']['include']:.1%} | - |")
    for r in sorted(pipe, key=lambda r: (r["model"], r["runtime"], r["imgsz"], r["interval"])):
        t, n = r["times"], r["interval"]
        k = 3 * n
        det = t["detect_track"]
        cost = dec720 + (det["mean_ms"] + t["post"]["mean_ms"]) / k
        speed = cost <= BUDGET_MS and det["p95_ms"] + dec720 <= k * FRAME_MS
        tag = f"{r['model']}_{r['runtime']}_{r['imgsz']}_N{n}"
        new = nd.get(tag, {}).get("occupied")
        if new:
            acc = (new["inStore"] <= LIMIT["inStore"] and min(new["occInclude"], new["occExclude"]) >= LIMIT["occ"]
                   and new["occupantsInclude"] <= LIMIT["occupants"])
            ntxt = f"{new['inStore']:.1%} | {new['occInclude']:.1%} / {new['occExclude']:.1%} | {new['occupantsInclude']:.1%} | {'통과' if acc else '탈락'}"
        else:
            acc, ntxt = None, "- | - | - | 미평가"
        verdict.append({"config": tag, "detectionsPerSec": round(5 / n, 2), "costMsAt15fps": round(cost, 1), "speedOK": speed,
                        "accuracyNewDefOK": acc, "newDef": new, "oldDef": r["accuracy"], "peakRssMiB": r["peakRssMiB"],
                        "detectTrack": det})
        print(f"| {r['model']}·{r['imgsz']} {r['runtime']} | {5 / n:.2g} | {det['mean_ms']} / {det['p95_ms']} | {cost:.1f} | "
              f"{'통과' if speed else '초과'} | {ntxt} | {r['accuracy']['occupancy']['include']:.1%} | {r['peakRssMiB']} |")
    both = [v for v in verdict if v["speedOK"] and v["accuracyNewDefOK"]]
    print("\n둘 다 통과:", [v["config"] for v in both])
    (R / "cpu.json").write_text(json.dumps({"budgetMsPerFrame": round(BUDGET_MS, 1), "decode720ms": dec720, "limitsNewDef": LIMIT,
                                            "baselineOldDef": ref, "latency": lat, "pipeline": pipe, "verdict": verdict,
                                            "passBoth": [v["config"] for v in both]}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()

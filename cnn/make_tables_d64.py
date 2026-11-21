"""T-046d: zones/cafe17_tables.json 다시 쓰기 — 그림 보며 정한 좌표(점검용 화면 1440x810 기준 -> x1/0.75 = 1920x1080).
실행: .venv/bin/python make_tables_d64.py"""
import json
from pathlib import Path

K = 1 / 0.75


def px(pts):
    return [[round(x * K), round(y * K)] for x, y in pts]


TABLES = [
    ("t1", "창가 부스 긴 테이블", px([(250, 300), (545, 290), (555, 425), (280, 432)])),
    ("t2", "앞쪽 왼쪽 테이블(기둥 다리)", px([(265, 405), (545, 440), (535, 525), (430, 565), (270, 650)])),
    ("t3", "가운데 작은 테이블", px([(600, 330), (880, 322), (885, 455), (610, 462)])),
    ("t4", "긴 테이블 안쪽(창고 쪽) 자리", px([(888, 330), (1010, 300), (1130, 350), (1112, 480), (1088, 565), (950, 565), (892, 480)])),
]
SUPPLY = [("s1", "긴 테이블 끝 비품(종이컵 더미·음료병·과자) — 판정 제외", px([(770, 530), (1090, 520), (1100, 690), (1040, 790), (900, 800), (660, 700)]))]

if __name__ == "__main__":
    p = Path(__file__).parent / "zones" / "cafe17_tables.json"
    old = json.loads(p.read_text())
    out = {"note": "T-046d: 장면 직접 보고 다시 그린 테이블 윗면+앉는 자리 구역(1920x1080). supply = 매장 비품이 늘 놓인 곳(손님 테이블 아님, 판정 제외). 앉음 = 상자 위에서 footFrac 지점이 구역 안 + 상자 높이 <= maxBoxH.",
           "image_size": old["image_size"], "footFrac": old["footFrac"],
           "tables": [{"id": i, "name": n, "maxBoxH": 350, "polygon": poly} for i, n, poly in TABLES],
           "supply": [{"id": i, "name": n, "polygon": poly} for i, n, poly in SUPPLY]}
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1))

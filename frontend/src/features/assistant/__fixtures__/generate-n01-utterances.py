"""Regenerate N00/N01 parser fixtures from the scenario trace and authored tools."""
import csv
import json
import re
from pathlib import Path

here = Path(__file__).resolve().parent
corpus = here.parents[4] / ".evidence" / "navis-scenarios"
with (corpus / "TRACE.csv").open(encoding="utf-8") as source:
    slices = {row["scenario_id"]: row["slice_id"] for row in csv.DictReader(source)}
scenarios = json.loads((corpus / "MERGED.json").read_text(encoding="utf-8"))

# Slot references have no wire value. These four result-state strings give the
# local price explicitly. Validation (including rejection of zero) is separate.
price_slots = {
    "S1-021": r"price (\d+)",
    "S1-023": r"/ dessert / (\d+)",
    "S1-025": r"/ drink / (\d+)",
    "S1-031": r"/ drink / (\d+)",
}
errata = {
    "S4-160": {1: "No event date is stated", 3: "No event date is stated", 4: "No event date is stated"},
    "S6-185": {2: "No reporting month is stated", 3: "No reporting month is stated"},
    "S8-152": {
        1: "요즘 leaves the period unspecified",
        2: "No reporting period is stated",
        3: "No reporting period is stated",
    },
}

def assertions(tool, args, scenario, path=()):
    for key, value in args.items():
        location = (*path, key)
        if key == "condition" and isinstance(value, dict) and value.get("kind") in ("snapshot", "dateRange"):
            yield {"category": "date", "parser": "readCondition", "featureId": args["featureId"], "expected": value}
        elif key == "price" and value == {"slot": "price"}:
            match = re.search(price_slots[scenario["id"]], scenario["expected"]["result_state"])
            yield {"category": "money", "parser": "menuPrice", "expected": int(match[1])}
        elif key in ("price", "amount", "hourlyWage") and type(value) in (int, float):
            yield {"category": "money", "parser": "menuPrice" if tool == "propose_action" and args.get("name") else "money", "expected": value}
        elif key in ("qty", "quantity", "stock", "threshold") and type(value) in (int, float):
            yield {"category": "quantity", "parser": "quantity", "expected": value}
        elif key == "unit" and isinstance(value, str):
            yield {"category": "unit", "parser": "unit", "expected": value}
        elif type(value) in (int, float):
            yield {"category": "number", "parser": "number", "expected": value}
        elif isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\d", value):
            yield {"category": "date", "parser": "draftDate" if scenario["id"] == "S4-210" else "date", "field": ".".join(location), "expected": value}
        elif isinstance(value, str) and re.fullmatch(r"\d\d:\d\d", value):
            yield {"category": "time", "parser": "time", "expected": value}
        elif isinstance(value, dict):
            yield from assertions(tool, value, scenario, location)

fixtures = []
for scenario in scenarios:
    sid = scenario["id"]
    if slices.get(sid) not in ("N00", "N01"):
        continue
    checks = [
        check
        for tool in scenario["expected"]["tools"]
        for check in assertions(tool["name"], tool.get("args", {}), scenario)
    ]
    if checks:
        fixtures.append({
            "id": sid,
            "slice": slices[sid],
            "utterances": scenario["utterances"],
            "checks": checks,
            **({"errata": errata[sid]} if sid in errata else {}),
        })

(here / "n01-utterances.json").write_text(
    json.dumps(fixtures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)

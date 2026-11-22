import csv
import json
from pathlib import Path
import subprocess

app = Path(__file__).resolve().parents[3]
evidence = app.parent / ".evidence/navis-scenarios"
with (evidence / "TRACE.csv").open() as trace:
    ids = [row["scenario_id"] for row in csv.DictReader(trace)
           if row["widget"] in {"layout", "settings"} or row["slice_id"] in {"N07", "N08"}
           or {"N07", "N08"}.intersection(row["required_slices"].split("|"))]
with (evidence / "A3-manifest.jsonl").open() as manifest:
    next(manifest)
    known = {json.loads(line)["id"] for line in manifest}
if missing := set(ids) - known:
    print(f"TRACE-only IDs replayed from the corpus: {sorted(missing)}", flush=True)
print(f"Selected {len(ids)} account/layout/settings IDs", flush=True)
result = subprocess.run(
    ["node", "server/dev/navis-scenario-eval.mjs", "--fake", "--output-prefix", "A3-R1B00", *ids],
    cwd=app,
)
raise SystemExit(result.returncode)

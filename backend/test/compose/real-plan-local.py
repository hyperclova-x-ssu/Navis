"""Create an isolated Compose definition and disposable credentials for the R1 account proof."""

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

backend = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--project", default="navis-r1-b00-proof")
parser.add_argument("--port", type=int, default=18280)
parser.add_argument("--replay-instant", help="Pin business and provider clocks in this disposable Compose project")
parser.add_argument("--gate-seed", action="store_true", help="Enable the seeded café's review-gate community pairing")
options = parser.parse_args()
if options.replay_instant:
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})", options.replay_instant):
            raise ValueError()
        datetime.fromisoformat(options.replay_instant)
    except ValueError:
        parser.error("--replay-instant must be a timezone-qualified ISO timestamp")
project = options.project
origin = f"http://127.0.0.1:{options.port}"
scratch = Path(tempfile.mkdtemp(prefix=project + "."))
os.environ.update(
    NAVIS_BROWSER_API_ORIGIN=origin,
    NAVIS_BACKEND_DEMO_AUTH="0",
    NAVIS_HOSTED_DEMO_AUTH="0",
    NAVIS_PHASE3_FIXTURES="0",
    NAVIS_POS_FIXTURE_NOW="",
    VITE_NAVIS_DATA_SOURCE="http",
)
config = json.loads(subprocess.check_output(
    ["docker", "compose", "--env-file", "/dev/null", "--profile", "*", "config", "--format", "json"], cwd=backend,
))
local_generator = scratch / "infra/local-secrets.sh"
local_generator.parent.mkdir()
shutil.copy(backend / "infra/local-secrets.sh", local_generator)
subprocess.run(["sh", str(local_generator)], check=True)
for details in config["secrets"].values():
    source = Path(details["file"])
    if source.is_relative_to(backend / ".secrets"):
        details["file"] = str(scratch / source.relative_to(backend))

for service in config["services"].values():
    for volume in service.get("volumes", []):
        source = volume.get("source", "")
        if source.startswith(str(backend / ".secrets")):
            volume["source"] = str(scratch / Path(source).relative_to(backend))
config["services"]["edge"]["ports"][0]["published"] = str(options.port)
if options.gate_seed:
    config["services"]["account"]["environment"]["NAVIS_ACCOUNT_COMMUNITY_PAIRS"] = json.dumps([
        ["c05409a6-f082-5964-a787-c1ed3184988b", "33123a19-6780-4d38-9bca-ce96efcf8559"],
    ])
tools = config["services"]["tools"]
tools["networks"]["api"] = None
tools["secrets"].append({"source": "account_run_password", "target": "account_run_password"})
tools["environment"]["NAVIS_ACCOUNT_TEST_ORIGIN"] = origin
tools["environment"]["NAVIS_ACCOUNT_TEST_EDGE"] = "http://edge"
if options.replay_instant:
    replay = {"NAVIS_REPLAY_DISPOSABLE": "1", "NAVIS_REPLAY_INSTANT": options.replay_instant}
    for name in ("customer", "inventory", "pos", "insight", "marketing", "marketing-worker", "naver-virtual"):
        config["services"][name]["environment"].update(replay)
    config["services"]["account"]["environment"].update(replay, NAVIS_BACKEND_DEMO_AUTH="1")
    config["services"]["edge"]["ports"][0]["host_ip"] = "127.0.0.1"
    tools["networks"]["naver-virtual-data"] = None
    tools["secrets"].append({"source": "nvirtual_mig_password", "target": "nvirtual_mig_password"})
    tools["environment"].update(replay, NAVIS_DISPOSABLE_REPLAY_SEED="1", NAVIS_NAVER_VIRTUAL_SEED_INSTANT=options.replay_instant)
    config["services"]["naver-virtual-tools"]["environment"]["NAVIS_NAVER_VIRTUAL_SEED_INSTANT"] = options.replay_instant
    config["services"]["frontend"]["build"]["args"]["VITE_NAVIS_REPLAY_INSTANT"] = options.replay_instant
config["name"] = project
for name, volume in config["volumes"].items():
    volume["name"] = f"{project}_{name}"
for name, network in config["networks"].items():
    network["name"] = f"{project}_{name}"
config["services"]["streams-test-db"].get("ports", []).clear()
compose = scratch / "compose.json"
compose.write_text(json.dumps(config))
print(compose)

"""pytest setup for cnn/live/tests: import path (live/ and live/vendor/) and the gpu marker.

Run: venv/bin/python -m pytest -q app/tests         (gpu-server, everything)
     python -m pytest -q tests -m "not gpu"          (Mac, from cnn/live)
"""
import os
import sys

LIVE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for p in (LIVE, os.path.join(LIVE, "vendor")):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("CNN_NO_DEFAULT_APP", "1")  # importing server.py must not build the real app


def pytest_configure(config):
    config.addinivalue_line("markers", "gpu: needs gpu-server models/GPU or real model files (skip on Mac with -m 'not gpu')")

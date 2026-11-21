import json
import os
import struct
import threading
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import contracts as C
import zones as Z
from config import Config
from fakes import FakeDetector, FakeEngine
from server import Viewer, create_app

GOOD = "http://localhost:5173"
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 200 + b"\xff\xd9"


def cfg(tmp_path, **kw):
    base = dict(data_dir=tmp_path, model_dir=tmp_path, public_url="https://gpu-server.example.ts.net:8443",
                allowed_origins=(GOOD,), fake_detector=False, detect_hz=5.0, detect_plan="full")
    base.update(kw)
    return Config(**base)


@pytest.fixture
def parts(tmp_path):
    return {"detector": FakeDetector(), "engine": FakeEngine(), "store": Z.FileZoneStore(str(tmp_path / "zones.json"))}


@pytest.fixture
def client(tmp_path, parts):
    app = create_app(cfg(tmp_path), **parts)
    with TestClient(app) as c:
        wait(lambda: app.state.hub.ready)
        c.hub = app.state.hub
        c.parts = parts
        yield c


def wait(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    raise AssertionError("condition not met")


def frame_msg(frame_id, capture_t=None, w=1280, h=720, jpeg=JPEG):
    hdr = {"frameId": frame_id, "captureT": time.monotonic() if capture_t is None else capture_t, "w": w, "h": h}
    return C.pack_frame(hdr, jpeg)


def pair(client, **body):
    r = client.post("/api/pair", json={"lang": "ko", **body}, headers={"Origin": GOOD})
    assert r.status_code == 200, r.text
    return r.json()["code"]


def recv_type(ws, kind, n=20):
    for _ in range(n):
        m = json.loads(ws.receive_text())
        if m["type"] == kind:
            return m
    raise AssertionError(f"no {kind}")


def recv_frame(ws, n=40):
    for _ in range(n):
        msg = ws.receive()
        if msg.get("bytes") is not None:
            return C.unpack_frame(msg["bytes"])
    raise AssertionError("no frame")


def close_code(ws):
    with pytest.raises(WebSocketDisconnect) as e:
        for _ in range(10):
            ws.receive_text()
    return e.value.code


# ------------------------------------------------------------------ API-14

def test_health_shape(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    h = r.json()
    for k in ("ok", "version", "mode", "device", "cpuThreads", "runtime", "model", "imgsz", "detectHz",
              "boxPredict", "detectPlan", "rssMb", "camera", "zonesRevision", "stats"):
        assert k in h, k
    assert h["ok"] is True and h["mode"] == "weak" and h["camera"] == "none" and h["rssMb"] > 0
    assert set(h["stats"]) == {"fps", "inferMsP50", "inferMsP95", "latencyMsP50", "dropped", "viewers"}


# ------------------------------------------------------------------ origin / CORS / limits

def test_bad_origin_http_403_and_cors_for_allowed(client):
    r = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "BAD_ORIGIN"
    r = client.get("/api/health", headers={"Origin": GOOD})
    assert r.headers["access-control-allow-origin"] == GOOD
    r = client.options("/api/zones", headers={"Origin": GOOD, "Access-Control-Request-Method": "PUT"})
    assert r.status_code == 204 and "PUT" in r.headers["access-control-allow-methods"]
    assert client.get("/api/health").status_code == 200  # curl without Origin


def test_bad_origin_view_socket_closed_4403(client):
    with client.websocket_connect("/ws/view", headers={"Origin": "https://evil.example"}) as ws:
        assert close_code(ws) == 4403


def test_body_over_256kb_rejected(client):
    r = client.put("/api/zones", content=b"x" * (C.MAX_HTTP_BODY + 1), headers={"Origin": GOOD})
    assert r.status_code == 413


def test_pair_rate_limit_429(client):
    pair(client)
    pair(client)
    r = client.post("/api/pair", json={}, headers={"Origin": GOOD})
    assert r.status_code == 429 and r.json()["error"]["code"] == "RATE_LIMITED"


def test_pair_check_states(client):
    code = pair(client)
    assert client.get(f"/api/pair/check?c={code}").json() == {"state": "ok"}
    assert client.get("/api/pair/check?c=ZZZZZZ").json() == {"state": "expired"}


def test_camera_page_served(client):
    r = client.get("/cam?c=ABCDEF&lang=ko")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "camera=(self)" in r.headers["permissions-policy"]
    assert client.get("/cam/cam.js").status_code == 200
    assert client.get("/cam/i18n.js").status_code == 200
    assert client.get("/cam/..%2Fserver.py").status_code == 404


# ------------------------------------------------------------------ API-16 / API-17

def test_camera_to_view_frame_roundtrip(client):
    code = pair(client)
    with client.websocket_connect("/ws/view", headers={"Origin": GOOD}) as view:
        assert recv_type(view, "status")["camera"] == "waiting"
        view.send_text(json.dumps({"type": "subscribe", "video": True}))
        with client.websocket_connect(f"/ws/camera?c={code}") as cam:
            hello = recv_type(cam, "hello")
            assert len(hello["sessionToken"]) == 32 and hello["maxInflight"] == 2 and hello["fps"] == 15
            cam.send_bytes(frame_msg(7))
            assert recv_type(cam, "ack")["frameId"] == 7
            header, payload = recv_frame(view)
            assert header["type"] == "frame" and header["frameId"] == 7 and header["detected"] is True
            assert payload == JPEG  # the exact bytes the boxes were computed on
            assert header["w"] == 1280 and header["counts"]["inStore"] == 0
            assert set(header["stats"]) == {"fps", "detectFps", "inferMs", "latencyMs", "dropped"}
            assert header["doneT"] >= header["recvT"] >= header["captureT"] - 0.001
            cam.send_text(json.dumps({"type": "ping", "t": 1.5}))
            assert recv_type(cam, "pong")["t"] == 1.5
            assert client.get("/api/health").json()["camera"] == "live"


def test_view_without_video_gets_empty_payload(client):
    code = pair(client)
    with client.websocket_connect("/ws/view", headers={"Origin": GOOD}) as view:
        view.send_text(json.dumps({"type": "subscribe", "video": False}))
        view.send_text(json.dumps({"type": "ping", "t": 3.0}))
        assert recv_type(view, "pong")["t"] == 3.0  # subscribe processed before frames
        with client.websocket_connect(f"/ws/camera?c={code}") as cam:
            recv_type(cam, "hello")
            cam.send_bytes(frame_msg(1))
            header, payload = recv_frame(view)
            assert header["frameId"] == 1 and payload == b""


def test_bad_code_4401_and_used_code_busy_4409(client):
    with client.websocket_connect("/ws/camera?c=ZZZZZZ") as cam:
        assert close_code(cam) == 4401
    code = pair(client)
    with client.websocket_connect(f"/ws/camera?c={code}") as cam1:
        recv_type(cam1, "hello")
        assert client.get(f"/api/pair/check?c={code}").json() == {"state": "busy"}
        with client.websocket_connect(f"/ws/camera?c={code}") as cam2:
            assert json.loads(cam2.receive_text()) == {"type": "status", "state": "busy"}
            assert close_code(cam2) == 4409
        r = client.post("/api/pair", json={"replace": False}, headers={"Origin": GOOD})
        assert r.status_code == 409 and r.json()["error"]["code"] == "CAMERA_CONNECTED"


def test_replace_closes_old_camera_with_replaced(client):
    code = pair(client)
    with client.websocket_connect(f"/ws/camera?c={code}") as old:
        recv_type(old, "hello")
        assert recv_type(old, "status")["state"] == "ok"
        time.sleep(1.0)  # rate limit window
        code2 = pair(client, replace=True)
        with client.websocket_connect(f"/ws/camera?c={code2}") as new:
            recv_type(new, "hello")
            assert recv_type(old, "status")["state"] == "replaced"
            assert close_code(old) == 4409
        assert client.parts["engine"].resets >= 2  # new camera session resets numbers


def test_same_session_reconnect_with_token(client):
    code = pair(client)
    with client.websocket_connect(f"/ws/camera?c={code}") as cam:
        token = recv_type(cam, "hello")["sessionToken"]
    wait(lambda: not client.hub.pairing.camera_socket_open())
    resets = client.parts["engine"].resets
    with client.websocket_connect(f"/ws/camera?s={token}") as cam:
        assert recv_type(cam, "hello")["sessionToken"] == token
        cam.send_bytes(frame_msg(2))
        recv_type(cam, "ack")
    wait(lambda: client.parts["detector"].resets >= 2)
    assert client.parts["engine"].resets == resets  # same session keeps numbers state
    wait(lambda: client.parts["engine"].track_resets >= 1)
    with client.websocket_connect("/ws/camera?s=" + "x" * 32) as cam:
        assert close_code(cam) == 4401


@pytest.mark.parametrize("payload,code", [
    (b"\x00\x00", 4400),                                                   # too short
    (struct.pack(">I", 999) + b"{}", 4400),                                # bad header length
    (C.pack_frame({"frameId": 1, "captureT": 0, "w": 1280, "h": 720}, b"notjpeg"), 4400),
    (C.pack_frame({"frameId": -1, "captureT": 0, "w": 1280, "h": 720}, JPEG), 4400),
    (C.pack_frame({"frameId": 1, "captureT": 0, "w": 1280, "h": 720}, b"\xff\xd8" + b"\x00" * C.MAX_CAMERA_BINARY), 4413),
])
def test_camera_message_format_and_size(client, payload, code):
    c = pair(client)
    with client.websocket_connect(f"/ws/camera?c={c}") as cam:
        recv_type(cam, "hello")
        cam.send_bytes(payload)
        assert close_code(cam) == code


def test_camera_text_too_big_and_bad_json(client):
    c = pair(client)
    with client.websocket_connect(f"/ws/camera?c={c}") as cam:
        recv_type(cam, "hello")
        cam.send_text("x" * (C.MAX_WS_TEXT + 1))
        assert close_code(cam) == 4413


def test_latest_only_drops_while_worker_is_slow(client):
    det = client.parts["detector"]
    det.gate = threading.Event()
    code = pair(client)
    with client.websocket_connect(f"/ws/camera?c={code}") as cam:
        recv_type(cam, "hello")
        cam.send_bytes(frame_msg(1))
        recv_type(cam, "ack")
        wait(lambda: client.hub._slot is None)  # worker took frame 1 and is blocked in detect
        for i in range(2, 7):
            cam.send_bytes(frame_msg(i))
            recv_type(cam, "ack")
        assert client.hub.dropped == 4  # 2..5 replaced in the one-frame slot
        det.gate.set()
        wait(lambda: client.hub.processed >= 2)
    processed = det.detected_ids + det.predicted_ids
    assert processed == [1, 6]  # the last frame is processed, the stale ones are not


def test_detect_every_third_frame_at_15fps(client):
    det = client.parts["detector"]
    code = pair(client)
    with client.websocket_connect(f"/ws/camera?c={code}") as cam:
        recv_type(cam, "hello")
        t0 = time.monotonic()
        for i in range(9):
            while time.monotonic() < t0 + i / 15:
                time.sleep(0.002)
            cam.send_bytes(frame_msg(i, capture_t=500.0 + (time.monotonic() - t0)))  # phone clock
            recv_type(cam, "ack")
            wait(lambda: client.hub.processed >= i + 1)
    assert det.detected_ids == [0, 3, 6]
    assert det.predicted_ids == [1, 2, 4, 5, 7, 8]


def test_viewer_queue_drops_oldest_beyond_two():
    class WS:
        pass
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        async def run():
            v = Viewer(WS())
            v.push_frame({"frameId": 1}, b"a")
            v.push_frame({"frameId": 2}, b"b")
            v.push_frame({"frameId": 3}, b"c")
            return v
        v = loop.run_until_complete(run())
    finally:
        loop.close()
    assert list(v.pending) == [({"frameId": 2}, b"b"), ({"frameId": 3}, b"c")] and v.dropped == 1


def test_too_many_viewers_4429(client):
    socks = []
    try:
        for _ in range(C.MAX_VIEWERS):
            ws = client.websocket_connect("/ws/view", headers={"Origin": GOOD}).__enter__()
            recv_type(ws, "status")
            socks.append(ws)
        with client.websocket_connect("/ws/view", headers={"Origin": GOOD}) as extra:
            assert close_code(extra) == 4429
    finally:
        for ws in socks:
            ws.__exit__(None, None, None)


# ------------------------------------------------------------------ API-18 routes (thin)

def zone(n, r0):
    mask = [0] * (160 * 90)
    for r in range(r0, r0 + 4):
        for c in range(10, 14):
            mask[r * 160 + c] = 1
    runs, cur, n0 = [], 0, 0
    for v in mask:
        if v == cur:
            n0 += 1
        else:
            runs.append(n0)
            cur, n0 = v, 1
    runs.append(n0)
    return {"id": f"z0000000{n}", "number": n, "source": "drawn", "mask": {"cols": 160, "rows": 90, "runs": runs}}


def test_zones_get_put_retry_conflict_invalid(client):
    h = {"Origin": GOOD}
    assert client.get("/api/zones", headers=h).json() == {"revision": 0, "savedAt": None, "frameAspect": None,
                                                          "zones": []}
    body = {"baseRevision": 0, "frameAspect": 1.778, "zones": [zone(1, 10)]}
    with client.websocket_connect("/ws/view", headers=h) as view:
        r = client.put("/api/zones", json=body, headers=h)
        assert r.status_code == 200 and r.json()["revision"] == 1
        assert recv_type(view, "zones") == {"type": "zones", "revision": 1}
    assert client.put("/api/zones", json=body, headers=h).json()["revision"] == 1  # retry = same result
    r = client.put("/api/zones", json={**body, "zones": [zone(1, 20)]}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "REVISION_CONFLICT"
    assert r.json()["current"]["revision"] == 1
    r = client.put("/api/zones", json={"baseRevision": 1, "frameAspect": 1.778, "zones": [zone(1, 10), zone(1, 30)]},
                   headers=h)
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_ZONES"
    r = client.put("/api/zones", json={"frameAspect": 1.778, "zones": []}, headers=h)
    assert r.status_code == 422
    assert client.get("/api/health").json()["zonesRevision"] == 1


def test_suggest_needs_frame_then_runs_on_worker(tmp_path, parts):
    seen = {}

    def fake_suggest(jpeg, existing, heat):
        seen["thread"] = threading.current_thread().name
        seen["jpeg"] = jpeg
        return [{"id": "zaaaaaaaa", "number": 0, "source": "suggested", "mask": {"cols": 160, "rows": 90,
                                                                               "runs": [14400]}}]

    app = create_app(cfg(tmp_path), suggest=fake_suggest, **parts)
    with TestClient(app) as c:
        wait(lambda: app.state.hub.ready)
        h = {"Origin": GOOD}
        r = c.post("/api/zones/suggest", json={}, headers=h)
        assert r.status_code == 409 and r.json()["error"]["code"] == "NO_FRAME"
        code = c.post("/api/pair", json={}, headers=h).json()["code"]
        with c.websocket_connect(f"/ws/camera?c={code}") as cam:
            recv_type(cam, "hello")
            cam.send_bytes(frame_msg(1))
            recv_type(cam, "ack")
            wait(lambda: app.state.hub.processed >= 1)
            r = c.post("/api/zones/suggest", json={}, headers=h)
        assert r.status_code == 200 and r.json()["frameAspect"] == 1.778 and len(r.json()["zones"]) == 1
        assert seen == {"thread": "cnn-worker", "jpeg": JPEG}


# ------------------------------------------------------------------ privacy

def test_no_frame_files_written(tmp_path, client):
    before = set(os.listdir(tmp_path))
    code = pair(client)
    with client.websocket_connect(f"/ws/camera?c={code}") as cam:
        recv_type(cam, "hello")
        for i in range(5):
            cam.send_bytes(frame_msg(i))
            recv_type(cam, "ack")
        wait(lambda: client.hub.processed >= 1)
    after = set()
    for root, _dirs, files in os.walk(tmp_path):
        after |= {os.path.relpath(os.path.join(root, f), tmp_path) for f in files}
    assert after - before - {"zones.json"} == set()
    assert not any(f.endswith((".jpg", ".jpeg", ".png", ".mp4", ".y4m")) for f in after)


def test_fake_detector_flag_builds_parts(tmp_path):
    app = create_app(cfg(tmp_path, fake_detector=True))
    with TestClient(app) as c:
        wait(lambda: app.state.hub.ready)
        h = c.get("/api/health").json()
        assert h["ok"] is True and h["fake"] is True

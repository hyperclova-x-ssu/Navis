"""CNN live server (T-066): routes, sockets, camera page, latest-frame slot and the single worker thread.

API_CONTRACT API-14~18, ARCHITECTURE 14.1/14.2/14.5/14.8. Video never touches the disk: frames live in a
one-slot memory buffer and in each viewer's one-frame send queue only. No frame data or boxes are logged.

Run: uvicorn server:app --app-dir app --host 127.0.0.1 --port 8765 --ws-max-size 1048576
"""
from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import logging
import os
import statistics
import sys
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import ValidationError

HERE = Path(__file__).resolve().parent
for p in (HERE, HERE / "vendor"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import contracts as C  # noqa: E402
from config import Config, load_config  # noqa: E402
from pairing import CameraConnected, Pairing, RateLimited  # noqa: E402

log = logging.getLogger("cnn.server")
CAMERA_PAGE = HERE / "camera_page"
LIVE_SEC = 2.0          # camera "live" if a frame arrived within this many seconds
STATUS_EVERY = 1.0
PING_EVERY = 2.0
STATS_WINDOW = 3.0
VIEWER_QUEUE = 2       # unsent frames kept per viewer socket


def err(status: int, code: str, message: str, **extra) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}, **extra}, status_code=status)


def rss_mb() -> int:
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(int(line.split()[1]) / 1024)
    except OSError:
        pass
    import resource
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(r / (1024 * 1024) if sys.platform == "darwin" else r / 1024)


def _pct(values: list, q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def load_local(stem: str, as_name: str):
    """Load HERE/<stem>.py by path. Needed for numbers.py: `import numbers` is the stdlib module."""
    if as_name in sys.modules:
        return sys.modules[as_name]
    path = HERE / f"{stem}.py"
    spec = importlib.util.spec_from_file_location(as_name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[as_name] = mod
    try:
        spec.loader.exec_module(mod)
    except BaseException:
        sys.modules.pop(as_name, None)
        raise
    return mod


def load_fakes():
    return load_local("tests/fakes", "cnn_live_fakes")


# ==================================================================== clock sync

class ClockSync:
    """Phone clock -> server clock. NTP-style samples from server pings (median of last 5);
    before any sample, a one-way estimate from the phone's own pings/frames (min over recent)."""

    def __init__(self):
        self.samples: deque = deque(maxlen=5)
        self.oneway: deque = deque(maxlen=20)

    def add_roundtrip(self, sent: float, recv: float, phone_t: float) -> None:
        self.samples.append((sent + recv) / 2.0 - phone_t)

    def add_oneway(self, server_recv: float, phone_t: float) -> None:
        self.oneway.append(server_recv - phone_t)

    def offset(self) -> Optional[float]:
        if self.samples:
            return statistics.median(self.samples)
        if self.oneway:
            return min(self.oneway)  # smallest = least network delay
        return None

    def to_server(self, phone_t: float, fallback: float) -> float:
        o = self.offset()
        return fallback if o is None else phone_t + o


# ==================================================================== viewers

class Viewer:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.video = True
        # unsent frames. Up to VIEWER_QUEUE: a detected frame and the held frame right after it are often
        # produced within ~1 ms of each other; keeping only one would mostly drop the detected (box-update) frame.
        self.pending: deque = deque()
        self.texts: deque = deque(maxlen=16)
        self.event = asyncio.Event()
        self.dropped = 0

    def push_frame(self, header: dict, jpeg: bytes) -> None:
        while len(self.pending) >= VIEWER_QUEUE:
            self.pending.popleft()  # slow browser: drop the oldest, never block the server
            self.dropped += 1
        self.pending.append((header, jpeg))
        self.event.set()

    def push_text(self, msg: dict) -> None:
        self.texts.append(msg)
        self.event.set()


# ==================================================================== hub

class Hub:
    def __init__(self, cfg: Config, detector=None, engine=None, store=None, suggest=None,
                 clock: Callable[[], float] = time.monotonic):
        self.cfg = cfg
        self.clock = clock
        self.pairing = Pairing(cfg.public_url, cfg.pair_ttl_sec, cfg.session_ttl_sec, C.PAIR_RATE_PER_SEC, clock)
        self.detector = detector
        self.capture_pipeline = None
        self.engine = engine
        self.store = store
        self.suggest = suggest
        self.load_error: Optional[str] = None
        self.ready = False
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.viewers: set[Viewer] = set()
        self.camera_ws: Optional[WebSocket] = None
        self.camera_gen = 0
        self.clocksync = ClockSync()
        self.zones = None
        # slot + worker
        self._cond = threading.Condition()
        self._slot: Optional[C.FrameIn] = None
        self._jobs: deque = deque()
        self._stop = False
        self._thread: Optional[threading.Thread] = None
        # stats
        self.dropped = 0
        self.last_frame_recv: Optional[float] = None
        self.last_frame_size: Optional[tuple] = None
        self.last_jpeg: Optional[bytes] = None
        self._done: deque = deque()     # (doneT, detected, inferMs|None, latencyMs)
        self._last_infer_ms = 0.0
        self._last_status: Optional[str] = None
        self.processed = 0

    # ------------------------------------------------------------ lifecycle

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self._stop = False
        self._thread = threading.Thread(target=self._worker, name="cnn-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._cond:
            self._stop = True
            self._cond.notify_all()
        if self._thread:
            self._thread.join(timeout=5)

    def _load_parts(self) -> None:
        cfg = self.cfg
        try:
            if self.store is None:
                import zones as Z
                self.store = Z.FileZoneStore(str(cfg.zones_path))
            self.zones = self.store.load()
        except Exception as e:  # zones file problems must not stop the camera path
            log.exception("zone store failed")
            self.load_error = f"zones: {type(e).__name__}: {e}"
        try:
            if cfg.fake_detector and (self.detector is None or self.engine is None):
                fk = load_fakes()
                self.detector = self.detector or fk.FakeDetector()
                self.engine = self.engine or fk.FakeEngine()
            if self.detector is None:
                self.detector = importlib.import_module("pipeline").create_detector(cfg)
            if self.engine is None:
                self.engine = load_local("numbers", "cnn_live_numbers").create_engine(cfg)
            self.capture_pipeline = importlib.import_module("capture").create_frame_pipeline(
                cfg, detector=self.detector, engine=self.engine)
        except Exception as e:
            log.exception("detector/engine failed to load")
            self.load_error = f"detector: {type(e).__name__}: {e}"
            return
        self.ready = True

    # ------------------------------------------------------------ frames in (event loop thread)

    def put_frame(self, f: C.FrameIn) -> None:
        with self._cond:
            if self._slot is not None:
                self.dropped += 1
            self._slot = f
            self._cond.notify()

    def submit(self, fn: Callable[[], Any]) -> "asyncio.Future":
        fut = self.loop.create_future()

        def job():
            try:
                res = fn()
            except BaseException as e:  # noqa: BLE001 - forwarded to the awaiting route
                self.loop.call_soon_threadsafe(_set_exc, fut, e)
            else:
                self.loop.call_soon_threadsafe(_set_res, fut, res)

        with self._cond:
            self._jobs.append(job)
            self._cond.notify()
        return fut

    # ------------------------------------------------------------ worker thread

    def _worker(self) -> None:
        self._load_parts()
        while True:
            with self._cond:
                while not self._stop and self._slot is None and not self._jobs:
                    self._cond.wait(timeout=0.5)
                if self._stop:
                    return
                job = self._jobs.popleft() if self._jobs else None
                frame = None if job else self._slot
                if not job:
                    self._slot = None
            if job:
                job()
                continue
            if frame is not None and self.ready:
                try:
                    self._process(frame)
                except Exception:
                    log.exception("frame processing failed")

    def _process(self, f: C.FrameIn) -> None:
        zs = self.zones
        observation = self.capture_pipeline.step(f, zs)
        res, due, infer_ms = observation.result, observation.detected, observation.infer_ms
        if infer_ms is not None:
            self._last_infer_ms = infer_ms
        done = self.clock()
        latency = (done - f.capture_t) * 1000.0
        self._done.append((done, due, infer_ms, latency))
        while self._done and done - self._done[0][0] > STATS_WINDOW:
            self._done.popleft()
        fps, dfps = self._rates(done)
        res = replace(res, frameId=f.frame_id, detected=due, w=f.w, h=f.h, captureT=f.capture_t, recvT=f.recv_t,
                      doneT=done, zonesRevision=getattr(zs, "revision", 0),
                      stats=C.FrameStats(fps=round(fps, 1), detectFps=round(dfps, 1),
                                         inferMs=round(self._last_infer_ms, 1), latencyMs=round(latency, 1),
                                         dropped=self.dropped))
        self.last_jpeg = f.jpeg
        self.last_frame_size = (f.w, f.h)
        self.processed += 1
        header = res.to_dict()
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self._fanout, header, f.jpeg)

    def _rates(self, now: float) -> tuple:
        if len(self._done) < 2:
            return 0.0, 0.0
        span = max(1e-3, now - self._done[0][0])
        n = len(self._done) - 1
        d = sum(1 for x in list(self._done)[1:] if x[1])
        return n / span, d / span

    def reset_session(self, new_session: bool) -> None:
        """Called on camera (re)attach; runs on the worker thread before the next frame."""
        def job():
            with self._cond:
                self._slot = None
            if self.detector is not None:
                self.detector.reset_tracker()
            if self.engine is not None:
                if new_session:
                    self.engine.reset()
                elif hasattr(self.engine, "reset_tracks"):
                    self.engine.reset_tracks()  # same phone reconnected: restart track confirmation only
            if self.capture_pipeline is not None:
                self.capture_pipeline.reset()
            if new_session:
                self.dropped = 0
                self._done.clear()
        with self._cond:
            self._jobs.append(job)
            self._cond.notify()

    # ------------------------------------------------------------ out (event loop thread)

    def _fanout(self, header: dict, jpeg: bytes) -> None:
        for v in list(self.viewers):
            v.push_frame(header, jpeg)

    def camera_state(self) -> str:
        if self.pairing.camera_socket_open():
            if self.last_frame_recv is not None and self.clock() - self.last_frame_recv <= LIVE_SEC:
                return "live"
            return "connected"
        return self.pairing.code_state()

    def aspect_mismatch(self) -> bool:
        zs = self.zones
        fa = getattr(zs, "frame_aspect", None)
        if not fa or not self.last_frame_size:
            return False
        w, h = self.last_frame_size
        return abs((w / h) - fa) / fa > 0.05

    def status_msg(self) -> dict:
        return {"type": "status", "camera": self.camera_state(),
                "pairExpiresAt": self.pairing.pending_expires_at(),
                "zonesRevision": getattr(self.zones, "revision", 0),
                "zonesAspectMismatch": self.aspect_mismatch(),
                "lastFrameT": None if self.last_frame_recv is None else round(self.last_frame_recv, 3),
                "serverT": round(self.clock(), 3)}

    def broadcast_text(self, msg: dict) -> None:
        for v in list(self.viewers):
            v.push_text(msg)

    def status_changed(self) -> None:
        self.broadcast_text(self.status_msg())

    def health(self) -> dict:
        done = list(self._done)
        infer = [x[2] for x in done if x[2] is not None]
        lat = [x[3] for x in done]
        fps, _ = self._rates(self.clock()) if done else (0.0, 0.0)
        cfg = self.cfg
        out = {"ok": self.ready and self.load_error is None, "version": cfg.version, "mode": cfg.mode,
               "device": cfg.device, "cpuThreads": cfg.cpu_threads, "runtime": cfg.runtime, "model": cfg.model,
               "imgsz": cfg.imgsz, "detectHz": cfg.detect_hz, "boxPredict": cfg.box_predict,
               "detectPlan": cfg.detect_plan, "rssMb": rss_mb(), "fake": bool(cfg.fake_detector),
               "camera": self.camera_state(), "zonesRevision": getattr(self.zones, "revision", 0),
               "stats": {"fps": round(fps, 1), "inferMsP50": round(_pct(infer, 0.5), 1),
                         "inferMsP95": round(_pct(infer, 0.95), 1), "latencyMsP50": round(_pct(lat, 0.5), 1),
                         "dropped": self.dropped, "viewers": len(self.viewers)}}
        if self.load_error:
            out["error"] = self.load_error
        return out


def _set_res(fut, res):
    if not fut.done():
        fut.set_result(res)


def _set_exc(fut, e):
    if not fut.done():
        fut.set_exception(e)


# ==================================================================== app

def create_app(cfg: Optional[Config] = None, **parts) -> FastAPI:
    cfg = cfg or load_config()
    hub = Hub(cfg, **parts)
    allowed = set(cfg.allowed_origins)
    own_origin = cfg.public_url.rstrip("/")

    def origin_ok(origin: Optional[str]) -> bool:
        # Non-browser clients send no Origin; tailnet-only by design (ARCHITECTURE 14.8).
        return origin is None or origin.rstrip("/") in allowed or origin.rstrip("/") == own_origin

    async def ticker():
        while True:  # status every second (API-17)
            await asyncio.sleep(STATUS_EVERY)
            hub.broadcast_text(hub.status_msg())

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        hub.start(asyncio.get_running_loop())
        t = asyncio.create_task(ticker())
        try:
            yield
        finally:
            t.cancel()
            hub.stop()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.hub = hub

    # ------------------------------------------------------------ origin, CORS, body size

    @app.middleware("http")
    async def guard(request: Request, call_next):
        origin = request.headers.get("origin")
        path = request.url.path
        if path.startswith("/api/"):
            if not origin_ok(origin):
                return err(403, "BAD_ORIGIN", "origin not allowed")
            if request.method == "OPTIONS":
                resp = Response(status_code=204)
            else:
                cl = request.headers.get("content-length")
                if cl is not None and (not cl.isdigit() or int(cl) > C.MAX_HTTP_BODY):
                    return err(413, "TOO_LARGE", "body over 256KB")
                resp = await call_next(request)
            if origin and origin.rstrip("/") in allowed:
                resp.headers["Access-Control-Allow-Origin"] = origin
                resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT"
                resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
                resp.headers["Access-Control-Max-Age"] = "600"
                resp.headers["Vary"] = "Origin"
            resp.headers["Cache-Control"] = "no-store"
            return resp
        return await call_next(request)

    async def read_json(request: Request) -> Any:
        body = await request.body()
        if len(body) > C.MAX_HTTP_BODY:
            raise _HttpError(err(413, "TOO_LARGE", "body over 256KB"))
        if not body:
            return {}
        try:
            return json.loads(body)
        except ValueError:
            raise _HttpError(err(400, "BAD_REQUEST", "body is not JSON"))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        if isinstance(exc, _HttpError):
            return exc.resp
        log.exception("unhandled error on %s", request.url.path)
        return err(500, "INTERNAL", "internal error")

    # ------------------------------------------------------------ API-14

    @app.get("/api/health")
    async def health():
        return hub.health()

    # ------------------------------------------------------------ API-15

    @app.post("/api/pair")
    async def pair(request: Request):
        try:
            body = C.PairBody.model_validate(await read_json(request))
        except _HttpError as e:
            return e.resp
        except ValidationError as e:
            return err(400, "BAD_REQUEST", e.errors()[0].get("msg", "bad body"))
        try:
            res = hub.pairing.issue(body.lang, body.replace)
        except RateLimited:
            return err(429, "RATE_LIMITED", "max 2 pair requests per second")
        except CameraConnected:
            return err(409, "CAMERA_CONNECTED", "a camera is connected; use replace:true")
        hub.status_changed()
        return res

    @app.get("/api/pair/check")
    async def pair_check(c: str = ""):
        return {"state": hub.pairing.check(c)}

    # ------------------------------------------------------------ camera page (SCR-351)

    page_headers = {
        "Cache-Control": "no-store",
        "Content-Security-Policy": ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                    "img-src 'self' data: blob:; media-src 'self' blob: mediastream:; "
                                    "connect-src 'self' wss: ws:; frame-ancestors 'none'; base-uri 'none'"),
        "Permissions-Policy": "camera=(self), microphone=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }

    @app.get("/cam")
    async def cam():
        return FileResponse(CAMERA_PAGE / "index.html", media_type="text/html; charset=utf-8", headers=page_headers)

    @app.get("/cam/{name}")
    async def cam_asset(name: str):
        if name not in ("cam.js", "i18n.js"):
            return err(404, "NOT_FOUND", "not found")
        return FileResponse(CAMERA_PAGE / name, media_type="text/javascript; charset=utf-8", headers=page_headers)

    # ------------------------------------------------------------ API-18 (thin routes over zones.py / suggest.py)

    @app.get("/api/zones")
    async def zones_get():
        if hub.store is None:
            return err(503, "NOT_READY", hub.load_error or "zone store not loaded")
        zs = hub.store.load()
        return zs.to_dict()

    @app.put("/api/zones")
    async def zones_put(request: Request):
        if hub.store is None:
            return err(503, "NOT_READY", hub.load_error or "zone store not loaded")
        Z = _zones_module(hub)
        try:
            body = await read_json(request)
        except _HttpError as e:
            return e.resp
        base = body.get("baseRevision") if isinstance(body, dict) else None
        if isinstance(base, bool) or not isinstance(base, int):
            return err(422, "INVALID_ZONES", "baseRevision must be an integer")
        try:
            zin = Z.ZoneSetIn.from_dict(body)
            before = getattr(hub.zones, "revision", None)
            new = hub.store.save(zin, base)
        except Z.RevisionConflict as e:
            return err(409, "REVISION_CONFLICT", "zones changed elsewhere", current=e.current.to_dict())
        except Z.InvalidZones as e:
            return err(422, "INVALID_ZONES", str(e))
        hub.zones = new
        if new.revision != before:
            hub.broadcast_text({"type": "zones", "revision": new.revision})
            hub.status_changed()
        return new.to_dict()

    @app.post("/api/zones/suggest")
    async def zones_suggest(request: Request):
        try:
            await read_json(request)
        except _HttpError as e:
            return e.resp
        jpeg, size = hub.last_jpeg, hub.last_frame_size
        if not jpeg or not size:
            return err(409, "NO_FRAME", "no camera frame yet")
        fn = hub.suggest
        if fn is None:
            try:
                fn = importlib.import_module("suggest").suggest_zones
            except Exception as e:
                return err(503, "NOT_READY", f"suggest unavailable: {type(e).__name__}")
        heat_fn = getattr(hub.engine, "occupancy_heat", None)
        existing = hub.zones

        def run():
            heat = heat_fn() if heat_fn else None
            return fn(jpeg, existing, heat)

        try:
            zones = await asyncio.wait_for(hub.submit(run), timeout=15)
        except asyncio.TimeoutError:
            return err(504, "TIMEOUT", "suggest took too long")
        except ValueError as e:
            return err(422, "BAD_FRAME", str(e))
        out = [z.to_dict() if hasattr(z, "to_dict") else z for z in zones]
        w, h = size
        return {"zones": out, "frameAspect": round(w / h, 3)}

    # ------------------------------------------------------------ API-16 camera socket

    @app.websocket("/ws/camera")
    async def ws_camera(ws: WebSocket):
        await ws.accept()
        q = ws.query_params
        session, new_session = None, False
        if q.get("s"):
            session = hub.pairing.resume(q["s"])
            if session is None:
                return await ws.close(code=C.CLOSE_BAD_CODE)
        else:
            state, session = hub.pairing.consume(q.get("c", ""))
            if state == "busy":
                await _send_json(ws, {"type": "status", "state": "busy"})
                return await ws.close(code=C.CLOSE_REPLACED)
            if state != "ok":
                return await ws.close(code=C.CLOSE_BAD_CODE)
            new_session = True
        # replace any other camera socket
        old = hub.camera_ws
        if old is not None:
            if new_session:
                await _send_json(old, {"type": "status", "state": "replaced"})
                await _safe_close(old, C.CLOSE_REPLACED)
            else:
                await _safe_close(old, 1001)
        gen = hub.pairing.attach(session)
        hub.camera_ws = ws
        if new_session:
            hub.clocksync = ClockSync()
            hub.last_frame_recv = None
        hub.reset_session(new_session)
        hub.status_changed()
        cfg = hub.cfg
        await _send_json(ws, {"type": "hello", "sessionToken": session.token, "maxInflight": 2,
                              "maxEdge": cfg.max_edge, "quality": cfg.quality, "fps": cfg.fps})
        await _send_json(ws, {"type": "status", "state": "ok"})
        sync = hub.clocksync
        pinger = asyncio.create_task(_camera_pinger(ws, hub))
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                now = hub.clock()
                data = msg.get("bytes")
                if data is not None:
                    if len(data) > C.MAX_CAMERA_BINARY:
                        await ws.close(code=C.CLOSE_TOO_BIG)
                        break
                    try:
                        header, jpeg = C.unpack_frame(data)
                        h = C.CameraFrameHeader.model_validate(header)
                        if len(jpeg) < 4 or jpeg[:2] != b"\xff\xd8":
                            raise ValueError("not a JPEG")
                    except (ValueError, ValidationError):
                        await ws.close(code=C.CLOSE_BAD_FORMAT)
                        break
                    await _send_json(ws, {"type": "ack", "frameId": h.frameId})
                    if sync.offset() is None:
                        sync.add_oneway(now, h.captureT)
                    cap = min(now, sync.to_server(h.captureT, now))
                    was_live = hub.camera_state() == "live"
                    hub.last_frame_recv = now
                    hub.put_frame(C.FrameIn(frame_id=h.frameId, capture_t=round(cap, 4), recv_t=now, jpeg=jpeg,
                                            w=h.w, h=h.h))
                    if not was_live:
                        hub.status_changed()
                    continue
                text = msg.get("text")
                if text is None:
                    continue
                if len(text.encode("utf-8")) > C.MAX_WS_TEXT:
                    await ws.close(code=C.CLOSE_TOO_BIG)
                    break
                try:
                    m = json.loads(text)
                    kind = m.get("type") if isinstance(m, dict) else None
                    if kind == "ping":
                        p = C.PingMsg.model_validate(m)
                        sync.add_oneway(now, p.t)
                        await _send_json(ws, {"type": "pong", "t": p.t, "serverT": round(now, 3)})
                    elif kind == "pong":
                        p = C.PongMsg.model_validate(m)
                        phone_t = m.get("phoneT")
                        if isinstance(phone_t, (int, float)) and not isinstance(phone_t, bool) and p.t <= now:
                            sync.add_roundtrip(p.t, now, float(phone_t))
                except (ValueError, ValidationError):
                    await ws.close(code=C.CLOSE_BAD_FORMAT)
                    break
        except WebSocketDisconnect:
            pass
        finally:
            pinger.cancel()
            hub.pairing.detach(session, gen)
            if hub.camera_ws is ws:
                hub.camera_ws = None
            hub.status_changed()

    # ------------------------------------------------------------ API-17 view socket

    @app.websocket("/ws/view")
    async def ws_view(ws: WebSocket):
        origin = ws.headers.get("origin")
        await ws.accept()
        if not origin_ok(origin):
            return await ws.close(code=C.CLOSE_BAD_ORIGIN)
        if len(hub.viewers) >= C.MAX_VIEWERS:
            return await ws.close(code=C.CLOSE_TOO_MANY)
        v = Viewer(ws)
        hub.viewers.add(v)
        v.push_text(hub.status_msg())
        sender = asyncio.create_task(_viewer_sender(v))
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                text = msg.get("text")
                if text is None:
                    continue
                if len(text.encode("utf-8")) > C.MAX_WS_TEXT:
                    await ws.close(code=C.CLOSE_TOO_BIG)
                    break
                try:
                    m = json.loads(text)
                    kind = m.get("type") if isinstance(m, dict) else None
                    if kind == "subscribe":
                        v.video = C.SubscribeMsg.model_validate(m).video
                    elif kind == "ping":
                        p = C.PingMsg.model_validate(m)
                        v.push_text({"type": "pong", "t": p.t, "serverT": round(hub.clock(), 3)})
                except (ValueError, ValidationError):
                    await ws.close(code=C.CLOSE_BAD_FORMAT)
                    break
        except WebSocketDisconnect:
            pass
        finally:
            sender.cancel()
            hub.viewers.discard(v)

    return app


class _HttpError(Exception):
    def __init__(self, resp: JSONResponse):
        self.resp = resp


def _zones_module(hub: Hub):
    mod = sys.modules.get(type(hub.store).__module__)
    if mod is not None and hasattr(mod, "ZoneSetIn"):
        return mod
    return importlib.import_module("zones")


async def _send_json(ws: WebSocket, msg: dict) -> None:
    try:
        await ws.send_text(json.dumps(msg, separators=(",", ":")))
    except Exception:
        pass


async def _safe_close(ws: WebSocket, code: int) -> None:
    try:
        await ws.close(code=code)
    except Exception:
        pass


async def _camera_pinger(ws: WebSocket, hub: Hub) -> None:
    while True:
        await asyncio.sleep(PING_EVERY)
        await _send_json(ws, {"type": "ping", "t": round(hub.clock(), 4)})


async def _viewer_sender(v: Viewer) -> None:
    try:
        while True:
            await v.event.wait()
            v.event.clear()
            while v.texts:
                await v.ws.send_text(json.dumps(v.texts.popleft(), separators=(",", ":")))
            while v.pending:
                header, jpeg = v.pending.popleft()
                await v.ws.send_bytes(C.pack_frame(header, jpeg if v.video else b""))
                while v.texts:
                    await v.ws.send_text(json.dumps(v.texts.popleft(), separators=(",", ":")))
    except Exception:
        pass


def _make_default_app() -> FastAPI:
    logging.basicConfig(level=os.environ.get("CNN_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    return create_app()


app = _make_default_app() if os.environ.get("CNN_NO_DEFAULT_APP") != "1" else None

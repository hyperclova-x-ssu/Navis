"""Pairing codes, camera session, QR SVG (API-15/16, ARCHITECTURE 14.8). Memory only; nothing on disk.

States (all thread-safe, clock injectable for tests):
- one pairing code at a time (a new issue() invalidates the previous one), 6 chars, 10 min, single use
- one camera session at a time; a session token lets the same phone reconnect (?s=) within session_ttl
  after its socket closed
- issue(replace=False) while a camera socket is connected -> CameraConnected (409)
- consume(code): unused valid code -> new session (replaces the old one if any); used code or a camera
  connected and the code was not a replace code -> "busy"; unknown/expired -> "invalid"
"""
from __future__ import annotations

import io
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.parse import quote

CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # no 0 O 1 I L
CODE_LEN = 6


class CameraConnected(Exception):
    pass


class RateLimited(Exception):
    pass


@dataclass
class PairCode:
    code: str
    expires_at: float
    replace: bool
    lang: str
    used: bool = False


@dataclass
class Session:
    token: str
    started_at: float
    socket_open: bool = False
    closed_at: Optional[float] = None
    generation: int = 0  # bumps on every socket attach (same-session reconnects)


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))


def qr_svg(url: str) -> str:
    import segno  # pure python, ARCHITECTURE 14.7

    qr = segno.make(url, error="m", micro=False)
    buf = io.BytesIO()
    qr.save(buf, kind="svg", border=4, scale=8, xmldecl=False, svgns=True, nl=False,
            dark="#000000", light="#ffffff")
    return buf.getvalue().decode("utf-8")


class Pairing:
    def __init__(self, public_url: str, ttl_sec: float = 600.0, session_ttl_sec: float = 300.0,
                 rate_per_sec: int = 2, clock: Callable[[], float] = time.monotonic):
        self.public_url = public_url.rstrip("/")
        self.ttl = ttl_sec
        self.session_ttl = session_ttl_sec
        self.rate = rate_per_sec
        self.clock = clock
        self._lock = threading.RLock()
        self._code: Optional[PairCode] = None
        self._session: Optional[Session] = None
        self._pair_times: deque = deque()

    # ------------------------------------------------------------ codes

    def issue(self, lang: str = "ko", replace: bool = False) -> dict:
        with self._lock:
            now = self.clock()
            while self._pair_times and now - self._pair_times[0] >= 1.0:
                self._pair_times.popleft()
            if len(self._pair_times) >= self.rate:
                raise RateLimited()
            self._pair_times.append(now)
            if self.camera_socket_open() and not replace:
                raise CameraConnected()
            code = new_code()
            self._code = PairCode(code=code, expires_at=now + self.ttl, replace=replace, lang=lang)
            url = f"{self.public_url}/cam?c={code}&lang={quote(lang)}"
            return {"code": code, "cameraUrl": url, "qrSvg": qr_svg(url),
                    "expiresAt": round(now + self.ttl, 3), "expiresInSec": int(self.ttl)}

    def _valid_code(self, code: str) -> Optional[PairCode]:
        c = self._code
        if c is None or not code or not secrets.compare_digest(c.code, code.upper()):
            return None
        if self.clock() >= c.expires_at:
            return None
        return c

    def check(self, code: str) -> str:
        """'ok' | 'busy' | 'expired' (API-15 /api/pair/check)."""
        with self._lock:
            c = self._valid_code(code)
            if c is None:
                return "expired"
            if c.used:
                return "busy" if self.camera_socket_open() else "expired"
            if self.camera_socket_open() and not c.replace:
                return "busy"
            return "ok"

    def pending_expires_at(self) -> Optional[float]:
        with self._lock:
            c = self._code
            if c is None or c.used or self.clock() >= c.expires_at:
                return None
            return round(c.expires_at, 3)

    # ------------------------------------------------------------ sessions

    def consume(self, code: str) -> tuple[str, Optional[Session]]:
        """('ok', new_session) | ('busy', None) | ('invalid', None). The caller attaches the socket."""
        with self._lock:
            c = self._valid_code(code)
            if c is None:
                return "invalid", None
            if c.used or (self.camera_socket_open() and not c.replace):
                return "busy", None
            c.used = True
            self._session = Session(token=secrets.token_urlsafe(24), started_at=self.clock())
            return "ok", self._session

    def resume(self, token: str) -> Optional[Session]:
        with self._lock:
            s = self._session
            if s is None or not token or not secrets.compare_digest(s.token, token):
                return None
            if not s.socket_open and s.closed_at is not None and self.clock() - s.closed_at > self.session_ttl:
                self._session = None
                return None
            return s

    def attach(self, s: Session) -> int:
        with self._lock:
            s.socket_open = True
            s.closed_at = None
            s.generation += 1
            return s.generation

    def detach(self, s: Session, generation: int) -> None:
        with self._lock:
            if s.generation == generation:
                s.socket_open = False
                s.closed_at = self.clock()

    def is_current(self, s: Session) -> bool:
        with self._lock:
            return self._session is s

    def camera_socket_open(self) -> bool:
        with self._lock:
            return self._session is not None and self._session.socket_open

    @property
    def session(self) -> Optional[Session]:
        return self._session

    def code_state(self) -> str:
        """'waiting' when an unused valid code exists, else 'none'."""
        return "waiting" if self.pending_expires_at() is not None else "none"

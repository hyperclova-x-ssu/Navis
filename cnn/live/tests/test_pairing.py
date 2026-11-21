import pytest

from pairing import CODE_ALPHABET, CameraConnected, Pairing, RateLimited, qr_svg


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def make(clock=None):
    return Pairing("https://gpu-server.example.ts.net:8443", ttl_sec=600, session_ttl_sec=300, rate_per_sec=2,
                   clock=clock or Clock())


def test_code_format_url_and_qr():
    p = make()
    r = p.issue("en")
    assert len(r["code"]) == 6 and all(ch in CODE_ALPHABET for ch in r["code"])
    assert not set("01OIL") & set(r["code"])
    assert r["cameraUrl"] == f"https://gpu-server.example.ts.net:8443/cam?c={r['code']}&lang=en"
    assert r["qrSvg"].startswith("<svg") and 'xmlns="http://www.w3.org/2000/svg"' in r["qrSvg"]
    assert r["expiresInSec"] == 600 and r["expiresAt"] == pytest.approx(1600.0)
    assert p.check(r["code"]) == "ok" and p.code_state() == "waiting"


def test_expiry_after_10_minutes():
    clk = Clock()
    p = make(clk)
    code = p.issue()["code"]
    clk.t += 599.9
    assert p.check(code) == "ok"
    clk.t += 0.2
    assert p.check(code) == "expired"
    assert p.consume(code) == ("invalid", None)
    assert p.code_state() == "none" and p.pending_expires_at() is None


def test_new_code_invalidates_previous():
    clk = Clock()
    p = make(clk)
    a = p.issue()["code"]
    clk.t += 1
    b = p.issue()["code"]
    assert p.check(a) == "expired" or a == b
    assert p.check(b) == "ok"


def test_single_use_then_busy_while_connected():
    p = make()
    code = p.issue()["code"]
    state, s = p.consume(code)
    assert state == "ok" and len(s.token) == 32
    p.attach(s)
    assert p.check(code) == "busy"
    assert p.consume(code) == ("busy", None)
    assert p.code_state() == "none"


def test_used_code_is_expired_when_no_camera():
    p = make()
    code = p.issue()["code"]
    _, s = p.consume(code)
    g = p.attach(s)
    p.detach(s, g)
    assert p.check(code) == "expired"


def test_issue_refused_while_camera_connected_unless_replace():
    clk = Clock()
    p = make(clk)
    _, s = p.consume(p.issue()["code"])
    p.attach(s)
    clk.t += 1
    with pytest.raises(CameraConnected):
        p.issue(replace=False)
    clk.t += 1
    code = p.issue(replace=True)["code"]
    assert p.check(code) == "ok"
    state, s2 = p.consume(code)
    assert state == "ok" and s2 is not s and p.is_current(s2) and not p.is_current(s)
    assert p.resume(s.token) is None  # old phone cannot come back


def test_rate_limit_two_per_second():
    clk = Clock()
    p = make(clk)
    p.issue()
    p.issue()
    with pytest.raises(RateLimited):
        p.issue()
    clk.t += 1.0
    p.issue()


def test_session_resume_window():
    clk = Clock()
    p = make(clk)
    _, s = p.consume(p.issue()["code"])
    g = p.attach(s)
    p.detach(s, g)
    clk.t += 299
    assert p.resume(s.token) is s
    assert p.resume("x" * 32) is None
    clk.t += 2
    assert p.resume(s.token) is None


def test_stale_detach_does_not_close_newer_socket():
    p = make()
    _, s = p.consume(p.issue()["code"])
    g1 = p.attach(s)
    g2 = p.attach(s)  # same phone reconnected before the old socket noticed
    p.detach(s, g1)
    assert p.camera_socket_open()
    p.detach(s, g2)
    assert not p.camera_socket_open()


def test_qr_svg_is_plain_svg():
    svg = qr_svg("https://x.ts.net:8443/cam?c=ABCDEF&lang=ko")
    assert svg.startswith("<svg") and svg.rstrip().endswith("</svg>") and "<script" not in svg

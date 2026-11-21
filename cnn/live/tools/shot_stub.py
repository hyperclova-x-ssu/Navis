"""Local stub for camera-page layout checks only (no CNN): serves camera_page at /cam/ and / , /api/pair/check -> ok."""
import http.server, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent / "camera_page"
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/pair/check":
            body, ct = b'{"state":"ok"}', "application/json"
        else:
            name = "index.html" if p in ("/", "/cam/", "/cam") else p.removeprefix("/cam/")
            f = ROOT / name
            if not f.is_file(): self.send_error(404); return
            body = f.read_bytes(); ct = "text/html" if name.endswith(".html") else "text/javascript"
        self.send_response(200); self.send_header("Content-Type", ct + "; charset=utf-8"); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8099), H).serve_forever()

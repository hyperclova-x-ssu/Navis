"""측정 4(서버 쪽, gpu-server): 임시 HTTP 서버. tailnet 주소에만 묶고, 일정 시간이 지나면 저절로 꺼진다.
 POST /ack    : JPEG 받고 작은 JSON 답(크기만)      -> 순수 네트워크 왕복
 POST /echo   : JPEG 를 그대로 돌려줌               -> 사진을 보내고 받는 왕복
 POST /detect : 디코딩 + track + 확인 추적·앉음·칼만 -> 상자·숫자 JSON (서버 처리까지 포함한 왕복)
실행(gpu-server): venv/bin/python cnn/bench/net_server.py --host gpu-server --port 18765 --ttl 900 [--config pt:960:fp16 | cpu:yolo11n:openvino:640]"""
import argparse
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

import benchlib as B

STATE = {}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)  # 헤더·본문 나눠 쓸 때 Nagle 지연 방지

    def log_message(self, *a):
        pass

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        t_in = B.now_ms()
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        t_read = B.now_ms() - t_in
        if self.path == "/echo":
            return self._send(data, "image/jpeg")
        if self.path == "/detect":
            t0 = B.now_ms()
            with STATE["lock"]:
                img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
                h, w = img.shape[:2]
                r = STATE["model"].track(img, **STATE["kw"])[0]
                bx = r.boxes
                xyxy = bx.xyxy.cpu().numpy() / np.array([w, h, w, h])
                cls = bx.cls.cpu().numpy().astype(int)
                ids = bx.id.cpu().numpy().astype(int) if bx.id is not None else np.full(len(cls), -1)
                persons = [[*map(float, b), int(i)] for b, c, i in zip(xyxy, cls, ids) if c == B.PERSON]
                out = STATE["live"].step(persons)
            out["persons"] = [[round(v, 4) for v in p[:4]] + p[4:] for p in out["persons"]]
            out["serverMs"] = round(B.now_ms() - t0, 2)
            out["bodyReadMs"] = round(t_read, 2)
            return self._send(json.dumps(out).encode(), "application/json")
        return self._send(json.dumps({"bytes": len(data)}).encode(), "application/json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=18765)
    ap.add_argument("--ttl", type=int, default=900, help="이 초가 지나면 저절로 종료")
    ap.add_argument("--config", default="pt:960:fp16")
    a = ap.parse_args()
    if a.config.startswith("cpu:"):  # cpu:<모델>:<실행기>:<크기>, 예 cpu:yolo11n:openvino:640 (GPU 없는 매장 PC 조건)
        import bench_cpu
        _, name, rt, size = a.config.split(":")
        model, imgsz = bench_cpu.load(name, rt, int(size))
        dev, half = "cpu", False
    else:  # pt:960:fp16 처럼 GPU
        from bench_pipeline import load_model
        backend, size, prec = a.config.split(":")
        model, imgsz = load_model(backend, int(size), prec == "fp16")
        dev, half = 0, prec == "fp16"
    STATE.update(model=model, lock=threading.Lock(), live=B.LivePipeline(*B.load_tables(1, 1)),
                 kw=dict(persist=True, tracker="bytetrack.yaml", classes=[B.PERSON, *B.CUP_CLASSES], conf=0.25,
                         imgsz=imgsz, half=half, device=dev, verbose=False))
    srv = ThreadingHTTPServer((a.host, a.port), H)
    threading.Timer(a.ttl, srv.shutdown).start()
    print(f"ready {a.host}:{a.port} ttl={a.ttl}s config={a.config}", flush=True)
    srv.serve_forever()
    print("closed", time.strftime("%H:%M:%S"), flush=True)


if __name__ == "__main__":
    main()

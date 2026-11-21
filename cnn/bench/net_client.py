"""측정 4(클라이언트 쪽, Mac): 1280x720 JPEG 1장을 gpu-server 임시 서버로 보내고 받는 왕복 시간. 표준 라이브러리만 씀.
연결 하나를 계속 쓰는 경우(keep-alive, 웹소켓과 비슷)와 매번 새 연결 두 가지.
실행(Mac): python3 net_client.py --host gpu-server --port 18765 --jpeg <1280x720.jpg> --out results/network.json"""
import argparse
import http.client
import json
import platform
import socket
import statistics
import subprocess
import time


def stats(ms):
    s = sorted(ms)
    return {"n": len(s), "mean_ms": round(statistics.fmean(s), 2), "p50_ms": round(s[len(s) // 2], 2),
            "p95_ms": round(s[int(len(s) * 0.95) - 1], 2), "max_ms": round(s[-1], 2)}


def conn_of(host, port):
    c = http.client.HTTPConnection(host, port, timeout=10)
    c.connect()
    c.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    return c


def run(host, port, path, body, n, keep):
    ms, server, read = [], [], []
    conn = conn_of(host, port)
    for i in range(n + 5):
        t0 = time.perf_counter()  # 새 연결 경우는 연결 맺는 시간까지 포함
        if not keep:
            conn = conn_of(host, port)
        conn.request("POST", path, body=body, headers={"Content-Type": "image/jpeg"})
        resp = conn.getresponse().read()
        dt = (time.perf_counter() - t0) * 1000
        if not keep:
            conn.close()
        if i >= 5:  # 처음 5번은 예열
            ms.append(dt)
            if path == "/detect":
                j = json.loads(resp)
                server.append(j["serverMs"])
                read.append(j["bodyReadMs"])
    conn.close()
    out = {"path": path, "keepAlive": keep, "requestBytes": len(body), "responseBytes": len(resp), **stats(ms)}
    if server:
        out["serverMs"] = stats(server)
        out["serverBodyReadMs"] = stats(read)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, default=18765)
    ap.add_argument("--jpeg", required=True)
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    body = open(a.jpeg, "rb").read()
    ping = subprocess.run(["ping", "-c", "20", "-i", "0.2", a.host], capture_output=True, text=True).stdout.strip().splitlines()[-1]
    rows = [run(a.host, a.port, "/ack", body, a.n, True), run(a.host, a.port, "/ack", body, a.n, False),
            run(a.host, a.port, "/echo", body, a.n, True), run(a.host, a.port, "/detect", body, a.n, True)]
    for r in rows:
        print(r)
    res = {"measuredAt": time.strftime("%Y-%m-%d %H:%M %Z"), "client": f"{platform.node()} ({platform.system()} {platform.machine()})",
           "server": f"{a.host}:{a.port}", "link": "Tailscale 직접 연결(Mac 유선/와이파이 -> gpu-server)", "ping": ping,
           "jpeg": "1280x720, 품질 80", "rows": rows}
    with open(a.out, "w") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print("저장:", a.out)


if __name__ == "__main__":
    main()

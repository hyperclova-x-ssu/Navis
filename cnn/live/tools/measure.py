#!/usr/bin/env python3
"""T-069 end-to-end measurement: fake phone camera + Navis-like viewer, both on this Mac, against the gpu-server server.

  NAVIS_CNN_PUBLIC_HOST='<tailnet-host>' python measure.py --seconds 330 --label weak \
      --video ../../../frontend/public/cnn/cafe17.mp4 --out /tmp/weak.json

* Camera: pairs (/api/pair), opens /ws/camera, sends JPEGs at hello.fps with at most maxInflight unacked frames
  (same rules as camera_page/cam.js), answers pings.
* Viewer: /ws/view, subscribe video, reads every result frame. Counts them (= box updates/s a Navis page would
  receive), and e2e = (viewer receive time) - (camera send time) on this one clock (no clock sync error).
  latencyMs / inferMs / dropped come from the server's own stats field. The Navis *draw* rate is a browser
  number and is not measured here (see RESULTS.md).
* Samples /api/health every 5 s, GPU memory + CPU load over ssh every 30 s, network path via `tailscale ping`.
* Nothing is written to disk except the --out JSON of numbers (no frames, no images).
"""
import argparse, asyncio, json, os, re, ssl, statistics, struct, subprocess, sys, time
import urllib.request
from urllib.parse import urlsplit

import cv2
import websockets


def pct(v, q):
    if not v:
        return None
    s = sorted(v)
    return round(s[min(len(s) - 1, int(round(q * (len(s) - 1))))], 1)


def summ(v):
    return {"n": len(v), "p50": pct(v, .5), "p95": pct(v, .95), "max": round(max(v), 1) if v else None}


def http_json(url, method="GET", body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def ts_path(host):
    try:
        out = subprocess.run(["tailscale", "ping", "-c", "3", "--timeout", "3s", host], capture_output=True,
                             text=True, timeout=20).stdout
        return "DERP" if "DERP" in out and "via DERP" in out.splitlines()[-1] else "direct", out.strip().splitlines()[-1]
    except Exception as e:  # noqa: BLE001
        return "unknown", str(e)


def ssh_sample(ssh_host):
    try:
        out = subprocess.run(["ssh", "-o", "ConnectTimeout=6", ssh_host,
                              "nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits; "
                              "cat /proc/loadavg"], capture_output=True, text=True, timeout=15).stdout.splitlines()
        mem, util = [float(x) for x in out[0].split(",")]
        return {"gpuMemMiB": mem, "gpuUtil": util, "load1": float(out[1].split()[0])}
    except Exception:  # noqa: BLE001
        return None


async def main():
    ap = argparse.ArgumentParser()
    public_host = os.environ.get("NAVIS_CNN_PUBLIC_HOST", "").strip()
    ap.add_argument("--base", default=f"https://{public_host}:8443" if public_host else None,
                    required=not public_host, help="CNN server URL (defaults to https://NAVIS_CNN_PUBLIC_HOST:8443)")
    ap.add_argument("--seconds", type=float, default=330)
    ap.add_argument("--label", default="run")
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--no-video-to-viewer", action="store_true")
    ap.add_argument("--warmup", type=float, default=15, help="seconds ignored at the start")
    a = ap.parse_args()

    base = a.base.rstrip("/")
    base_url = urlsplit(base)
    host = base_url.hostname
    if base_url.scheme not in ("https", "http") or not host:
        ap.error("--base must be an HTTP or HTTPS URL with a hostname")
    ssh_host = os.environ.get("GPU_HOST") or f"user@{host}"
    wsb = base.replace("https://", "wss://").replace("http://", "ws://")
    ctx = ssl.create_default_context() if wsb.startswith("wss") else None
    path0 = ts_path(host)
    pair = http_json(base + "/api/pair", "POST", {"lang": "ko", "replace": True})
    cap = cv2.VideoCapture(a.video)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    sent = {}            # frameId -> t sent
    e2e, lat, infer, dfps_l = [], [], [], []
    st = {"sent": 0, "acked": 0, "results": 0, "detected": 0, "skipped_inflight": 0, "closed": None}
    first_result_t = [None]
    per_sec = {}
    health, hw = [], []
    t0 = time.monotonic()
    stop = asyncio.Event()

    async def camera():
        async with websockets.connect(f"{wsb}/ws/camera?c={pair['code']}", ssl=ctx, max_size=2**22) as ws:
            hello = json.loads(await ws.recv())
            fps, maxedge, q, maxinfl = hello["fps"], hello["maxEdge"], hello["quality"], hello["maxInflight"]
            inflight = set()
            fid = 0

            async def reader():
                async for m in ws:
                    if isinstance(m, bytes):
                        continue
                    j = json.loads(m)
                    if j["type"] == "ack":
                        inflight.discard(j["frameId"]); st["acked"] += 1
                    elif j["type"] == "ping":
                        await ws.send(json.dumps({"type": "pong", "t": j["t"], "phoneT": round(time.monotonic(), 4)}))
                    elif j["type"] == "pong":
                        pass
            rd = asyncio.create_task(reader())
            nxt = time.monotonic()
            vi = 0.0
            try:
                while not stop.is_set():
                    nxt += 1.0 / fps
                    await asyncio.sleep(max(0, nxt - time.monotonic()))
                    # advance the video in real time
                    vi += src_fps / fps
                    ok = cap.grab()
                    for _ in range(int(vi) - 1):
                        ok = cap.grab()
                    vi -= int(vi)
                    ok, frame = cap.retrieve() if ok else (False, None)
                    if not ok:
                        cap.set(cv2.CAP_PROP_POS_FRAMES, 0); continue
                    h, w = frame.shape[:2]
                    s = min(1.0, maxedge / max(h, w))
                    if s < 1:
                        frame = cv2.resize(frame, (round(w * s), round(h * s)))
                    h, w = frame.shape[:2]
                    if len(inflight) >= maxinfl:
                        st["skipped_inflight"] += 1; continue
                    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, int(q * 100) if q <= 1 else int(q)])
                    now = time.monotonic()
                    hdr = json.dumps({"frameId": fid, "captureT": round(now, 4), "w": w, "h": h}, separators=(",", ":")).encode()
                    sent[fid] = now; inflight.add(fid); st["sent"] += 1
                    await ws.send(struct.pack(">I", len(hdr)) + hdr + jpg.tobytes())
                    fid += 1
            finally:
                rd.cancel()

    async def viewer():
        await asyncio.sleep(0.5)
        async with websockets.connect(f"{wsb}/ws/view", ssl=ctx, max_size=2**23,
                                      origin=None) as ws:
            await ws.send(json.dumps({"type": "subscribe", "video": not a.no_video_to_viewer}))
            async for m in ws:
                now = time.monotonic()
                if isinstance(m, str):
                    continue
                n = struct.unpack(">I", m[:4])[0]
                h = json.loads(m[4:4 + n])
                if h.get("type") != "frame":
                    continue
                st["results"] += 1
                if now - t0 < a.warmup:
                    continue
                if first_result_t[0] is None:
                    first_result_t[0] = now
                sec = int(now - first_result_t[0])
                per_sec[sec] = per_sec.get(sec, 0) + 1
                if h.get("detected"):
                    st["detected"] += 1
                t_sent = sent.get(h["frameId"])
                if t_sent is not None:
                    e2e.append((now - t_sent) * 1000)
                s = h.get("stats", {})
                lat.append(s.get("latencyMs", 0)); infer.append(s.get("inferMs", 0)); dfps_l.append(s.get("detectFps", 0))

    async def sampler():
        while not stop.is_set():
            try:
                health.append({"t": round(time.monotonic() - t0, 1), **await asyncio.to_thread(http_json, base + "/api/health")})
            except Exception:  # noqa: BLE001
                pass
            if int(time.monotonic() - t0) % 30 < 5:
                s = await asyncio.to_thread(ssh_sample, ssh_host)
                if s:
                    hw.append(s)
            await asyncio.sleep(5)

    tasks = [asyncio.create_task(t()) for t in (camera, viewer, sampler)]
    try:
        await asyncio.sleep(a.seconds)
    finally:
        stop.set()
        await asyncio.sleep(0.5)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    path1 = ts_path(host)
    meas = max(1, len(per_sec))
    full = [v for k, v in per_sec.items() if k < max(per_sec, default=0)]  # drop the partial last second
    last = health[-1] if health else {}
    res = {
        "label": a.label, "seconds": a.seconds, "warmupSec": a.warmup, "server": {k: last.get(k) for k in
               ("mode", "device", "runtime", "model", "imgsz", "detectHz", "cpuThreads")},
        "path": {"start": path0, "end": path1},
        "counts": {k: st[k] for k in ("sent", "acked", "results", "detected", "skipped_inflight")},
        "resultsPerSec": {"mean": round(sum(full) / max(1, len(full)), 2), "min": min(full, default=None),
                          "max": max(full, default=None)},
        "e2eMs": summ(e2e), "latencyMs": summ(lat), "inferMs": summ(infer),
        "detectFps": {"mean": round(statistics.mean(dfps_l), 2) if dfps_l else None},
        "serverFps": {"mean": round(statistics.mean([h["stats"]["fps"] for h in health[3:]]), 2) if len(health) > 3 else None},
        "dropped": last.get("stats", {}).get("dropped"),
        "rssMbMax": max([h.get("rssMb", 0) for h in health], default=None),
        "hw": hw, "gpuMemMiBMax": max([h["gpuMemMiB"] for h in hw], default=None),
        "load1Max": max([h["load1"] for h in hw], default=None),
    }
    with open(a.out, "w") as f:
        json.dump(res, f, indent=1, ensure_ascii=False)
    print(json.dumps(res, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())

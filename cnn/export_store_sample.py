"""Replay the recorded store camera through the live capture pipeline."""
import argparse
from contextlib import nullcontext
import json
import math
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import cv2

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "live"))

from capture import (CUP_CONFIRMATIONS, CUP_IMGSZ, CUP_MODEL, CUP_SCAN_HZ, CUP_TIMEOUT_SEC,
                     PERSON_ENTER_SEC, PERSON_HOLD_SEC, create_frame_pipeline)
from config import load_config
from contracts import FrameIn
from zones import FileZoneStore, validate_zones

SAMPLE = "store-sample"
PREVIEW_FPS = 5
W, H = 960, 540
OUT = HERE.parent / "frontend" / "public" / "cnn"


def sampled_frames(video, hz):
    capture = cv2.VideoCapture(str(video))
    try:
        source_fps = capture.get(cv2.CAP_PROP_FPS)
        if not capture.isOpened() or not math.isfinite(source_fps) or source_fps < hz:
            raise ValueError(f"Cannot read video at {hz} fps: {video}")
        source_index = sample_index = 0
        while capture.grab():
            if source_index == round(sample_index * source_fps / hz):
                ok, frame = capture.retrieve()
                if not ok:
                    raise ValueError(f"Cannot decode frame {source_index}: {video}")
                yield frame
                sample_index += 1
            source_index += 1
    finally:
        capture.release()


def camera_frame(image, index, cfg):
    height, width = image.shape[:2]
    ratio = min(1, cfg.max_edge / max(width, height))
    w, h = round(width * ratio), round(height * ratio)
    image = cv2.resize(image, (w, h), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, round(cfg.quality * 100)])
    if not ok:
        raise ValueError(f"Could not encode camera frame {index}")
    t = index / cfg.fps
    return FrameIn(index, t, t, encoded.tobytes(), w, h)


def sample_zones():
    cfg = json.loads((HERE / "zones" / f"{SAMPLE}.json").read_text())
    w, h = cfg["image_size"]
    tables = [{"id": z["id"], "name": z["name"], "polygon": [[round(x/w, 3), round(y/h, 3)]
               for x, y in z["polygon"]]} for z in cfg["tables"]]
    zones_path = HERE / "live" / "store_sample_zones.json"
    zones = FileZoneStore(zones_path).load()
    validate_zones(zones.zones)
    if len(zones.zones) != len(tables):
        raise ValueError(f"Invalid table count in {zones_path}")
    ids = {z.id: tables[z.number - 1]["id"] for z in zones.zones}
    return zones, tables, ids


def open_encoder(ffmpeg, mp4):
    return subprocess.Popen([
        ffmpeg, "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{W}x{H}", "-framerate", str(PREVIEW_FPS), "-i", "-", "-an",
        "-c:v", "libx264", "-crf", "30", "-pix_fmt", "yuv420p", "-g", "10",
        "-movflags", "+faststart", str(mp4),
    ], stdin=subprocess.PIPE)


def check_preview(mp4, frame_count):
    preview = cv2.VideoCapture(str(mp4))
    try:
        if (not preview.isOpened() or round(preview.get(cv2.CAP_PROP_FRAME_COUNT)) != frame_count
                or preview.get(cv2.CAP_PROP_FPS) != PREVIEW_FPS):
            raise ValueError(f"{mp4} does not match the analyzed frames. Re-run with --encode-video.")
    finally:
        preview.release()


def export_video(video, ffmpeg, encode_video=False, out=OUT, observer=None):
    cfg = load_config()
    if cfg.fps % PREVIEW_FPS or cfg.fake_detector or cfg.detect_plan != "full+zones":
        raise ValueError("Replay requires real camera settings and a camera FPS divisible by five")
    zones, tables, table_ids = sample_zones()
    pipe = create_frame_pipeline(cfg)
    frames = []
    open_events, clear_events = {}, []
    occupied_frames = dict.fromkeys((table["id"] for table in tables), 0)
    out.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=out) as directory:
        mp4 = Path(directory) / f"{SAMPLE}.mp4"
        with (open_encoder(ffmpeg, mp4) if encode_video else nullcontext()) as encoder:
            for index, image in enumerate(sampled_frames(video, cfg.fps)):
                frame = camera_frame(image, index, cfg)
                if observer:
                    observation = observer(pipe, frame, zones)
                else:
                    observation = pipe.step(frame, zones)
                if index % (cfg.fps // PREVIEW_FPS):
                    continue
                result = observation.result
                row = result.to_dict()
                people = [p[:4] + [box[4], table_ids.get(p[4])]
                          for p, box in zip(row["persons"], pipe.person_boxes, strict=True)]
                counts = result.counts
                occupied = [table_ids[zid] for zid in counts.occupiedTables]
                clearing = [table_ids[zid] for zid in counts.tablesToClear]
                t = round(frame.capture_t, 3)
                for zid in occupied:
                    occupied_frames[zid] += 1
                for zid in clearing:
                    open_events.setdefault(zid, t)
                for zid in open_events.keys() - set(clearing):
                    clear_events.append({"table": zid, "shownT": open_events.pop(zid),
                                         "toT": round(t - 1/PREVIEW_FPS, 3), "hiddenT": t})
                frames.append({"t": t, "persons": people, "cups": row["cups"], "counts": {
                    "inStore": counts.inStore, "seated": counts.occupants,
                    "inStoreRaw": counts.inStoreRaw, "seatedRaw": counts.occupantsRaw,
                    "occupiedTables": occupied, "tablesToClear": clearing,
                }})
                if encoder:
                    encoder.stdin.write(cv2.resize(image, (W, H), interpolation=cv2.INTER_AREA).tobytes())
            if encoder:
                encoder.stdin.close()
                if encoder.wait() != 0:
                    raise RuntimeError(f"Could not encode {video}")
        if not frames:
            raise ValueError(f"No sampled frames in {video}")
        if not encode_video:
            check_preview(out / mp4.name, len(frames))
        for zid, shown in open_events.items():
            clear_events.append({"table": zid, "shownT": shown, "toT": frames[-1]["t"],
                                 "hiddenT": round(len(frames)/PREVIEW_FPS, 3)})
        counts = [f["counts"]["inStore"] for f in frames]
        data = {
            "source": "Team-recorded store sample", "fps": PREVIEW_FPS, "frameCount": len(frames),
            "width": W, "height": H, "frames": frames, "tables": tables,
            "summary": {
                "avgInStore": round(sum(counts)/len(counts), 2), "maxInStore": max(counts),
                "tableOccupiedSeconds": {k: round(n/PREVIEW_FPS, 1) for k, n in occupied_frames.items()},
                "tablesToClearEvents": sorted(clear_events, key=lambda item: (item["shownT"], item["table"])),
                "smoothing": {
                    "minTrackFrames": 2, "personHoldSeconds": PERSON_HOLD_SEC,
                    "personEnterSeconds": PERSON_ENTER_SEC,
                    "cupConfirmations": CUP_CONFIRMATIONS, "cupTimeoutSeconds": CUP_TIMEOUT_SEC,
                    "personModel": cfg.model, "personInput": cfg.imgsz, "personHz": cfg.detect_hz,
                    "cupModel": CUP_MODEL, "cupInput": CUP_IMGSZ, "cupScanHz": CUP_SCAN_HZ,
                    "runtime": cfg.runtime, "cameraFps": cfg.fps, "zonesRevision": zones.revision,
                },
            },
        }
        detections = Path(directory) / f"{SAMPLE}-detections.json"
        detections.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        if encode_video:
            mp4.replace(out / mp4.name)
        detections.replace(out / detections.name)
    print(f"{len(frames)} frames at {PREVIEW_FPS} fps")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--output-dir", type=Path, default=OUT)
    parser.add_argument("--encode-video", action="store_true", help="Replace the preview MP4 alongside the detections")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="Path to an ffmpeg with libx264, for --encode-video")
    args = parser.parse_args()
    export_video(args.video, args.ffmpeg, args.encode_video, args.output_dir)

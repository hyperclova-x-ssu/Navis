#!/usr/bin/env node
/* global process, console */
// Gallery renderer (D-82): example code + example photos + example captions (미학당) are opened ONCE in the
// isolated recorder; the same run writes poster.jpg (360x640 at meta.posterAt) and preview.mp4
// (meta.previewFrom..previewTo, 360x640, 30fps, h264, no audio, +faststart). Never runs on owner requests.
//
// Usage (from frontend):
//   node server/promo/references/tools/render-gallery.mjs [ref-1 ref-2 ...] [--full <dir>] [--skip-check]
//   --full <dir>  also writes the full-length mp4 (720x1280, music + 0.6s fade like merge) and three frames
//                 (start / middle / ending) into <dir> for review. Not used by the app.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkExample } from './check-example.mjs';
import { openScene } from './lib/recorder.mjs';
import { findFfmpeg, loadCatalog, loadReference, loadRules, MUSIC_DIR, readJson } from './lib/env.mjs';

const FPS = 30;

function run(bin, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}: ${err}`))));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

// Starts ffmpeg reading JPEG frames from stdin. Returns {write(buf), done()}.
function encoder(bin, args) {
  const p = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
  const closed = new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))));
  });
  return {
    write: (buf) => new Promise((resolve) => (p.stdin.write(buf) ? resolve() : p.stdin.once('drain', resolve))),
    done: async () => {
      p.stdin.end();
      await closed;
    },
  };
}

function pickTrack(moods) {
  const tracks = readJson(path.join(MUSIC_DIR, 'music.json'));
  const list = Array.isArray(tracks) ? tracks : tracks.tracks;
  const ko = { lively: '활기찬', warm: '따뜻한', elegant: '고급스러운', clean: '깔끔한' };
  for (const m of ['lively', 'warm', 'elegant', 'clean']) {
    if (!moods.includes(m)) continue;
    const t = list.find((x) => x.moods.includes(m) || x.moods.includes(ko[m]));
    if (t) return t;
  }
  return list[0];
}

export async function renderGallery(id, { full = null, skipCheck = false, log = console.log } = {}) {
  const ff = findFfmpeg();
  if (!ff) throw Object.assign(new Error('ffmpeg not found'), { code: 'TOOL_MISSING' });
  const rules = loadRules();
  const catalog = loadCatalog();
  const ref = loadReference(id);
  const { meta, story } = ref;
  if (!skipCheck) {
    const r = await checkExample(id, { rules, catalog });
    const n = r.story.length + r.scene.length;
    if (n) throw new Error(`${id}: example fails checks (${n} violations): ${JSON.stringify([...r.story, ...r.scene].slice(0, 5))}`);
  }
  const L = story.lengthSec;
  const sc = await openScene({ html: ref.html, story, catalog, scale: 2 / 3 });
  try {
    // poster
    await sc.seek(meta.posterAt);
    const posterSrc = await sc.shot({ quality: 95 });
    await run(ff.ffmpeg, ['-y', '-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', '-', '-vf', 'scale=360:640:flags=lanczos', '-q:v', '3', path.join(ref.dir, 'poster.jpg')], posterSrc);

    // preview (silent loop clip)
    const from = Math.round(meta.previewFrom * FPS);
    const to = Math.round(meta.previewTo * FPS);
    const enc = encoder(ff.ffmpeg, [
      '-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-vf', 'scale=360:640:flags=lanczos', '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-crf', '24',
      '-preset', 'slow', '-r', String(FPS), '-an', '-movflags', '+faststart', path.join(ref.dir, 'preview.mp4'),
    ]);
    for (let i = from; i < to; i++) {
      await sc.seek(i / FPS);
      await enc.write(await sc.shot({ quality: 92 }));
    }
    await enc.done();
    log(`${id}: poster.jpg @${meta.posterAt}s, preview.mp4 ${meta.previewFrom}-${meta.previewTo}s (${to - from} frames)`);

    if (full) {
      mkdirSync(full, { recursive: true });
      const track = pickTrack(meta.moods);
      const out = path.join(full, `${id}-example-${L}s.mp4`);
      const fadeAt = (L - rules.fadeOutSec).toFixed(2);
      const fenc = encoder(ff.ffmpeg, [
        '-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
        '-i', path.join(MUSIC_DIR, track.file ?? `${track.trackId}.m4a`),
        '-filter_complex', `[0:v]fade=t=out:st=${fadeAt}:d=${rules.fadeOutSec},format=yuv420p[v];[1:a]atrim=0:${L},asetpts=N/SR/TB,afade=t=out:st=${fadeAt}:d=${rules.fadeOutSec}[a]`,
        '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(FPS),
        '-c:a', 'aac', '-b:a', '128k', '-t', String(L), '-movflags', '+faststart', out,
      ]);
      const frames = { start: 1.0, middle: meta.posterAt, ending: L - 1.0 };
      const wanted = new Map(Object.entries(frames).map(([k, t]) => [Math.round(t * FPS), k]));
      const total = Math.round(L * FPS);
      for (let i = 0; i < total; i++) {
        await sc.seek(i / FPS);
        const buf = await sc.shot({ quality: 92 });
        if (wanted.has(i)) writeFileSync(path.join(full, `${id}-frame-${wanted.get(i)}.jpg`), buf);
        await fenc.write(buf);
      }
      await fenc.done();
      log(`${id}: full ${out} (${total} frames, music ${track.trackId}), frames ${JSON.stringify(frames)}`);
    }
    const forbidden = await sc.forbidden();
    if (forbidden.length || sc.records.errors.length || sc.records.blocked.length) {
      throw new Error(`${id}: runtime problems during render: ${JSON.stringify({ forbidden, ...sc.records })}`);
    }
  } finally {
    await sc.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let full = null;
  let skipCheck = false;
  const ids = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--full') full = path.resolve(args[++i]);
    else if (args[i] === '--skip-check') skipCheck = true;
    else ids.push(args[i]);
  }
  for (const id of ids.length ? ids : ['ref-1', 'ref-2', 'ref-3']) {
    const t0 = Date.now();
    await renderGallery(id, { full, skipCheck });
    console.log(`${id}: done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

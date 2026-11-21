// 녹화기 (ARCHITECTURE 12.4 merge·12.8·12.9 5번). 격리 Chrome에서 t = i/30마다 시간을 맞춰 JPEG로 찍어
// ffmpeg stdin(h264)으로 보내고, 2차로 음원·끝 어두워짐·faststart를 넣은 뒤 ffprobe·signalstats로 확인한다.
// T-084 갤러리 도구도 같은 함수(recordVideo)를 쓴다(audio 없음, fadeOutSec 0, 360×640).
import { spawn } from 'node:child_process';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { PromoError } from './errors.mjs';
import { openScene } from './renderer.mjs';
import { capture } from './config.mjs';

export const FPS = 30;

function terminate(child) {
  if (!child) return;
  if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); return; } catch {} }
  try { child.kill('SIGKILL'); } catch {}
}

function startEncoder({ ffmpeg, h264, width, height, out, fadeOutSec, lengthSec, spawnProcess = spawn }) {
  const filters = [`scale=${width}:${height}:flags=lanczos:in_range=pc:out_range=tv`, 'format=yuv420p'];
  if (fadeOutSec > 0) filters.push(`fade=t=out:st=${(lengthSec - fadeOutSec).toFixed(3)}:d=${fadeOutSec}`);
  const codec = h264 === 'libx264' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] : ['-c:v', h264, '-b:v', '6M'];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', filters.join(','), ...codec, '-r', String(FPS), '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out];
  const child = spawnProcess(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], shell: false, detached: process.platform !== 'win32' });
  const done = new Promise(resolve => {
    child.on('error', () => resolve(-1));
    child.on('close', code => resolve(code));
  });
  child.stderr?.resume();
  child.stdin.on('error', () => {});
  const write = buf => new Promise((resolve, reject) => {
    if (child.stdin.destroyed) { reject(new PromoError('ENCODE_FAILED')); return; }
    if (child.stdin.write(buf)) resolve(); else child.stdin.once('drain', resolve);
  });
  return { child, write, end: () => { child.stdin.end(); return done; } };
}

async function run(command, args, timeoutMs) {
  const res = await capture(command, args, { timeoutMs });
  return res;
}

/**
 * @param {{html, lengthSec, assets:Map, fonts, browserPath, ffmpeg:{ffmpeg,ffprobe,h264}, outFile, width?, height?, audio?:{file}, fadeOutSec?, signal?, timeoutMs?, chromium?, readFont?, from?, to?}} a
 * from/to(초)를 주면 그 구간만 녹화한다(갤러리 미리보기).
 * @returns {Promise<{file, frames, renderMs, encodeMs}>}
 */
export async function recordVideo(a) {
  const width = a.width ?? 720; const height = a.height ?? 1280;
  const from = a.from ?? 0; const to = a.to ?? a.lengthSec;
  const span = to - from;
  const frames = Math.round(span * FPS);
  const fade = a.fadeOutSec ?? 0;
  const silent = `${a.outFile}.video.mp4`;
  const started = Date.now();
  const deadline = started + (a.timeoutMs ?? (4 * a.lengthSec + 30) * 1000);
  const opened = await openScene({ html: a.html, assets: a.assets, fonts: a.fonts || [], browserPath: a.browserPath, scale: width / 1080, opTimeoutMs: 10000, chromium: a.chromium, readFont: a.readFont || readFile });
  if (!opened.ok) throw new PromoError('RENDER_FAILED');
  let encoder;
  try {
    encoder = startEncoder({ ffmpeg: a.ffmpeg.ffmpeg, h264: a.ffmpeg.h264, width, height, out: silent, fadeOutSec: fade, lengthSec: span });
    const abort = () => terminate(encoder.child);
    a.signal?.addEventListener?.('abort', abort, { once: true });
    try {
      for (let i = 0; i < frames; i++) {
        if (a.signal?.aborted || Date.now() > deadline) throw new PromoError('RENDER_FAILED');
        try { await opened.seek(from + i / FPS, 2000); } catch { throw new PromoError('RENDER_FAILED'); }
        let shot;
        try { shot = await opened.screenshot(5000); } catch { throw new PromoError('RENDER_FAILED'); }
        await encoder.write(shot);
      }
    } finally { a.signal?.removeEventListener?.('abort', abort); }
  } catch (err) {
    if (encoder) terminate(encoder.child);
    await opened.close();
    await rm(silent, { force: true });
    throw err instanceof PromoError ? err : new PromoError('RENDER_FAILED');
  }
  await opened.close();
  const renderMs = Date.now() - started;
  const code = await encoder.end();
  if (code !== 0) { await rm(silent, { force: true }); throw new PromoError('ENCODE_FAILED'); }
  if (a.audio?.file) {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-i', a.audio.file, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
      '-af', `atrim=0:${span},asetpts=PTS-STARTPTS${fade > 0 ? `,afade=t=out:st=${(span - fade).toFixed(3)}:d=${fade}` : ''}`,
      '-c:a', 'aac', '-b:a', '128k', '-t', String(span), '-movflags', '+faststart', a.outFile];
    const res = await run(a.ffmpeg.ffmpeg, args, 60000);
    await rm(silent, { force: true });
    if (res.code !== 0) throw new PromoError('ENCODE_FAILED');
  } else {
    await rename(silent, a.outFile);
  }
  return { file: a.outFile, frames, renderMs, encodeMs: Date.now() - started - renderMs };
}

/** ffprobe로 길이·해상도·코덱. */
export async function probeVideo(ffprobe, file) {
  const res = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt:format=duration,size', '-of', 'json', file], 20000);
  if (res.code !== 0) throw new PromoError('ENCODE_FAILED');
  const info = JSON.parse(res.stdout);
  const video = info.streams?.find(s => s.codec_type === 'video');
  const audio = info.streams?.find(s => s.codec_type === 'audio');
  const [num, den] = String(video?.r_frame_rate || '0/1').split('/').map(Number);
  return {
    durationSec: Number(info.format?.duration), sizeBytes: Number(info.format?.size) || (await stat(file)).size,
    width: video?.width, height: video?.height, videoCodec: video?.codec_name, pixFmt: video?.pix_fmt, fps: den ? num / den : 0, audioCodec: audio?.codec_name ?? null,
  };
}

/** signalstats YAVG(0~255)의 프레임 차가 큰 변화가 어떤 1초 안에 maxPerSec번을 넘으면 번쩍임. */
export function flashViolations(yavg, { maxPerSec = 3, yavgDelta = 48 } = {}, fps = FPS) {
  const big = [];
  for (let i = 1; i < yavg.length; i++) if (Math.abs(yavg[i] - yavg[i - 1]) > yavgDelta) big.push(i);
  const v = [];
  for (let i = 0; i < big.length; i++) {
    let j = i; while (j + 1 < big.length && big[j + 1] - big[i] < fps) j++;
    if (j - i + 1 > maxPerSec) { v.push({ t: Math.round((big[i] / fps) * 100) / 100, rule: 'video.flash', limit: `≤ ${maxPerSec}/s`, actual: `${j - i + 1}/s` }); break; }
  }
  return v;
}

export async function measureLuma(ffmpeg, file) {
  const res = await capture(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-', '-an', '-f', 'null', '-'], { timeoutMs: 60000 });
  if (res.code !== 0) throw new PromoError('ENCODE_FAILED');
  return [...res.stdout.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(m => Number(m[1]));
}

/** 녹화 뒤 확인(12.9의 5): 길이·해상도·코덱 + 번쩍임. */
export async function checkVideo({ ffmpeg, file, lengthSec, rules, width = 720, height = 1280, expectAudio = true }) {
  const info = await probeVideo(ffmpeg.ffprobe, file);
  const v = [];
  if (!(Math.abs(info.durationSec - lengthSec) <= 0.1)) v.push({ rule: 'video.duration', limit: `${lengthSec}±0.1`, actual: info.durationSec });
  if (info.width !== width || info.height !== height || info.videoCodec !== 'h264' || (expectAudio && info.audioCodec !== 'aac')) v.push({ rule: 'video.duration', limit: `${width}x${height} h264${expectAudio ? '+aac' : ''}`, actual: `${info.width}x${info.height} ${info.videoCodec}+${info.audioCodec}` });
  const luma = await measureLuma(ffmpeg.ffmpeg, file);
  v.push(...flashViolations(luma, rules.flash));
  return { info, violations: v };
}

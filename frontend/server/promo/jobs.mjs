// 작업 큐 (ARCHITECTURE 12.6, DATA_MODEL 10.16.4). 동시 1개, 한 번만 키, BUSY, 12분 상한,
// 재시작 때 running → CANCELLED_BY_RESTART, 완료 보관 10개, 시작 때 24시간 지난 작업 폴더 삭제.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PromoError, reasonOf } from './errors.mjs';
import { appendStats } from './estimate.mjs';
import { writeJson } from './pipeline.mjs';
import { PROMPT_VERSION } from './prompts.mjs';

export const JOB_ID = /^pj-[0-9a-f]{12}$/;
export const STAGES = ['look', 'story', 'scenes', 'merge'];
const DAY_MS = 24 * 60 * 60 * 1000;

export class BusyError extends Error { constructor(activeJobId) { super('BUSY'); this.activeJobId = activeJobId; } }

/**
 * deps: { dir, pipeline, tools: () => Promise<{claude, browser, ffmpeg}>, requireClaude?, model, referenceVersion,
 *         now?, newId?, capMs?, keepDone?, maxAgeMs?, onSettled? }
 */
export function createJobStore(deps) {
  const now = deps.now || (() => new Date());
  const newId = deps.newId || (() => `pj-${randomBytes(6).toString('hex')}`);
  const capMs = deps.capMs ?? 12 * 60 * 1000;
  const keepDone = deps.keepDone ?? 10;
  const maxAgeMs = deps.maxAgeMs ?? DAY_MS;
  const jobsDir = join(deps.dir, 'jobs');
  const statsFile = join(deps.dir, 'stats.json');
  const jobs = new Map(); const byKey = new Map();
  let active = null; let closed = false;
  const running = new Set();

  const persist = job => writeJson(join(job.dir, 'job.json'), serialize(job));
  function serialize(job) {
    const { dir: _dir, controller: _c, promise: _p, ...rest } = job;
    return rest;
  }

  async function init() {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(join(deps.dir, 'cache', 'photo-meta'), { recursive: true });
    const entries = await readdir(jobsDir, { withFileTypes: true });
    const t = now().getTime();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(jobsDir, entry.name);
      let job;
      try { job = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')); } catch { if (JOB_ID.test(entry.name)) await rm(dir, { recursive: true, force: true }); continue; }
      if (!JOB_ID.test(job.jobId) || job.jobId !== entry.name) continue;
      if (t - Date.parse(job.finishedAt || job.startedAt) > maxAgeMs) { await rm(dir, { recursive: true, force: true }); continue; }
      job.dir = dir;
      if (job.status === 'queued' || job.status === 'running') {
        Object.assign(job, { status: 'failed', stageState: 'failed', failReason: 'CANCELLED_BY_RESTART', finishedAt: now().toISOString() });
        await persist(job);
      }
      jobs.set(job.jobId, job);
      if (job.idempotencyKey) byKey.set(job.idempotencyKey, job.jobId);
    }
    await prune();
  }

  async function prune() {
    const done = [...jobs.values()].filter(j => j.status === 'done').sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
    for (const job of done.slice(keepDone)) {
      jobs.delete(job.jobId); byKey.delete(job.idempotencyKey);
      await rm(job.dir, { recursive: true, force: true });
    }
  }

  function view(job, { accepted = false } = {}) {
    const base = { jobId: job.jobId, status: job.status, stage: job.stage, stageState: job.stageState, lookCount: job.lookCount, startedAt: job.startedAt };
    if (job.retryOf) base.retryOf = job.retryOf;
    if (accepted) return base;
    return { ...base, stageStartedAt: job.stageStartedAt, failReason: job.failReason ?? null, result: job.status === 'done' ? job.publicResult : null };
  }

  async function create({ input, idempotencyKey, retryOf = null }) {
    if (closed) throw new PromoError('AI_UNAVAILABLE');
    const existing = byKey.get(idempotencyKey);
    if (existing && jobs.has(existing)) return { job: jobs.get(existing), existing: true };
    if (active) throw new BusyError(active.jobId);
    let jobId = newId();
    while (jobs.has(jobId)) jobId = newId();
    const t = now().toISOString();
    const job = {
      jobId, idempotencyKey, retryOf, input: structuredClone(input), status: 'queued', stage: 'look', stageState: 'active',
      lookCount: input.photoIds.length, startedAt: t, stageStartedAt: t, finishedAt: null, failReason: null,
      stageMs: { look: 0, story: 0, scenes: 0, merge: 0 }, usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
      promptVersion: PROMPT_VERSION, referenceVersion: deps.referenceVersion, model: deps.model,
      fixCount: 0, storyRewriteCount: 0, checks: [], checkSummary: null, result: null, publicResult: null,
      dir: join(jobsDir, jobId),
    };
    active = job; jobs.set(jobId, job); byKey.set(idempotencyKey, jobId);
    await mkdir(job.dir, { recursive: true });
    await writeJson(join(job.dir, 'input.json'), job.input);
    await persist(job);
    job.promise = run(job);
    running.add(job.promise);
    job.promise.finally(() => running.delete(job.promise));
    return { job, existing: false };
  }

  async function enter(job, stage, stageStart) {
    if (job.stage !== stage) {
      job.stageMs[job.stage] = Date.now() - stageStart.at;
      job.stage = stage; job.stageState = 'active'; job.stageStartedAt = now().toISOString();
      stageStart.at = Date.now();
      await persist(job);
    }
  }

  async function run(job) {
    const controller = new AbortController();
    job.controller = controller;
    const cap = setTimeout(() => { job.capped = true; controller.abort(); }, capMs);
    const signal = controller.signal;
    const stageStart = { at: Date.now() };
    await new Promise(resolve => setImmediate(resolve));
    job.status = 'running';
    try {
      const tools = await deps.tools();
      if ((deps.requireClaude !== false && !tools.claude) || !tools.browser || !tools.ffmpeg) throw new PromoError('TOOL_MISSING');
      const p = deps.pipeline;
      const metas = await p.look(job, { signal });
      await enter(job, 'story', stageStart);
      const story = await p.story(job, { signal, metas });
      await enter(job, 'scenes', stageStart);
      const scene = await p.scenes(job, { signal, story });
      await enter(job, 'merge', stageStart);
      const merged = await p.merge(job, { signal, story, scene });
      if (signal.aborted) throw new PromoError(job.capped ? 'RENDER_FAILED' : 'CANCELLED_BY_RESTART');
      job.stageMs.merge = Date.now() - stageStart.at;
      const info = merged.info;
      const durationSec = Math.round(info.durationSec * 100) / 100;
      job.result = { durationSec, width: info.width, height: info.height, fps: 30, sizeBytes: info.sizeBytes, musicTrackId: merged.music?.trackId ?? null, fixCount: job.fixCount, storyRewriteCount: job.storyRewriteCount };
      job.publicResult = {
        durationSec, width: info.width, height: info.height, fps: 30, sizeBytes: info.sizeBytes,
        fileUrl: `/api/promo/jobs/${job.jobId}/video.mp4`,
        music: merged.music ? { trackId: merged.music.trackId, title: merged.music.title, artist: merged.music.artist, license: merged.music.license } : null,
        fixCount: job.fixCount,
      };
      Object.assign(job, { status: 'done', stageState: 'done', finishedAt: now().toISOString() });
      if (active === job) active = null; // 끝난 상태가 보이는 순간 다음 작업을 받을 수 있게
      await persist(job);
      await appendStats(statsFile, { lengthSec: job.input.lengthSec, photoCount: job.input.photoIds.length, stageMs: job.stageMs, usage: job.usage, fixCount: job.fixCount, storyRewriteCount: job.storyRewriteCount }).catch(() => {});
      await prune();
    } catch (err) {
      job.stageMs[job.stage] = Date.now() - stageStart.at;
      if (process.env.NAVIS_PROMO_DEBUG) process.stderr.write(`promo job ${job.jobId} ${job.stage}: ${err?.code || err?.name || 'error'}\n`);
      let reason = reasonOf(err);
      if (job.capped) reason = job.stage === 'merge' ? 'RENDER_FAILED' : 'AI_TIMEOUT';
      else if (closed) reason = 'CANCELLED_BY_RESTART';
      if (!reason) reason = job.stage === 'merge' ? 'ENCODE_FAILED' : job.stage === 'scenes' ? 'RENDER_FAILED' : 'AI_BAD_OUTPUT';
      Object.assign(job, { status: 'failed', stageState: 'failed', failReason: reason, finishedAt: now().toISOString() });
      if (active === job) active = null;
      if (!closed) await persist(job).catch(() => {});
    } finally {
      clearTimeout(cap);
      if (active === job) active = null;
      deps.onSettled?.(job);
    }
  }

  return {
    init,
    create,
    get: id => jobs.get(id) || null,
    view,
    active: () => active,
    /** 서버 종료: 진행 중 작업의 자식 프로세스를 끊는다. job.json에는 running이 남아 다음 시작 때 CANCELLED_BY_RESTART가 된다. */
    async close() { closed = true; active?.controller?.abort(); await Promise.allSettled([...running]); },
    async idle() { await Promise.allSettled([...running]); },
    jobs,
    writeRaw: (job, name, data) => writeFile(join(job.dir, name), data),
  };
}

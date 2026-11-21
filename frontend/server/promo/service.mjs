// /api/promo/* 라우터 (API_CONTRACT v4.4 API-20~25·27). dev(vite-plugin)와 preview가 같은 함수를 마운트한다.
// 공통 보안: 루프백 소켓과 로컬 또는 설정된 HTTPS 출처 확인, POST는 Origin 필수·application/json·본문 16KB 이하.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClovaStudio } from '../clova-studio.mjs';
import { privateOriginAllowed } from '../private-origin.mjs';
import { availability, detectTools, readConfig } from './config.mjs';
import { createClaudeApiRunner, createClaudeCliRunner } from './scene-provider.mjs';
import { runSceneCheck } from './check-scene.mjs';
import { buildEstimateModel, loadBase, readStats } from './estimate.mjs';
import { createHcxRunner, HCX_PHOTO_MODEL } from './hcx-runner.mjs';
import { BusyError, JOB_ID, createJobStore } from './jobs.mjs';
import { PHOTO_ID, createExamplePhotoSource } from './photo-source.mjs';
import { createPipeline } from './pipeline.mjs';
import { CONCEPTS, MOODS } from './prompts.mjs';
import { checkVideo, recordVideo } from './recorder.mjs';
import { REFERENCE_ID, listReferences, loadReferences } from './references.mjs';

const MAX_BODY = 16 * 1024;
const LOCALES = ['ko', 'en', 'zh-Hans', 'zh-Hant'];
const LENGTHS = [10, 15, 30];
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const CONTROL = /\p{Cc}/u;
const MUSIC_DIR = fileURLToPath(new URL('./assets/music/', import.meta.url));

const json = (res, status, body, extra = {}) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(JSON.stringify(body));
};
const fail = (res, status, code, more = {}) => json(res, status, { code, ...more });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let over = false;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) over = true; else chunks.push(c); });
    req.on('end', () => { if (over) return reject(413); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(400); } });
    req.on('error', () => reject(400));
  });
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const uniqueStrings = (v, allowed, min = 1) => Array.isArray(v) && v.length >= min && v.every(x => typeof x === 'string' && (!allowed || allowed.includes(x))) && new Set(v).size === v.length;

/** API-22 입력 검증. 틀리면 400 field 이름을 돌려준다. */
export function validateInput(input, catalog, references) {
  const KEYS = ['menuIds', 'photoIds', 'moods', 'concepts', 'memo', 'referenceId', 'lengthSec', 'locale'];
  if (!isObj(input)) return 'input';
  const extra = Object.keys(input).find(k => !KEYS.includes(k));
  if (extra) return extra;
  const menuIds = catalog.menus.map(m => m.menuId);
  if (!uniqueStrings(input.menuIds, menuIds)) return 'menuIds';
  const allowedPhotos = new Set(catalog.menus.filter(m => input.menuIds.includes(m.menuId)).flatMap(m => m.photoIds));
  if (!uniqueStrings(input.photoIds, null, 5) || input.photoIds.some(id => !PHOTO_ID.test(id) || !allowedPhotos.has(id))) return 'photoIds';
  if (!uniqueStrings(input.moods, MOODS)) return 'moods';
  if (!uniqueStrings(input.concepts, CONCEPTS)) return 'concepts';
  if (typeof input.memo !== 'string' || [...input.memo].length > 100 || CONTROL.test(input.memo)) return 'memo';
  if (typeof input.referenceId !== 'string' || !REFERENCE_ID.test(input.referenceId) || !references.refs.has(input.referenceId)) return 'referenceId';
  if (!LENGTHS.includes(input.lengthSec)) return 'lengthSec';
  if (!LOCALES.includes(input.locale)) return 'locale';
  return null;
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start; let end;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) return null;
  return { start, end };
}

/** 파일 보내기(Range 지원). */
async function sendFile(req, res, file, type, { cache = 'no-store', disposition } = {}) {
  let info;
  try { info = await stat(file); } catch { return fail(res, 404, 'NOT_FOUND'); }
  if (!info.isFile()) return fail(res, 404, 'NOT_FOUND');
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': cache, 'x-content-type-options': 'nosniff' };
  if (disposition) headers['content-disposition'] = disposition;
  const size = info.size;
  let status = 200; let range = null;
  if (req.headers.range) {
    range = parseRange(req.headers.range, size);
    if (!range) { res.writeHead(416, { 'content-range': `bytes */${size}`, ...headers }); res.end(); return; }
    status = 206; headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
  }
  headers['content-length'] = String(range ? range.end - range.start + 1 : size);
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file, range ? { start: range.start, end: range.end } : undefined);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/**
 * createPromoService(deps): 연결 미들웨어 (req, res, next). deps는 시험·스모크에서 바꿔 끼운다.
 * deps: { env, config, allowedOrigins, photoSource, references, referencesDir, tools, detect, runner, storyRunner, spawnProcess, fetchImpl, pipeline(부분 덮어쓰기),
 *         checkScene, renderVideo, checkVideo, music, musicDir, estimateBasePath, now, newId, capMs, chromium }
 */
export function createPromoService(deps = {}) {
  const env = deps.env || process.env;
  const origins = deps.allowedOrigins ?? new Map();
  const config = { ...readConfig(env), ...deps.config };
  const photoSource = deps.photoSource || createExamplePhotoSource({ sourceId: config.photoSource });
  const references = deps.references || loadReferences(deps.referencesDir);
  const musicDir = deps.musicDir || MUSIC_DIR;
  const music = deps.music || (existsSync(join(musicDir, 'music.json')) ? JSON.parse(readFileSync(join(musicDir, 'music.json'), 'utf8')) : []);
  const base = loadBase(deps.estimateBasePath);
  let toolsPromise = null;
  const tools = () => (toolsPromise ??= deps.tools ? Promise.resolve(deps.tools) : (deps.detect || detectTools)({ env }));
  let videoRunner = deps.runner;
  const getVideoRunner = async () => (videoRunner ??= createClaudeCliRunner({ command: (await tools()).claude, model: config.model, spawnProcess: deps.spawnProcess, env }));
  const transport = createClovaStudio({ apiKey: env.CLOVASTUDIO_API_KEY, baseUrl: env.CLOVASTUDIO_BASE_URL, fetchImpl: deps.fetchImpl });
  const storyRunner = deps.storyRunner ?? deps.runner ?? createHcxRunner({ transport });
  const browserPath = async () => (await tools()).browser;
  const ffmpeg = async () => (await tools()).ffmpeg;
  // D-327 Q7: the default scene provider uses the pipeline's Claude CLI runner.
  const sceneRunner = config.sceneProvider === 'naver' ? createHcxRunner({ stage: 'scenes', transport })
    : config.sceneProvider === 'claude-api' ? createClaudeApiRunner({ approved: config.claudeApiApproved, model: config.model })
      : null;
  const requireClaude = config.sceneProvider === 'claude' || !config.hcxLookEnabled;
  const pipeline = createPipeline({
    runner: { run: async req => (await getVideoRunner()).run(req) }, storyRunner,
    ...(config.hcxLookEnabled ? { lookRunner: createHcxRunner({ stage: 'look', transport }), lookModel: `clova-${HCX_PHOTO_MODEL}` } : {}),
    ...(sceneRunner ? { sceneRunner } : {}),
    photoSource, references, music, musicDir, cacheDir: join(config.dir, 'cache'), model: config.model, fault: config.fault,
    checkScene: deps.checkScene || (async a => runSceneCheck({ ...a, browserPath: await browserPath(), chromium: deps.chromium })),
    renderVideo: deps.renderVideo || (async a => recordVideo({ ...a, browserPath: await browserPath(), ffmpeg: await ffmpeg(), chromium: deps.chromium })),
    checkVideo: deps.checkVideo || (async a => checkVideo({ ...a, ffmpeg: await ffmpeg() })),
    ...deps.pipeline,
  });
  const store = createJobStore({ dir: config.dir, pipeline: deps.pipelineImpl || pipeline, tools, requireClaude, model: storyRunner.model ?? config.model, referenceVersion: references.version, now: deps.now, newId: deps.newId, capMs: deps.capMs, keepDone: deps.keepDone });
  const ready = store.init();
  ready.catch(() => {});
  if (!deps.tools && !deps.lazyTools) tools().catch(() => {});

  async function estimateModel() {
    const samples = await readStats(join(config.dir, 'stats.json'));
    const maxPhotos = photoSource.listCatalog().photos.length;
    return buildEstimateModel({ base, samples, maxPhotos, krwPerUsd: env.NAVIS_PROMO_KRW_PER_USD ? config.krwPerUsd : base.krwPerUsd ?? config.krwPerUsd, available: availability(await tools()) });
  }

  async function startJob(req, res, makeInput) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return fail(res, 413, 'PAYLOAD_TOO_LARGE');
    let body;
    try { body = await readBody(req); } catch (code) { return code === 413 ? fail(res, 413, 'PAYLOAD_TOO_LARGE') : fail(res, 400, 'BAD_REQUEST', { field: 'body' }); }
    if (!isObj(body)) return fail(res, 400, 'BAD_REQUEST', { field: 'body' });
    const made = await makeInput(body);
    if (made.error) return fail(res, made.status || 400, made.code || 'BAD_REQUEST', made.error === true ? {} : { field: made.error });
    try {
      const { job } = await store.create({ input: made.input, idempotencyKey: body.idempotencyKey, retryOf: made.retryOf ?? null });
      return json(res, 202, store.view(job, { accepted: true }));
    } catch (err) {
      if (err instanceof BusyError) return fail(res, 409, 'BUSY', { activeJobId: err.activeJobId });
      return fail(res, 503, 'UNAVAILABLE');
    }
  }

  async function handle(req, res, path, query) {
    const method = req.method;
    const isGet = method === 'GET' || method === 'HEAD';
    let m;
    if (path === '/api/promo/catalog' && isGet) return json(res, 200, photoSource.listCatalog());
    if ((m = /^\/api\/promo\/photos\/([^/]+)$/.exec(path)) && isGet) {
      if (!PHOTO_ID.test(m[1])) return fail(res, 404, 'NOT_FOUND');
      const photo = await photoSource.readPhoto(m[1]);
      if (!photo) return fail(res, 404, 'NOT_FOUND');
      res.writeHead(200, { 'content-type': photo.mediaType, 'content-length': String(photo.bytes.length), 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
      return res.end(method === 'HEAD' ? undefined : photo.bytes);
    }
    if (path === '/api/promo/estimate-model' && isGet) return json(res, 200, await estimateModel());
    if (path === '/api/promo/references' && isGet) return json(res, 200, listReferences(references));
    if ((m = /^\/api\/promo\/references\/([^/]+)\/(poster\.jpg|preview\.mp4)$/.exec(path)) && isGet) {
      const ref = REFERENCE_ID.test(m[1]) ? references.refs.get(m[1]) : null;
      if (!ref) return fail(res, 404, 'NOT_FOUND');
      return m[2] === 'poster.jpg' ? sendFile(req, res, ref.posterPath, 'image/jpeg', { cache: 'max-age=3600' }) : sendFile(req, res, ref.previewPath, 'video/mp4', { cache: 'max-age=3600' });
    }
    if (path === '/api/promo/jobs' && method === 'POST') {
      return startJob(req, res, async body => {
        if (Object.keys(body).some(k => !['idempotencyKey', 'input'].includes(k))) return { error: Object.keys(body).find(k => !['idempotencyKey', 'input'].includes(k)) };
        if (typeof body.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) return { error: 'idempotencyKey' };
        const field = validateInput(body.input, photoSource.listCatalog(), references);
        if (field) return { error: field === 'input' ? 'input' : field };
        return { input: { menuIds: body.input.menuIds, photoIds: body.input.photoIds, moods: body.input.moods, concepts: body.input.concepts, memo: body.input.memo, referenceId: body.input.referenceId, lengthSec: body.input.lengthSec, locale: body.input.locale } };
      });
    }
    if ((m = /^\/api\/promo\/jobs\/([^/]+)\/retry$/.exec(path)) && method === 'POST') {
      return startJob(req, res, async body => {
        if (Object.keys(body).some(k => k !== 'idempotencyKey')) return { error: 'body' };
        if (typeof body.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) return { error: 'idempotencyKey' };
        const original = JOB_ID.test(m[1]) ? store.get(m[1]) : null;
        if (!original) return { error: true, status: 404, code: 'NOT_FOUND' };
        if (original.status !== 'failed') return { error: 'status' };
        return { input: original.input, retryOf: original.jobId };
      });
    }
    if ((m = /^\/api\/promo\/jobs\/([^/]+)\/video\.mp4$/.exec(path)) && isGet) {
      const job = JOB_ID.test(m[1]) ? store.get(m[1]) : null;
      if (!job || job.status !== 'done') return fail(res, 404, 'NOT_FOUND');
      let disposition;
      if (query.get('download') === '1') {
        const finished = new Date(job.finishedAt);
        const sameDay = [...store.jobs.values()].filter(j => j.status === 'done' && ymd(new Date(j.finishedAt)) === ymd(finished) && Date.parse(j.finishedAt) <= finished.getTime()).length;
        const name = `${photoSource.listCatalog().store.name}-${ymd(finished)}-${Math.max(1, sameDay)}.mp4`;
        disposition = `attachment; filename="navis-promo-${job.jobId}.mp4"; filename*=UTF-8''${encodeURIComponent(name)}`;
      }
      return sendFile(req, res, join(job.dir, 'final.mp4'), 'video/mp4', { disposition });
    }
    if ((m = /^\/api\/promo\/jobs\/([^/]+)$/.exec(path)) && isGet) {
      const job = JOB_ID.test(m[1]) ? store.get(m[1]) : null;
      if (!job) return fail(res, 404, 'NOT_FOUND');
      return json(res, 200, store.view(job));
    }
    return fail(res, 404, 'NOT_FOUND');
  }

  async function middleware(req, res, next = () => fail(res, 404, 'NOT_FOUND')) {
    const raw = req.url || '';
    const q = raw.indexOf('?');
    const path = q >= 0 ? raw.slice(0, q) : raw;
    if (path !== '/api/promo' && !path.startsWith('/api/promo/')) return next();
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { return fail(res, 400, 'BAD_REQUEST'); }
    if (decoded !== path || path.includes('..') || path.includes('//')) return fail(res, 404, 'NOT_FOUND');
    if (!privateOriginAllowed(req, origins) || (req.method === 'POST' && !req.headers.origin)) return fail(res, 403, 'FORBIDDEN');
    try {
      await ready;
      return await handle(req, res, path, new URLSearchParams(q >= 0 ? raw.slice(q + 1) : ''));
    } catch {
      return fail(res, 503, 'UNAVAILABLE');
    }
  }
  middleware.close = () => store.close();
  middleware.ready = ready;
  middleware.store = store;
  middleware.config = config;
  return middleware;
}

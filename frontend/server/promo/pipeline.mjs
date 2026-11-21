// 파이프라인 4단계 look → story → scenes → merge (ARCHITECTURE 12.4). 단계 구현만 여기 있고
// 상태·시간 제한·저장은 jobs.mjs가 한다. 대본과 장면 구성에는 storyRunner를 쓴다.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { PromoError } from './errors.mjs';
import { checkStory } from './check-story.mjs';
import { staticCheck } from './check-scene.mjs';
import { rangeFor } from './references.mjs';
import { photoAssets } from './renderer.mjs';
import { META_SCHEMA_VERSION, MOODS, MOODS_FILE, PHOTO_META_SCHEMA, PROMPT_VERSION, SCENE_SCHEMA, STORY_SCHEMA, photoMetaPrompt, sceneCodePrompt, sceneFixPrompt, storyPrompt } from './prompts.mjs';
import { validateSchema } from './schema.mjs';

export const MAX_STORY_REWRITES = 2;
export const MAX_FIXES = 2;
export const FAULT_CODES = Object.freeze({ look: 'AI_UNAVAILABLE', story: 'CAPTION_TOO_LONG', scenes: 'CODE_CHECK_FAILED', merge: 'ENCODE_FAILED' });
const TIMEOUTS = { look: 60000, story: 120000, scenes: 180000 };

export async function photoMetaInput(photoSource, photoId, model) {
  const photo = await photoSource.readPhoto(photoId);
  if (!photo) throw new PromoError('AI_BAD_OUTPUT');
  const menuId = photoSource.photoInfo?.(photoId)?.menuId;
  const menuName = (photoSource.listCatalog?.().menus || []).find(menu => menu.menuId === menuId)?.names?.en ?? '';
  const photoHash = createHash('sha256').update(photo.bytes).digest('hex');
  const menuHash = createHash('sha256').update(menuName).digest('hex').slice(0, 8);
  const cacheKey = `${photoHash}-m${META_SCHEMA_VERSION}-${menuHash}-${model.replace(/[^a-z0-9.-]/gi, '_')}`;
  return { cacheKey, request: { prompt: photoMetaPrompt(menuName), images: [photo], schema: PHOTO_META_SCHEMA, timeoutMs: TIMEOUTS.look } };
}

export async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

/** 분위기 우선순위(활기찬 > 따뜻한 > 고급스러운 > 깔끔한)의 첫째에 맞는 첫 곡. 같은 입력이면 같은 곡. */
export function pickMusic(music, moods) {
  for (const mood of MOODS) {
    if (!moods.includes(mood)) continue;
    const label = MOODS_FILE.musicLabels[mood];
    const track = music.find(t => (t.moods || []).includes(label) || (t.moods || []).includes(mood));
    if (track) return track;
  }
  return music[0];
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0; let failed = false;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (err) { failed = true; throw err; }
    }
  }));
  return out;
}

const round3 = n => Math.round(n * 1000) / 1000;
const summarize = violations => {
  const counts = {};
  for (const v of violations) counts[v.rule] = (counts[v.rule] || 0) + 1;
  return counts;
};

/**
 * deps: { runner, lookRunner, storyRunner, sceneRunner, lookModel, photoSource, references, music[], musicDir, cacheDir, model, fault,
 *         checkScene({html, story, rules, store, lengthSec, assets, fonts}) → {violations, checkMs},
 *         renderVideo({html, lengthSec, assets, fonts, outFile, audio, fadeOutSec, signal}) → {file},
 *         checkVideo({file, lengthSec, rules}) → {info, violations} }
 */
export function createPipeline(deps) {
  const { runner, lookRunner = runner, storyRunner = runner, sceneRunner = runner, photoSource, references } = deps;

  async function call(job, request, stageRunner = runner) {
    try {
      const res = await stageRunner.run(request);
      addUsage(job, res.usage);
      return res.output;
    } catch (err) {
      if (err?.usage) addUsage(job, err.usage);
      throw err;
    }
  }
  function addUsage(job, usage) {
    if (!usage) return;
    job.usage.calls += usage.calls || 0; job.usage.inputTokens += usage.inputTokens || 0; job.usage.outputTokens += usage.outputTokens || 0;
  }
  const faultAt = stage => { if (deps.fault === stage) throw new PromoError(FAULT_CODES[stage]); };

  function context(job) {
    const { input } = job;
    const catalog = photoSource.listCatalog();
    const ref = references.refs.get(input.referenceId);
    if (!ref || !references.rules) throw new PromoError('AI_BAD_OUTPUT');
    const rules = references.rules;
    const store = { name: catalog.store.name, location: catalog.store.location };
    const exteriorId = catalog.store.exteriorPhotoId;
    return {
      input, rules, ref, store, catalog, exteriorId, contract: references.contract,
      range: rangeFor(references.refs, rules, input.referenceId, input.lengthSec),
      fonts: references.fonts,
    };
  }

  // ---- look: 고른 사진만 읽어 사진 정보(캐시, 동시 2, 1회 재시도) ----
  async function look(job, { signal }) {
    faultAt('look');
    const cacheDir = join(deps.cacheDir, 'photo-meta');
    await mkdir(cacheDir, { recursive: true });
    const metas = await pool(job.input.photoIds, 2, async photoId => {
      const { request, cacheKey } = await photoMetaInput(photoSource, photoId, deps.lookModel ?? deps.model);
      const file = join(cacheDir, `${cacheKey}.json`);
      try {
        const cached = JSON.parse(await readFile(file, 'utf8'));
        if (!validateSchema(PHOTO_META_SCHEMA, cached).length) return { ...cached, photoId };
      } catch { /* 캐시 없음 */ }
      let meta;
      for (let attempt = 0; ; attempt++) {
        try {
          meta = await call(job, { ...request, signal }, lookRunner);
          break;
        } catch (err) {
          if (attempt >= 1 || err?.code !== 'AI_TIMEOUT' || signal?.aborted) throw err;
        }
      }
      await writeJson(file, meta);
      return { ...meta, photoId };
    });
    return metas;
  }

  // ---- story: 장면 구성 + 글자 검사 + 다시 쓰기 최대 2 ----
  function normalizeStory(raw, ctx, musicTrackId) {
    const story = structuredClone(raw);
    const { input, store } = ctx;
    let cursor = 0;
    for (const s of story.scenes) { s.start = round3(cursor); cursor += s.duration; }
    const last = story.scenes[story.scenes.length - 1];
    for (const [id, text, role] of [['store-name', store.name, 'title'], ['store-location', store.location, 'sub']]) {
      let t = story.texts.find(x => x.textId === id);
      if (!t) { t = { textId: id, role, text, sceneIds: last ? [last.sceneId] : [] }; story.texts.push(t); }
      t.text = text;
      if (last && !last.textIds.includes(id)) last.textIds.push(id);
      if (last && !t.sceneIds.includes(last.sceneId)) t.sceneIds.push(last.sceneId);
    }
    return { referenceId: input.referenceId, lengthSec: input.lengthSec, locale: input.locale, promptVersion: PROMPT_VERSION, scenes: story.scenes, texts: story.texts, ending: story.ending, musicTrackId };
  }

  async function story(job, { signal, metas }) {
    faultAt('story');
    const ctx = context(job);
    const sizes = id => photoSource.photoInfo(id) || {};
    const metaById = new Map(metas.map(m => [m.photoId, m]));
    const promptCtx = {
      ...ctx,
      photos: job.input.photoIds.map(id => ({ photoId: id, menuName: ctx.catalog.menus.find(m => m.menuId === sizes(id).menuId)?.names[job.input.locale] ?? '', width: sizes(id).width, height: sizes(id).height, meta: metaById.get(id) })),
      exterior: { photoId: ctx.exteriorId, width: sizes(ctx.exteriorId).width, height: sizes(ctx.exteriorId).height, kind: 'exterior' },
    };
    const music = pickMusic(deps.music, job.input.moods);
    const checkCtx = { rules: ctx.rules, range: ctx.range, lengthSec: job.input.lengthSec, locale: job.input.locale, referenceId: job.input.referenceId, selectedPhotoIds: job.input.photoIds, store: ctx.store,
      photoMeta: metaById, photoMenu: Object.fromEntries(job.input.photoIds.map(id => [id, sizes(id).menuId ?? null])), menus: ctx.catalog.menus };
    let rewrite = null;
    for (let attempt = 0; ; attempt++) {
      const raw = await call(job, { prompt: storyPrompt(promptCtx, rewrite), schema: STORY_SCHEMA, timeoutMs: TIMEOUTS.story, signal }, storyRunner);
      const result = normalizeStory(raw, ctx, music?.trackId ?? null);
      const violations = checkStory(result, checkCtx);
      await writeJson(join(job.dir, attempt === 0 ? 'story.v0.json' : `story.v${attempt}.json`), { story: result, violations });
      if (!violations.length) { await writeJson(join(job.dir, 'story.json'), result); return { story: result, promptCtx, music }; }
      if (attempt >= MAX_STORY_REWRITES) { job.checkSummary = { stage: 'story', rules: summarize(violations) }; throw new PromoError('CAPTION_TOO_LONG'); }
      job.storyRewriteCount = attempt + 1;
      rewrite = { violations: violations.slice(0, 60), previous: raw };
    }
  }

  // ---- scenes: 장면 코드 생성 → 정적 + 격리 Chrome 검사 → 고치기 최대 2 ----
  async function runChecks(job, ctx, storyJson, html, assets, version) {
    const started = Date.now();
    const violations = staticCheck(html, { story: storyJson, rules: ctx.rules });
    const staticPassed = violations.length === 0;
    // Do not send pilot HTML with prohibited code or resource URLs to Chrome.
    const runtime = deps.sceneRunner && violations.some(v => v.rule.startsWith('static.')) ? null
      : await deps.checkScene({ html, story: storyJson, rules: ctx.rules, store: ctx.store, lengthSec: job.input.lengthSec, assets, fonts: ctx.fonts });
    if (runtime) violations.push(...runtime.violations);
    const checkMs = Date.now() - started;
    deps.onSceneCheck?.({ staticPassed, browserPassed: runtime ? runtime.violations.length === 0 : null, checkMs, violations });
    job.checks.push({ version, passed: violations.length === 0, violations: violations.slice(0, 100), checkMs });
    await writeJson(join(job.dir, 'checks.json'), job.checks);
    return violations;
  }

  async function writeVersion(job, html) {
    const version = job.checks.length;
    await writeFile(join(job.dir, `scene.v${version}.html`), html);
    return version;
  }

  /** 위반이 없어질 때까지 고치기(job.fixCount가 MAX_FIXES에 닿으면 CODE_CHECK_FAILED). */
  async function fixUntilPass(job, ctx, s, html, violations, assets, signal) {
    while (violations.length) {
      if (job.fixCount >= MAX_FIXES) { job.checkSummary = { stage: job.stage, rules: summarize(violations) }; throw new PromoError('CODE_CHECK_FAILED'); }
      job.fixCount++;
      const out = await call(job, { prompt: sceneFixPrompt(ctx, s.story, html, violations), schema: SCENE_SCHEMA, timeoutMs: TIMEOUTS.scenes, signal }, sceneRunner);
      html = out.html;
      const version = await writeVersion(job, html);
      violations = await runChecks(job, ctx, s.story, html, assets, version);
    }
    await writeFile(join(job.dir, 'scene.html'), html);
    return html;
  }

  async function scenes(job, { signal, story: s }) {
    faultAt('scenes');
    const ctx = { ...context(job), photos: s.promptCtx.photos, exterior: s.promptCtx.exterior };
    const assets = await photoAssets(photoSource, [...job.input.photoIds, ctx.exteriorId]);
    const out = await call(job, { prompt: sceneCodePrompt(ctx, s.story), schema: SCENE_SCHEMA, timeoutMs: TIMEOUTS.scenes, signal }, sceneRunner);
    const version = await writeVersion(job, out.html);
    const violations = await runChecks(job, ctx, s.story, out.html, assets, version);
    const html = await fixUntilPass(job, ctx, s, out.html, violations, assets, signal);
    return { html, ctx, assets };
  }

  // ---- merge: 녹화 → ffmpeg(음원·어두워짐·faststart) → ffprobe·번쩍임. 위반이면 scenes 고치기로 ----
  async function merge(job, { signal, story: s, scene }) {
    faultAt('merge');
    let { html } = scene;
    const outFile = join(job.dir, 'final.mp4');
    const audio = s.music ? { file: join(deps.musicDir, s.music.file) } : null;
    for (;;) {
      await deps.renderVideo({ html, lengthSec: job.input.lengthSec, assets: scene.assets, fonts: scene.ctx.fonts, outFile, audio, fadeOutSec: scene.ctx.rules.fadeOutSec ?? 0.6, signal });
      const { info, violations } = await deps.checkVideo({ file: outFile, lengthSec: job.input.lengthSec, rules: scene.ctx.rules });
      if (!violations.length) return { info, music: s.music, outFile };
      job.checks.push({ version: job.checks.length, stage: 'merge', passed: false, violations, checkMs: 0 });
      html = await fixUntilPass(job, scene.ctx, s, html, violations, scene.assets, signal);
    }
  }

  return { look, story, scenes, merge };
}

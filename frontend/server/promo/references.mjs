// 디자인 레퍼런스 읽기 (DATA_MODEL 10.16.5, API-27). 파일 원본은 T-084·T-085 소유.
// 갤러리 목록과 생성(프롬프트·검사기)이 같은 meta.json·brief.md·example.html·rules.json을 쓴다.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMO_CONSENSUS_REFERENCE_IDS, PROMO_REFERENCE_GALLERY_VERSION, PROMO_REFERENCE_IDS } from '../../shared/promo-references.mjs';

export const DEFAULT_REFERENCES_DIR = fileURLToPath(new URL('./references/', import.meta.url));
export const REFERENCE_ID = new RegExp(`^(?:${PROMO_REFERENCE_IDS.join('|')})$`);
export const REFERENCE_IDS = PROMO_REFERENCE_IDS;
const LENGTHS = ['10', '15', '30'];

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const readText = file => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const DEFAULT_PHOTO_FIT = {
  ko: {
    soldOut: '품절|매진|솔드\\s*아웃|다\\s*팔[렸려았]|다\\s*사\\s*갔|다\\s*나갔|남은\\s*게\\s*없|하나도\\s*없',
    remaining: '[0-9]+\\s*개\\s*(남|뿐|만\\s*남)|남은\\s*(수량|개수|건)|(한|두|세|네|다섯)\\s*개\\s*(남|뿐)|마지막\\s*([0-9]+\\s*개|하나|한\\s*개)',
  },
};
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** rules.json을 검사기가 쓰는 모양으로 맞춘다. 키 이름 차이는 여기서만 흡수한다. */
export function normalizeRules(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('rules.json missing');
  const frame = raw.frame || {};
  const safeRaw = raw.safe || raw.safeArea || {};
  const width = num(frame.width, 1080); const height = num(frame.height, 1920);
  const safe = {
    left: num(safeRaw.left, 60), right: num(safeRaw.right, 60), top: num(safeRaw.top, 120), bottom: num(safeRaw.bottom, 300),
  };
  const rect = raw.safeRect || {};
  const counting = raw.counting || {};
  const ranges = (Array.isArray(counting.fullWidthRanges) ? counting.fullWidthRanges : [])
    .map(r => String(r).split('-').map(h => parseInt(h, 16))).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const roles = {};
  for (const [role, r] of Object.entries(raw.roles || raw.textRoles || {})) {
    const per = r.perLine || r.charsPerLine || {};
    roles[role] = {
      fontPx: num(r.fontPx ?? r.size, 36),
      perLine: { cjk: num(per.cjk ?? per.ko ?? per['ko-zh'], 14), en: num(per.en, 27) },
      maxLines: num(r.maxLines ?? r.lines, 2),
    };
  }
  const lengths = {};
  for (const key of LENGTHS) {
    const l = raw.lengths?.[key] || {};
    lengths[key] = {
      sceneCount: { min: num(l.sceneCount?.min, 1), max: num(l.sceneCount?.max, 99) },
      minSceneSec: num(l.minSceneSec, 1),
      endingSec: num(l.endingSec, null),
    };
  }
  const minByRef = raw.minSceneSecByRef || {};
  const photo = raw.photo || raw.photos || {};
  const flash = raw.flash || {};
  return {
    version: String(raw.version ?? '1'),
    frame: { width, height },
    safe, safeBox: { x1: num(rect.x0, safe.left), x2: num(rect.x1, width - safe.right), y1: num(rect.y0, safe.top), y2: num(rect.y1, height - safe.bottom) },
    fullWidthRanges: ranges,
    durationToleranceSec: num(raw.durationToleranceSec, 0.05),
    sceneTimingToleranceSec: num(raw.sceneTimingToleranceSec, 0.3),
    fadeOutSec: num(raw.fadeOutSec, 0.6),
    maxHtmlBytes: num(raw.html?.maxBytes, 65536),
    check: { sampleEverySec: num(raw.check?.sampleEverySec, 0.25), boundaryOffsetsSec: Array.isArray(raw.check?.boundaryOffsetsSec) ? raw.check.boundaryOffsetsSec.filter(Number.isFinite) : [-0.05, 0.05], visibleOpacityMin: num(raw.check?.visibleOpacityMin, 0.05) },
    languages: raw.languages || { en: { forbidScripts: ['Hangul', 'Han'] }, 'zh-Hans': { forbidScripts: ['Hangul'] }, 'zh-Hant': { forbidScripts: ['Hangul'] }, ko: { requireScripts: ['Hangul'] } },
    minFontPx: num(raw.minFontPx ?? raw.minFontSize, 36),
    roles,
    lengths,
    minSceneSecByRefSkipFirst: Array.isArray(raw.minSceneSecByRefSkipFirst) ? raw.minSceneSecByRefSkipFirst : [],
    minSceneSecByRef: Object.fromEntries(Object.entries(minByRef).map(([k, v]) => [k, num(v, 1)])),
    photo: { maxUses: num(photo.maxUses, 2), noAdjacent: photo.noAdjacent !== false, exteriorId: photo.exteriorId || 'store-exterior', exteriorExempt: photo.exteriorExempt !== false, useAllBeforeReuse: photo.useAllBeforeReuse !== false },
    ending: {
      locationMaxLines: num(raw.ending?.locationMaxLines, 2), checkBeforeEndSec: num(raw.ending?.checkAtFromEndSec ?? raw.ending?.checkBeforeEndSec, 1),
      locationRole: raw.ending?.locationRole || 'sub', storeNameMaxLines: num(raw.ending?.storeNameMaxLines, 2),
    },
    bannedWords: Array.isArray(raw.bannedWords) ? raw.bannedWords.filter(w => typeof w === 'string' && w) : [],
    bannedPatterns: (Array.isArray(raw.bannedPatterns) ? raw.bannedPatterns : []).map(p => new RegExp(p, 'u')),
    flash: { maxPerSec: num(flash.maxPerSec, 3), yavgDelta: num(flash.yavgDelta ?? flash.lumaDelta, 20) },
    // T-087: 전환 길이·글자 겹침·정지 화면·빈 장면·장면-사진 맞춤
    transition: { maxSec: num(raw.transition?.maxSec, 0.4), probeStepSec: num(raw.transition?.probeStepSec, 0.05), probeSpanSec: num(raw.transition?.probeSpanSec, 0.6), fullOpacity: num(raw.transition?.fullOpacity, 0.95) },
    overlap: { maxRatio: num(raw.overlap?.maxRatio, 0.15), layerCover: num(raw.overlap?.layerCover, 0.9) },
    still: { maxSec: num(raw.still?.maxSec, 1.5), pxStep: num(raw.still?.pxStep, 0.5), skipLastScene: raw.still?.skipLastScene !== false },
    scene: { textlessMaxSec: num(raw.scene?.textlessMaxSec, 1.5), minMotionPx: num(raw.scene?.minMotionPx, 24) },
    photoFit: Object.fromEntries(Object.entries(raw.photoFit || DEFAULT_PHOTO_FIT).map(([loc, p]) => [loc, {
      soldOut: p?.soldOut ? new RegExp(p.soldOut, 'u') : null, remaining: p?.remaining ? new RegExp(p.remaining, 'u') : null,
    }])),
  };
}

function fontManifest(dir) {
  const fontsDir = join(dir, 'fonts');
  if (!existsSync(fontsDir)) return [];
  const manifest = join(fontsDir, 'fonts.json');
  if (existsSync(manifest)) {
    const list = readJson(manifest);
    const items = Array.isArray(list) ? list : list.faces || list.fonts || [];
    return items.filter(f => f?.family && typeof f.file === 'string' && /^[A-Za-z0-9._-]+\.(woff2|woff|ttf|otf)$/.test(f.file))
      .map(f => ({ family: f.family, file: f.file, format: f.format || null, weight: f.weight ?? 'normal', style: f.style ?? 'normal', path: join(fontsDir, f.file) }));
  }
  return readdirSync(fontsDir).filter(f => /\.(woff2|woff|ttf|otf)$/.test(f)).map(file => ({
    family: /serif|myeongjo/i.test(file) ? 'Navis Serif' : 'Navis Sans', file, weight: /bold|extra|800|900/i.test(file) ? '800' : 'normal', style: 'normal', path: join(fontsDir, file),
  }));
}

export function loadReferences(dir = DEFAULT_REFERENCES_DIR) {
  let rules = null; let rulesError = null;
  try { rules = normalizeRules(readJson(join(dir, 'rules.json'))); } catch (err) { rulesError = err.message; }
  const contractFile = join(dir, 'contract', 'scene-contract.md');
  const contract = readText(contractFile);
  const refs = new Map();
  for (const id of REFERENCE_IDS) {
    const folder = join(dir, id);
    const metaFile = join(folder, 'meta.json');
    if (!existsSync(metaFile)) continue;
    try {
      const meta = readJson(metaFile);
      if (meta.id !== id) continue;
      refs.set(id, {
        id, folder, meta,
        brief: readText(join(folder, 'brief.md')),
        exampleHtml: readText(join(folder, 'example.html')),
        exampleStory: readText(join(folder, 'example-story.json')),
        posterPath: join(folder, 'poster.jpg'),
        previewPath: join(folder, 'preview.mp4'),
      });
    } catch { /* 깨진 meta는 목록에서 뺀다 */ }
  }
  return { dir, rules, rulesError, contract, refs, fonts: fontManifest(dir), version: rules?.version ?? '1' };
}

/** 장면 수·사진 자리 범위: 레퍼런스 meta가 있으면 그것, 없으면 rules의 길이별 범위. */
export function rangeFor(refs, rules, referenceId, lengthSec) {
  const key = String(lengthSec);
  const meta = refs?.get?.(referenceId)?.meta;
  const fromMeta = meta?.lengths?.[key];
  const base = rules.lengths[key];
  return {
    sceneCount: { min: num(fromMeta?.sceneCount?.min, base.sceneCount.min), max: num(fromMeta?.sceneCount?.max, base.sceneCount.max) },
    photoSlots: num(fromMeta?.photoSlots?.max, 99),
    minSceneSec: num(fromMeta?.minSceneSec, num(rules.minSceneSecByRef[referenceId], base.minSceneSec)),
    // ref-3처럼 첫 장면(시작 외관)에는 레퍼런스 최소 시간을 쓰지 않는 경우(T-084 rules 해석)
    minSceneSecFirst: rules.minSceneSecByRefSkipFirst?.includes(referenceId) ? base.minSceneSec
      : num(fromMeta?.minSceneSec, num(rules.minSceneSecByRef[referenceId], base.minSceneSec)),
    endingSec: base.endingSec,
  };
}

/** API-27 목록 모양. */
export function listReferences(loaded) {
  const references = [];
  for (const id of REFERENCE_IDS) {
    const ref = loaded.refs.get(id);
    if (!ref) continue;
    const m = ref.meta;
    const from = num(m.previewFrom, 0); const to = num(m.previewTo, from);
    references.push({
      id, nameKey: m.nameKey || `promo.ref.${id}.name`, cardAspect: m.cardAspect || '9:16',
      posterUrl: `/api/promo/references/${id}/poster.jpg`,
      previewUrl: `/api/promo/references/${id}/preview.mp4`,
      preview: { durationSec: Math.round((to - from) * 100) / 100, width: 360, height: 640, fps: 30, hasAudio: false },
      moods: m.motion ? ({ fast: ['lively'], medium: ['warm', 'clean'], calm: ['elegant', 'warm'] })[m.motion.energy]
        : Array.isArray(m.moods) ? m.moods : [],
      concepts: m.motion?.concepts ?? (Array.isArray(m.concepts) ? m.concepts : []),
      lengths: m.motion?.lengths ?? m.lengths ?? {},
    });
  }
  const version = PROMO_CONSENSUS_REFERENCE_IDS.every(id => loaded.refs.get(id)?.meta.motion) ? PROMO_REFERENCE_GALLERY_VERSION : loaded.version;
  return { referenceVersion: version, references };
}

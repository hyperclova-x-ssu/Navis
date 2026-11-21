// 예상 시간·비용 표 (ARCHITECTURE 12.7, DATA_MODEL 10.16.7). 표 전체를 미리 계산해 API-21로 준다.
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_PATH = fileURLToPath(new URL('./estimate-base.json', import.meta.url));
export const LENGTHS = [10, 15, 30];
export const STAGES = ['look', 'story', 'scenes', 'merge'];

/** estimate-base.json(T-086 소유)이 없으면 12.7 기본값. */
export const DEFAULT_BASE = Object.freeze({
  version: 1,
  look: { secPerBatch: 5.0, batch: 2 },
  story: { a: 14, perL: 0.8, perN: 0.3 },
  scenes: { gen: { a: 10, perL: 2.3 }, fixes: 1, checkSec: 1 },
  merge: { a: 2.0, perL: 1.1 },
  fixedSec: 2,
  tokens: {
    photo: { in: 5100, out: 450 },
    story: { inA: 4000, inPerN: 320, outA: 1500, outPerL: 130 },
    code: { inA: 10000, inPerN: 320, outA: 2500, outPerL: 260 },
    fix: { inA: 14000, inPerN: 320, inPerL: 160, outA: 2500, outPerL: 260 },
  },
  pricing: { model: 'claude-sonnet-5-5', inputUsdPerMTok: 2, outputUsdPerMTok: 10, source: 'https://platform.claude.com/docs/en/about-claude/pricing', checkedOn: '2026-11-10' },
  krwPerUsd: 1400,
  fxCheckedOn: '2026-11-10',
});

export function loadBase(path = DEFAULT_BASE_PATH) {
  if (!existsSync(path)) return DEFAULT_BASE;
  try { return { ...DEFAULT_BASE, ...JSON.parse(readFileSync(path, 'utf8')) }; } catch { return DEFAULT_BASE; }
}

/** 단계별 기본 예측(초). */
export function stageSeconds(base, L, n) {
  return {
    look: base.look.secPerBatch * Math.ceil(n / base.look.batch),
    story: base.story.a + base.story.perL * L + base.story.perN * n,
    scenes: (1 + base.scenes.fixes) * (base.scenes.gen.a + base.scenes.gen.perL * L) + base.scenes.checkSec,
    merge: base.merge.a + base.merge.perL * L,
  };
}

export function costUsd(base, L, n) {
  const t = base.tokens;
  const fixes = base.scenes.fixes;
  const input = n * t.photo.in + (t.story.inA + t.story.inPerN * n) + (t.code.inA + t.code.inPerN * n) + fixes * (t.fix.inA + t.fix.inPerN * n + t.fix.inPerL * L);
  const output = n * t.photo.out + (t.story.outA + t.story.outPerL * L) + (t.code.outA + t.code.outPerL * L) + fixes * (t.fix.outA + t.fix.outPerL * L);
  return (input * base.pricing.inputUsdPerMTok + output * base.pricing.outputUsdPerMTok) / 1e6;
}

/** 최근 5개 성공 작업의 (실제 ÷ 기본 예측) 평균, 단계별, 0.5~3. */
export function multipliers(base, samples = []) {
  const recent = samples.slice(-5);
  const out = {};
  for (const stage of STAGES) {
    const ratios = recent.map(s => {
      const predicted = stageSeconds(base, s.lengthSec, s.photoCount)[stage];
      const actual = (s.stageMs?.[stage] ?? NaN) / 1000;
      return predicted > 0 && Number.isFinite(actual) ? actual / predicted : NaN;
    }).filter(Number.isFinite);
    const mean = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 1;
    out[stage] = Math.min(3, Math.max(0.5, mean));
  }
  return out;
}

export function buildEstimateModel({ base = DEFAULT_BASE, samples = [], maxPhotos = 10, krwPerUsd = base.krwPerUsd ?? 1400, available }) {
  const sampleCount = Math.min(samples.length, 5);
  const mult = sampleCount ? multipliers(base, samples) : { look: 1, story: 1, scenes: 1, merge: 1 };
  const table = {};
  for (const L of LENGTHS) {
    table[L] = [];
    for (let n = 0; n <= maxPhotos; n++) {
      const s = stageSeconds(base, L, n);
      const seconds = STAGES.reduce((sum, st) => sum + s[st] * mult[st], 0) + base.fixedSec;
      const usd = costUsd(base, L, n);
      table[L].push({ photoCount: n, seconds: Math.ceil(seconds - 1e-9), costUsd: Math.round(usd * 1000) / 1000, costKrw: Math.round(usd * krwPerUsd) });
    }
  }
  return {
    version: base.version ?? 1,
    basis: sampleCount ? 'average' : 'spike',
    sampleCount,
    pricing: { ...base.pricing },
    fx: { krwPerUsd, checkedOn: base.fxCheckedOn ?? '2026-11-10', kind: 'configured-estimate' },
    table,
    available,
  };
}

export async function readStats(file) {
  try { const list = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(list) ? list : []; } catch { return []; }
}

export async function appendStats(file, sample) {
  const list = [...await readStats(file), sample].slice(-5);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2));
  await rename(tmp, file);
  return list;
}

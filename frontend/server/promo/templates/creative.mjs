import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PROMO_CONSENSUS_REFERENCE_IDS } from '../../../shared/promo-references.mjs';

const FONT_SLOTS = {
  sticker: 'Navis Hand Round',
  scrapbook: 'Navis Hand Pen',
  'menu-board': 'Navis Hand Brush',
};
export const HOOKS = ['pull-out', 'texture-montage', 'shutter'];
export const ORDERS = ['hero-first', 'journey-first', 'grid-first'];
export const EASINGS = ['ease-in-out', 'cubic-bezier(.16,1,.3,1)', 'cubic-bezier(.65,0,.35,1)'];
const DIRECTIONS = ['left', 'right', 'up', 'down', 'in', 'out'];

export function loadCreativeLibrary() {
  const data = JSON.parse(readFileSync(new URL('./creative.json', import.meta.url), 'utf8'));
  if (data.version !== 3 || !data.author || data.references.map(r => r.id).join() !== PROMO_CONSENSUS_REFERENCE_IDS.join()) {
    throw new Error('Invalid promo motion manifest');
  }
  const photos = new Set();
  const references = new Map(data.references.map(profile => {
    if (photos.has(profile.previewMenuId) || new Set(profile.moves).size !== profile.moves.length
        || profile.moves.length < 3 || profile.moves.length > 6 || !profile.moves.every(move => data.vocabulary[move])
        || ![10, 15, 30].every(length => Number.isSafeInteger(profile.cuts[length]))) throw new Error('Invalid promo motion profile');
    photos.add(profile.previewMenuId);
    return [profile.id, { ...profile, fontSlot: FONT_SLOTS[profile.key] ?? null }];
  }));
  return { ...data, references };
}

export function takeSeed(storeId, input, takeIndex = 0) {
  return createHash('sha256').update(JSON.stringify([storeId, input.menuIds, input.photoIds, input.referenceId,
    input.moods, input.concepts, input.lengthSec, input.locale, input.memo, takeIndex])).digest();
}

const rhythms = {
  fast: [[0.42, 1.8, 0.64, 1.5, 1.12], [0.9, 0.4, 1.3, 1.7], [0.45, 1.6, 0.74, 1.24, 1.48]],
  medium: [[0.6, 1.6, 0.85, 1.22], [0.53, 1.03, 1.7, 0.86], [1.08, 0.5, 1.7, 0.87]],
  calm: [[0.88, 1.11, 1.32, 0.96], [1.08, 0.82, 1.34, 1.02], [0.77, 1.25, 1.12, 1.02]],
};
const ms = value => Math.round(value * 1000) / 1000;

function snapped(time, min, max, music) {
  if (!music?.bpm) return Math.max(min, Math.min(max, time));
  const step = 30 / music.bpm;
  const phase = music.beatOffsetSec ?? 0;
  const first = Math.ceil((min - phase) / step);
  const last = Math.floor((max - phase) / step);
  if (first > last) return Math.max(min, Math.min(max, time));
  return phase + Math.max(first, Math.min(last, Math.round((time - phase) / step))) * step;
}

export function sceneDurations({ count, lengthSec, endingSec, range, profile, seed, music, reading = [] }) {
  const weights = rhythms[profile.energy][seed[0] % 3];
  const minima = Array.from({ length: count - 1 }, (_, i) => Math.max(reading[i] ?? 0,
    i === 0 ? range.minSceneSecFirst : range.minSceneSec));
  const amount = lengthSec - endingSec;
  const maxShot = { 10: 3, 15: 3.5, 30: 4 }[lengthSec];
  const maxWidth = Math.max(maxShot, amount / minima.length + 0.18);
  const spare = Math.max(0, amount - minima.reduce((a, b) => a + b, 0));
  const scaled = minima.map((_, i) => weights[i % weights.length] * (0.9 + (seed[i + 10] % 21) / 100));
  const weight = scaled.reduce((a, b) => a + b, 0);
  let t = 0;
  return [...minima.map((min, i) => {
    const remaining = minima.length - i - 1;
    const reserved = minima.slice(i + 1).reduce((a, b) => a + b, 0);
    const lower = Math.max(t + min, amount - remaining * maxWidth);
    const upper = Math.min(t + maxWidth, amount - reserved);
    const next = remaining ? ms(snapped(t + min + spare * scaled[i] / weight, lower, upper, music)) : amount;
    const duration = ms(next - t);
    t = next;
    return duration;
  }), endingSec];
}

export function assignMotion(story, { profile, seed, music, slots, skeleton }) {
  const moves = profile.moves.filter(move => move !== 'badge' || slots.price || slots.limitedOffer);
  const rotated = moves.map((_, i) => moves[(i + seed[1] % moves.length) % moves.length]);
  const target = profile.cuts[story.lengthSec];
  const beforeClose = story.scenes.slice(0, -1);
  const width = { 10: 3, 15: 3.5, 30: 4 }[story.lengthSec];
  const marks = beforeClose.map(scene => Math.max(0, Math.ceil(scene.duration / width) - 1));
  for (let edits = marks.reduce((a, b) => a + b, 0) + beforeClose.length; edits < target; edits++) {
    const ranked = beforeClose.map((scene, i) => ({ i, average: scene.duration / (marks[i] + 1) }));
    const next = ranked.sort((a, b) => b.average - a.average || a.i - b.i)[0];
    marks[next.i]++;
  }
  for (const [index, scene] of story.scenes.entries()) {
    const beat = index === story.scenes.length - 1 ? 'close' : index === 0 ? 'open' : 'show';
    const count = marks[index] ?? 0;
    const step = scene.duration / (1 + count);
    const edits = Array.from({ length: count }, (_, i) => {
      const center = scene.start + step * (i + 1);
      const margin = Math.min(0.21, step * 0.35);
      return ms(snapped(center, center - margin, center + margin, music));
    });
    scene.motion = { move: rotated[index % rotated.length], direction: DIRECTIONS[(seed[2] + index) % DIRECTIONS.length],
      transition: (seed[3] + index * 7) % 10 < 7 ? 'primary' : 'secondary',
      easing: EASINGS[(seed[4] + index) % EASINGS.length], rotation: (seed[index + 5] % 41 - 20) / 10,
      intensity: skeleton?.intensity?.[beat], editBeats: edits };
  }
  story.creative = { key: profile.key, energy: profile.energy, targetCuts: target,
    hook: slots.hook, order: slots.order, beat: { bpm: music?.bpm, offset: music?.beatOffsetSec },
    seed: seed.subarray(0, 8).toString('hex'), closing: seed[8] % 2 ? 'split-reveal' : 'stamp-lockup',
    captionPosition: seed[9] % 2 ? 'lower-left' : 'lower-center', fontSlot: profile.fontSlot,
    palette: { colors: profile.colors, secondaryTreatment: ['paper', 'deep', 'soft'][seed[19] % 3] } };
}

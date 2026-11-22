const MIN_EDITS = { 10: { fast: 5, medium: 4, calm: 3 }, 15: { fast: 8, medium: 5, calm: 4 }, 30: { fast: 14, medium: 8, calm: 6 } };
const MAX_SHOT = { 10: 3, 15: 3.5, 30: 4 };
const frameArea = 1080 * 1920;
const violation = (name, actual, limit, extra) => ({ rule: `motion.${name}`, actual, limit, ...extra });

export function checkMotionPlan(story) {
  if (!story.creative) return [];
  const { lengthSec, creative, scenes, texts } = story;
  const errors = [];
  const editTimes = scenes.flatMap((scene, i) => [...(i ? [scene.start] : []), ...(scene.motion?.editBeats ?? [])]);
  const minimum = Math.max(creative.targetCuts ?? 0, MIN_EDITS[lengthSec]?.[creative.energy] ?? 0);
  if (new Set(editTimes).size < minimum) errors.push(violation('cutCount', editTimes.length, minimum));
  const beforeClose = scenes.slice(0, -1);
  const widths = beforeClose.map(scene => scene.duration);
  const spread = Math.max(...widths) - Math.min(...widths);
  if (widths.length >= 2 && spread < 0.399) errors.push(violation('rhythmVariance', spread, '≥0.4 seconds'));
  const counts = new Map();
  for (const [i, scene] of scenes.entries()) {
    const { sceneId } = scene;
    const move = scene.motion?.move;
    const previous = scenes[i - 1]?.motion;
    if (move) counts.set(move, (counts.get(move) ?? 0) + 1);
    if (previous && move === previous.move && scene.motion.direction === previous.direction) {
      errors.push(violation('moveVariety', `${move}/${scene.motion.direction}`, 'no identical consecutive move and direction', { sceneId }));
    }
    const timed = [scene.start, ...(scene.motion?.editBeats ?? []), scene.start + scene.duration];
    if (i < beforeClose.length && timed.slice(1).some((time, j) => time - timed[j] > MAX_SHOT[lengthSec] + 0.005)) {
      errors.push(violation('maxShotLen', scene.duration, MAX_SHOT[lengthSec], { sceneId }));
    }
    if (scene.duration >= 0.5 && scene.duration <= 0.9) {
      const size = texts.filter(text => scene.textIds.includes(text.textId)).reduce((sum, text) => sum + [...text.text].length, 0);
      if (size > 4) errors.push(violation('fast-text', size, '≤4 characters', { sceneId }));
    }
  }
  const share = Math.max(0, ...counts.values()) / scenes.length;
  if (counts.size < 3 || share > 0.4001) errors.push(violation('moveVariety',
    `${counts.size} moves, max ${Math.round(share * 100)}%`, '≥3 moves, ≤40% each'));
  if (creative.beat?.bpm) {
    const step = 30 / creative.beat.bpm;
    const offset = creative.beat.offset ?? 0;
    // The fixed-length CTA start is determined by existing story timing, so only movable edits use its music grid.
    const cuts = editTimes.filter(t => Math.abs(t - scenes.at(-1).start) > 0.005);
    const aligned = cuts.filter(t => Math.abs(t - offset - Math.round((t - offset) / step) * step) <= 0.06);
    if (cuts.length && aligned.length / cuts.length < 0.8) errors.push(violation('beatAlign', `${aligned.length}/${cuts.length}`, '≥80% within ±60ms'));
  }
  return errors;
}

function motionChange(before = {}, after = {}) {
  const channels = new Set();
  let distance = 0;
  let scale = 0;
  for (const [id, current] of Object.entries(after)) {
    const previous = before[id];
    if (!previous) {
      channels.add(current.channel);
      continue;
    }
    const pixels = Math.max(...current.box.map((metric, i) => Math.abs(metric - previous.box[i])));
    const clip = current.clip === previous.clip ? 0 : Math.max(0, ...current.clipValues
      .map((value, i) => Math.abs(value - (previous.clipValues[i] ?? 0)))) * 10.8;
    if (pixels >= 8 || Math.abs(current.opacity - previous.opacity) >= 0.08 || clip >= 1) channels.add(current.channel);
    if (current.channel === 'camera' || current.channel === 'layout') {
      distance = Math.max(distance, pixels, clip);
      scale = Math.max(scale, ...[2, 3].map(i => Math.abs(current.box[i] - previous.box[i]) / Math.max(1, previous.box[i])));
    }
  }
  for (const [id, previous] of Object.entries(before)) if (!after[id]) channels.add(previous.channel);
  return { channels, distance, scale };
}

export function checkMotionObservations(observations, story) {
  if (!story.creative) return [];
  const rows = observations.filter(row => row.obs.motion && (row.kinds.includes('grid') || row.kinds.includes('hook')));
  if (!rows.length) return [];
  const errors = [];
  const closing = story.scenes.at(-1);
  const limit = story.creative.energy === 'calm' ? 1.5 : 1;
  const push = (name, actual, threshold, sceneId, t) => errors.push(violation(name, actual, threshold, { sceneId, t }));
  for (const scene of story.scenes.slice(0, -1)) {
    const interior = rows.filter(row => row.obs.current === scene.sceneId && row.t >= scene.start && row.t < scene.start + scene.duration - 0.02);
    if (interior.length < 2) continue;
    const observed = new Set();
    let stride = 0;
    let scale = 0;
    let anchor = interior[0];
    let hold = 0;
    for (const point of interior.slice(1)) {
      const change = motionChange(anchor.obs.motion, point.obs.motion);
      const extent = motionChange(interior[0].obs.motion, point.obs.motion);
      stride = Math.max(stride, extent.distance);
      scale = Math.max(scale, extent.scale);
      if (change.channels.size) {
        for (const channel of change.channels) observed.add(channel);
        hold = Math.max(hold, point.t - anchor.t);
        anchor = point;
      }
    }
    hold = Math.max(hold, scene.start + scene.duration - anchor.t);
    if (hold > limit + 0.035) push('lowEnergyStretch', Number(hold.toFixed(2)), limit, scene.sceneId);
    if (stride < 60 && scale < 0.08) push('sceneDisplacement', `${Math.round(stride)}px/${Math.round(scale * 100)}%`,
      '≥60px or 8% scale', scene.sceneId);
    if (observed.size < 2) push('layeredMotion', [...observed].join(', '), '≥2 channels', scene.sceneId);
  }
  const first = rows.find(row => row.t === 0.05);
  if (first) {
    const main = first.obs.sceneOpacity[first.obs.current] ?? 0;
    const active = rows.filter(row => row.t > 0.05 && row.t <= 1).some(row => {
      const { distance, channels } = motionChange(first.obs.motion, row.obs.motion);
      return distance >= 60 || channels.has('text') || channels.has('layout');
    });
    if (main < 0.85 || !active || rows.find(row => row.t === 0)?.obs.sig === rows.find(row => row.t === 0.5)?.obs.sig) {
      push('hook.firstSecond', `opacity ${main}, active ${active}`, 'opacity ≥0.85 and a visible first-second hook', first.obs.current);
    }
  }
  const staleTitle = rows.find(row => row.t >= story.lengthSec - 1.5 - 0.001
    && !row.obs.texts.some(text => text.id === 'store-name'));
  if (staleTitle) push('CTA', 'store title not visible', 'store name held throughout last 1.5 seconds', closing.sceneId, staleTitle.t);
  if (rows.at(-1).t >= story.lengthSec - 0.1 && Object.values(rows.at(-1).obs.sceneOpacity).filter(value => value >= 0.05).length > 1) {
    push('CTA', 'transition at last frame', 'final shot fully established', closing.sceneId, rows.at(-1).t);
  }
  let lastText = 0;
  for (const row of rows) {
    if (row.t - lastText > 3.035) {
      push('text.dwell', 'more than three seconds without text', '≤3s', row.obs.current, row.t);
      break;
    }
    if (row.obs.texts.length) lastText = row.t;
  }
  const invalidText = rows.find(({ obs }) => new Set(obs.texts.map(text => text.block ?? text.id)).size > 2
    || obs.texts.reduce((area, text) => area + (text.box.x2 - text.box.x1) * (text.box.y2 - text.box.y1), 0) > frameArea * 0.35);
  if (invalidText) push('text.dwell', 'too many simultaneous blocks or too much area', '≤2 blocks and ≤35% area',
    invalidText.obs.current, invalidText.t);
  if (story.creative.key !== 'beat-cut') {
    const sceneById = new Map(story.scenes.slice(0, -1).map(scene => [scene.sceneId, scene]));
    const entrances = rows.find(row => row.obs.entrances?.length)?.obs.entrances ?? [];
    for (const entrance of entrances) {
      const scene = sceneById.get(entrance.sceneId);
      if (scene && entrance.at >= scene.start - 0.025 && entrance.at < scene.start + 0.38
          && (entrance.duration < 80 || entrance.duration > 320)) {
        push('text.entrance', `${entrance.id}: ${entrance.duration}ms`, '80–320ms', scene.sceneId, entrance.at);
      }
    }
  }
  for (const declared of story.texts) {
    const visible = rows.filter(row => row.obs.texts.some(text => text.id === declared.textId && text.opacity >= 0.85));
    if (!visible.length) continue; // Required visible content is also checked by the existing scene checker.
    const dwell = visible.at(-1).t - visible[0].t + 0.25;
    const minimum = Math.max(1, 0.4 + 0.1 * [...declared.text].length);
    const isClosing = declared.sceneIds.includes(closing.sceneId);
    if (dwell < minimum - 0.125 || (!isClosing && dwell > 3.5 + 0.125)) {
      push('text.dwell', `${declared.textId}: ${dwell.toFixed(2)}s`, `≥${minimum.toFixed(2)}s, ≤3.5s before CTA`,
        declared.sceneIds[0], visible[0].t);
    }
  }
  const weakContrast = rows.find(row => row.obs.texts.some(text => text.contrast !== null && text.contrast < 4.5
    || story.texts.some(decl => decl.textId === text.id && ['cap', 'title'].includes(decl.role)) && text.fontSize < 52));
  if (weakContrast) push('contrast', 'insufficient measured contrast or headline size', '≥4.5:1; main text ≥52px', weakContrast.obs.current, weakContrast.t);
  const animations = rows.find(row => row.obs.easings?.length)?.obs.easings ?? [];
  if (animations.length && animations.filter(easing => easing !== 'linear').length / animations.length < 0.7
      && errors.length) errors.push(violation('nonLinearEasing', animations, '≥70% non-linear'));
  const byMark = new Map(observations.flatMap(row => row.kinds.filter(kind => kind.startsWith('edit-')).map(kind => [kind, row])));
  for (const scene of story.scenes) for (const beat of scene.motion?.editBeats ?? []) {
    const before = byMark.get(`edit-before:${scene.sceneId}:${beat}`);
    const after = byMark.get(`edit-after:${scene.sceneId}:${beat}`);
    if (before && after && !motionChange(before.obs.motion, after.obs.motion).channels.size) {
      push('cutCount', 'declared edit did not materially change the frame', 'visible crop, scene or layout change', scene.sceneId, beat);
    }
  }
  return errors;
}

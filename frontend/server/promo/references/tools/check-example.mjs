#!/usr/bin/env node
/* global process, console */
// Check one or more reference examples: story text checker + static check + isolated scene checker.
// Usage (from frontend): node server/promo/references/tools/check-example.mjs ref-1 [ref-2 ...]
import { checkStory } from './lib/check-story.mjs';
import { runSceneCheck } from './lib/check-scene.mjs';
import { loadCatalog, loadReference, loadRules } from './lib/env.mjs';

export async function checkExample(id, { rules = loadRules(), catalog = loadCatalog(), browser = true } = {}) {
  const ref = loadReference(id);
  const selected = catalog.sources.example;
  const story = checkStory(ref.story, { rules, meta: ref.meta, catalog, selectedPhotoIds: selected });
  let scene = null;
  if (browser) scene = await runSceneCheck({ html: ref.html, story: ref.story, rules, catalog, lengthSec: ref.story.lengthSec });
  return { id, story, scene: scene?.violations ?? null, checkMs: scene?.checkMs ?? null, samples: scene?.samples.length ?? 0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = process.argv.slice(2);
  let bad = 0;
  for (const id of ids.length ? ids : ['ref-1', 'ref-2', 'ref-3']) {
    const r = await checkExample(id);
    const n = r.story.length + (r.scene?.length ?? 0);
    bad += n;
    console.log(`${id}: story ${r.story.length} violations, scene ${r.scene?.length ?? 'skipped'} violations (${r.samples} samples, ${Math.round(r.checkMs)}ms)`);
    for (const x of [...r.story, ...(r.scene ?? [])]) console.log('  ', JSON.stringify(x));
  }
  process.exit(bad ? 1 : 0);
}

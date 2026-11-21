// PROMO-RETRY (D-326 Q8): puts the saved Claude baseline next to a finished NAVER pilot result. No provider call.
// Reads <resultDir>/cases.jsonl, runs the same static + browser checks and screenshots on each matching Claude capture,
// then rewrites cases.jsonl, summary.json and parity.md (the NAVER-only table is kept as parity.naver-only.md).
import { constants } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSceneCheck } from '../check-scene.mjs';
import { detectBrowser } from '../config.mjs';
import { createExamplePhotoSource } from '../photo-source.mjs';
import { loadReferences } from '../references.mjs';
import { openScene } from '../renderer.mjs';
import {
  captureScreens, compareClaudeScene, parity, readBaselines, sceneContextFor, sceneInputs, sceneShooter,
} from './hcx-pilot.mjs';

export async function compareBaseline({
  outDir, baselinePath, references = loadReferences(), browserPath,
  checkBrowser = args => runSceneCheck({ ...args, browserPath }), captureScreens: capture = captureScreens,
}) {
  const baselines = await readBaselines(baselinePath);
  const cases = (await readFile(join(outDir, 'cases.jsonl'), 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const example = createExamplePhotoSource();
  const items = new Map(sceneInputs(references, example).map(item => [item.id, item]));
  let matched = 0;
  for (const result of cases) {
    const baseline = result.stage === 'scenes' ? baselines.get(`scenes:${result.inputSha256}`) : null;
    const item = items.get(result.id);
    if (!baseline || !item) continue;
    const sceneContext = await sceneContextFor(item, example, references);
    const shot = sceneShooter({ sceneContext, outDir: join(outDir, 'screenshots'), id: result.id, capture, browserPath });
    await compareClaudeScene({ result, baseline, sceneContext, checkBrowser, shot });
    matched++;
  }
  try {
    await copyFile(join(outDir, 'parity.md'), join(outDir, 'parity.naver-only.md'), constants.COPYFILE_EXCL); // keep the first NAVER-only table.
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
  }
  await writeFile(join(outDir, 'cases.jsonl'), cases.map(result => `${JSON.stringify(result)}\n`).join(''));
  const summary = JSON.parse(await readFile(join(outDir, 'summary.json'), 'utf8'));
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify({ ...summary, cases }, null, 2)}\n`);
  await writeFile(join(outDir, 'parity.md'), parity(cases));
  return { matched, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [out, baselinePath, ...extra] = process.argv.slice(2);
  try {
    if (!out || !baselinePath || extra.length) throw new Error('PILOT_USAGE');
    const browserPath = await detectBrowser();
    if (!browserPath) throw new Error('PILOT_CHROME_MISSING');
    const probe = await openScene({ html: '<!doctype html><html></html>', assets: new Map(), browserPath });
    if (!probe.ok) throw new Error('PILOT_CHROME_FAILED');
    await probe.close();
    const report = await compareBaseline({ outDir: resolve(out), baselinePath: resolve(baselinePath), browserPath });
    console.log(JSON.stringify({ matched: report.matched, scenes: report.cases.filter(result => result.stage === 'scenes').length }));
  } catch (error) {
    // Avoid printing paths, request bodies, environment values or provider errors.
    console.error(/^PILOT_[A-Z_]+$/.test(error?.message) ? error.message : 'PILOT_FAILED');
    process.exitCode = 1;
  }
}

import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClovaStudio } from '../../clova-studio.mjs';
import { runSceneCheck, staticCheck } from '../check-scene.mjs';
import { detectBrowser, readConfig } from '../config.mjs';
import { PromoError, reasonOf } from '../errors.mjs';
import { createHcxRunner, HCX_PHOTO_MODEL, HCX_PROMO_MODEL } from '../hcx-runner.mjs';
import { createExamplePhotoSource } from '../photo-source.mjs';
import { createPipeline, photoMetaInput } from '../pipeline.mjs';
import { PHOTO_META_SCHEMA, SCENE_SCHEMA } from '../prompts.mjs';
import { loadReferences, REFERENCE_IDS } from '../references.mjs';
import { openScene, photoAssets } from '../renderer.mjs';
import { validateSchema } from '../schema.mjs';

// D-326 Q7: at most 50 real NAVER calls = up to 40 photo-look calls (39 photos + 1 spare) and up to 10 scene calls.
// A failed or retried call counts. Every later input of a stage keeps one first call, so a stage never starves.
export const CAPS = Object.freeze({ look: 40, scenes: 10, total: 50 });
const STOP = 'PILOT_BUDGET_EXHAUSTED';
const sha256 = data => createHash('sha256').update(data).digest('hex');
export const inputFingerprint = ({ prompt, schema, images = [] }) => sha256(JSON.stringify({
  prompt, schema, images: images.map(({ bytes, mediaType }) => [sha256(bytes), mediaType]),
}));
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const usage = () => new Error('PILOT_USAGE');

/**
 * Optional narrowing flags (PROMO-NEXT): `--stage=look|scenes` runs one stage, `--photos=id,id` (look only) names the photos,
 * `--max-calls=N` caps the real NAVER calls of that run. Without flags the run is the full 50-call pilot.
 */
export function parsePilotFlags(flags) {
  const out = {};
  for (const flag of flags) {
    const [, name, value = ''] = /^--([a-z-]+)=(.*)$/.exec(flag) ?? [];
    if (name === 'stage' && ['look', 'scenes'].includes(value) && !out.stages) out.stages = [value];
    else if (name === 'photos' && /^[a-z0-9-]+(,[a-z0-9-]+)*$/.test(value) && !out.photoIds) out.photoIds = value.split(',');
    else if (name === 'max-calls' && /^[1-9][0-9]*$/.test(value) && Number(value) <= CAPS.total && out.maxCalls === undefined) out.maxCalls = Number(value);
    else throw usage();
  }
  if (out.photoIds && out.stages?.[0] !== 'look') throw usage();
  return out;
}
const verdict = passed => passed == null ? 'skipped' : passed ? 'pass' : 'fail';

export async function readBaselines(path) {
  if (!path) return new Map();
  const entries = new Map();
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const data = JSON.parse(line);
    const key = `${data.stage}:${data.inputSha256}`;
    if (!['look', 'scenes'].includes(data.stage) || !/^[a-f0-9]{64}$/.test(data.inputSha256) ||
        !Object.hasOwn(data, 'output') || entries.has(key)) throw new Error('PILOT_BASELINE_FORMAT');
    entries.set(key, data);
  }
  return entries;
}

async function claudePhotoCache(dir, key) {
  if (!dir) return null;
  try {
    return { output: JSON.parse(await readFile(join(dir, 'cache', 'photo-meta', `${key}.json`), 'utf8')), source: 'cache' };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export const baselineMetrics = (baseline, schema) => baseline && ({
  source: baseline.source === 'cache' ? 'cache' : 'capture',
  schemaValid: validateSchema(schema, baseline.output).length === 0,
  latencyMs: count(baseline.latencyMs),
  firstCallMs: count(baseline.callMs),
  repairs: count(baseline.repairs),
  modelId: typeof baseline.modelId === 'string' ? baseline.modelId : null,
});

export async function checkSavedScene(html, context, checkBrowser) {
  const violations = staticCheck(html, context);
  const staticResult = verdict(!violations.length);
  if (violations.some(v => v.rule.startsWith('static.'))) return { static: staticResult, browser: 'skipped' };
  try {
    const runtime = await checkBrowser({ ...context, html });
    return { static: staticResult, browser: verdict(!runtime.violations.length) };
  } catch (error) {
    if (!(error instanceof PromoError)) throw error;
    return { static: staticResult, browser: 'fail' };
  }
}

export async function captureScreens({ outDir, label, html, story, assets, fonts, browserPath }) {
  const opened = await openScene({ html, assets, fonts, browserPath, scale: 1 / 3, readFont: readFile });
  if (!opened.ok) throw new PromoError('RENDER_FAILED');
  try {
    for (const [i, scene] of story.scenes.entries()) {
      await opened.seek(scene.start + scene.duration / 2, 2000);
      await writeFile(join(outDir, `${label}-${i + 1}.jpg`), await opened.screenshot(5000));
    }
  } finally {
    await opened.close();
  }
}

async function screenshot(capture, args) {
  try { await capture(args); return 'saved'; } catch { return 'failed'; }
}

export function sceneInputs(references, photoSource) {
  const { store } = photoSource.listCatalog();
  return REFERENCE_IDS.map(id => {
    const ref = references.refs.get(id);
    if (!ref?.exampleStory || !ref.exampleHtml) throw new Error('PILOT_REFERENCE_MISSING');
    const story = JSON.parse(ref.exampleStory);
    if (story.referenceId !== id || !story.scenes.length) throw new Error('PILOT_REFERENCE_INVALID');
    const exterior = photoSource.photoInfo(store.exteriorPhotoId);
    const photoIds = [...new Set(story.scenes.flatMap(scene => scene.photoIds))].filter(photoId => photoId !== exterior.photoId);
    const photos = photoIds.map(photoId => photoSource.photoInfo(photoId));
    if (photos.some(photo => !photo)) throw new Error('PILOT_REFERENCE_PHOTO_MISSING');
    return { id, stage: 'scenes', ref, story, store, input: { referenceId: id, lengthSec: story.lengthSec, photoIds }, promptCtx: { photos, exterior } };
  });
}

/** The context the checks and screenshots need for one scene input (same for NAVER, Claude and gallery rows). */
export async function sceneContextFor(item, photoSource, references) {
  const assets = await photoAssets(photoSource, [...item.input.photoIds, item.promptCtx.exterior.photoId]);
  return { story: item.story, store: item.store, rules: references.rules, lengthSec: item.story.lengthSec, assets, fonts: references.fonts };
}

/** Saves one frame per scene for an HTML that passed the static rules; skips HTML with prohibited code. */
export function sceneShooter({ sceneContext, outDir, id, capture, browserPath }) {
  return (label, html) => html != null && !staticCheck(html, sceneContext).some(v => v.rule.startsWith('static.'))
    ? screenshot(capture, { ...sceneContext, outDir, label: `${id}-${label}`, html, browserPath })
    : 'skipped';
}

/** Runs the saved Claude HTML through the same static + browser checks and screenshots as NAVER (no provider call). */
export async function compareClaudeScene({ result, baseline, sceneContext, checkBrowser, shot }) {
  result.claude = baselineMetrics(baseline, SCENE_SCHEMA);
  const saved = result.claude.schemaValid ? await checkSavedScene(baseline.output.html, sceneContext, checkBrowser) : null;
  result.claude.passed = saved?.static === 'pass' && saved?.browser === 'pass';
  result.claude.firstPassed = typeof baseline.firstPassed === 'boolean' ? baseline.firstPassed : null;
  if (saved) {
    result.claude.check = saved;
    result.claude.screenshot = await shot('claude', baseline.output.html);
  }
  return result;
}

export function parity(cases) {
  const cell = (values, metric) => {
    const available = values.filter(value => value[metric] != null);
    if (!available.length) return 'unavailable';
    if (['schemaValid', 'passed', 'firstPassed'].includes(metric)) {
      return `${available.filter(value => value[metric]).length}/${available.length}`;
    }
    const total = available.reduce((sum, value) => sum + value[metric], 0);
    const mean = total / available.length;
    return `${metric === 'repairs' ? mean.toFixed(2) : Math.round(mean)} (n=${available.length})`;
  };
  const row = (stage, label, values) => `| ${stage} | ${label} | ${values.length} | ${cell(values, 'schemaValid')} | ${cell(values, 'firstPassed')} | ${cell(values, 'passed')} | ${cell(values, 'repairs')} | ${cell(values, 'latencyMs')} | ${cell(values, 'firstCallMs')} |`;
  const lines = [
    '| Stage | Evidence | Inputs | Schema valid | First-pass static + browser | Final static + browser | Mean repairs | Mean latency (ms) | Mean first-call latency (ms) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const stage of ['look', 'scenes']) {
    const all = cases.filter(item => item.stage === stage);
    const paired = all.filter(item => item.claude);
    lines.push(row(stage, 'NAVER (all planned inputs)', all));
    lines.push(row(stage, 'NAVER (matched inputs)', paired));
    lines.push(row(stage, 'Claude (matching captures or cache)', paired.map(item => item.claude)));
  }
  lines.push(row('scenes', 'Gallery examples', cases.flatMap(item => item.gallery ? [item.gallery] : [])));
  lines.push('', 'Latency covers the whole input (provider calls, retries, repairs and checks); first-call latency is the first provider call alone. A Claude scene capture is one call with no repair, so its first-pass and final columns are the same check. Claude timing and repairs are available only from matching captures. Gallery examples are visual targets. Scene inputs use the existing example stories and the generation prompt includes the gallery HTML. Exact HTML matches are identified per input. Visual parity requires screenshot review.');
  return `${lines.join('\n')}\n`;
}

export async function runPilot({
  outDir, transport, browserPath, references = loadReferences(),
  checkBrowser = args => runSceneCheck({ ...args, browserPath }),
  captureScreens: capture = captureScreens,
  claudeDir, claudeModel = 'sonnet', baselinePath,
  stages: only = ['look', 'scenes'], photoIds: chosen = null, maxCalls = null,
}) {
  if (!transport?.available) throw new Error('PILOT_CLOVA_UNAVAILABLE');
  const cafe = createExamplePhotoSource({ sourceId: 'cafe' });
  const example = createExamplePhotoSource();
  const photoIds = cafe.listPhotoIds();
  if (photoIds.length !== 39 || !references.rules || !references.contract) throw new Error('PILOT_INPUTS_INVALID');
  // A narrowed run (one stage, named photos, a lower cap) is checked before any call; the default stays the full pilot.
  const wantLook = only.includes('look');
  const wantScenes = only.includes('scenes');
  const lookIds = chosen ?? photoIds;
  const inputs = [...(wantLook ? lookIds.map(id => ({ id, stage: 'look' })) : []), ...(wantScenes ? sceneInputs(references, example) : [])];
  const caps = maxCalls === null ? CAPS : { look: wantLook ? maxCalls : 0, scenes: wantScenes ? maxCalls : 0, total: maxCalls };
  if (!inputs.length || only.some(stage => !['look', 'scenes'].includes(stage)) || (chosen && (!wantLook || new Set(chosen).size !== chosen.length || chosen.some(id => !photoIds.includes(id))))
      || (maxCalls !== null && (only.length !== 1 || !Number.isSafeInteger(maxCalls) || maxCalls < inputs.length || maxCalls > CAPS.total))) throw usage();
  const baselines = await readBaselines(baselinePath);
  await mkdir(dirname(outDir), { recursive: true });
  await mkdir(outDir, { mode: 0o700 }); // An existing result directory prevents an accidental repeat.
  const callsLog = join(outDir, 'calls.jsonl');
  const caseLog = join(outDir, 'cases.jsonl');
  const shotsDir = join(outDir, 'screenshots');
  await mkdir(shotsDir);
  await writeFile(callsLog, '');
  await writeFile(caseLog, '');
  const cases = [];
  const emptyTokens = () => ({ input: 0, output: 0, total: 0, missingCalls: 0 });
  const tokens = emptyTokens();
  const stages = { look: { calls: 0, cap: caps.look, tokens: emptyTokens() }, scenes: { calls: 0, cap: caps.scenes, tokens: emptyTokens() } };
  let calls = 0;

  for (const [index, item] of inputs.entries()) {
    const { id, stage } = item;
    const look = stage === 'look';
    const model = look ? HCX_PHOTO_MODEL : HCX_PROMO_MODEL;
    const started = Date.now();
    const laterInStage = inputs.slice(index + 1).filter(later => later.stage === stage).length;
    // A retry only when the cap leaves a spare call; otherwise the first call's own outcome is the result.
    const retries = caps[stage] > inputs.filter(other => other.stage === stage).length ? 1 : 0;
    const events = [];
    const job = { input: item.input, usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, checks: [], fixCount: 0, stage };
    const runner = createHcxRunner({
      stage, transport, retries,
      beforeCall() {
        // Keep one first attempt available for every later input of this stage; never pass the stage or total cap.
        if (calls >= caps.total || stages[stage].calls >= caps[stage] - laterInStage) throw new PromoError(STOP);
        calls++;
        stages[stage].calls++;
      },
      onCall(event) { events.push({ stage, id, call: calls, repair: job.fixCount, ...event, check: null }); },
    });
    let inputSha256 = null;
    let photoCacheKey;
    let latestHtml;
    let outcome = 'success';
    let sceneContext;
    const invoke = async request => {
      inputSha256 ??= inputFingerprint(request);
      const result = await runner.run(request);
      latestHtml = result.output.html;
      return result;
    };
    try {
      if (look) {
        const { cacheKey, request } = await photoMetaInput(cafe, id, claudeModel);
        photoCacheKey = cacheKey;
        await invoke(request);
      } else {
        job.dir = await mkdtemp(join(tmpdir(), 'navis-hcx-scene-'));
        sceneContext = await sceneContextFor(item, example, references);
        const pipeline = createPipeline({
          sceneRunner: { run: invoke }, photoSource: example, references, checkScene: checkBrowser,
          onSceneCheck({ staticPassed, browserPassed, checkMs, violations }) {
            events.at(-1).check = { static: verdict(staticPassed), browser: verdict(browserPassed), latencyMs: checkMs,
              rules: [...new Set(violations.map(item => item.rule))] };
          },
        });
        await pipeline.scenes(job, { story: item });
      }
    } catch (error) {
      if (error instanceof PromoError && error.code === STOP) outcome = STOP;
      else if (reasonOf(error)) outcome = error.code;
      else throw error;
    } finally {
      for (const event of events) {
        const { input, output, total } = event.tokens;
        for (const sum of [tokens, stages[stage].tokens]) {
          sum.input += input ?? 0;
          sum.output += output ?? 0;
          sum.total += total ?? 0;
          if (input === null || output === null || total === null) sum.missingCalls++;
        }
        event.check = look ? { schema: verdict(event.schemaValid) }
          : { schema: verdict(event.schemaValid), static: 'skipped', browser: 'skipped', ...event.check };
        await appendFile(callsLog, `${JSON.stringify(event)}\n`);
      }
      if (job.dir) await rm(job.dir, { recursive: true, force: true });
    }
    const result = {
      id, stage, model, inputSha256, outcome, schemaValid: events.at(-1)?.schemaValid === true,
      firstPassed: look ? null : (events[0]?.check?.static === 'pass' && events[0]?.check?.browser === 'pass'),
      passed: look ? null : outcome === 'success',
      repairs: look ? null : new Set(events.filter(event => event.repair > 0).map(event => event.repair)).size,
      latencyMs: Date.now() - started, firstCallMs: events[0]?.latencyMs ?? null, claude: null,
    };
    const baseline = baselines.get(`${stage}:${inputSha256}`) ?? (look && photoCacheKey ? await claudePhotoCache(claudeDir, photoCacheKey) : null);
    if (look && baseline) result.claude = baselineMetrics(baseline, PHOTO_META_SCHEMA);
    if (!look && sceneContext) {
      const shot = sceneShooter({ sceneContext, outDir: shotsDir, id, capture, browserPath });
      const check = await checkSavedScene(item.ref.exampleHtml, sceneContext, checkBrowser);
      result.gallery = { ...check, passed: check.static === 'pass' && check.browser === 'pass', screenshot: await shot('gallery', item.ref.exampleHtml) };
      if (baseline) await compareClaudeScene({ result, baseline, sceneContext, checkBrowser, shot });
      result.exactGalleryHtml = latestHtml != null && latestHtml.trim() === item.ref.exampleHtml.trim();
      result.screenshot = await shot('naver', latestHtml);
    }
    cases.push(result);
    await appendFile(caseLog, `${JSON.stringify(result)}\n`);
  }
  for (const stage of Object.values(stages)) stage.capReached = stage.cap > 0 && stage.calls === stage.cap;
  const report = { calls, cap: caps.total, capReached: calls === caps.total, caps, stages, tokens, cases };
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'parity.md'), parity(cases));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const [out, baselinePath, ...extra] = args.filter(arg => !arg.startsWith('--'));
  try {
    if (!out || extra.length) throw usage();
    const narrowed = parsePilotFlags(args.filter(arg => arg.startsWith('--')));
    const config = readConfig();
    if (!config.hcxPilot) throw new Error('PILOT_DISABLED');
    const browserPath = await detectBrowser();
    if (!browserPath) throw new Error('PILOT_CHROME_MISSING');
    const probe = await openScene({ html: '<!doctype html><html></html>', assets: new Map(), browserPath });
    if (!probe.ok) throw new Error('PILOT_CHROME_FAILED');
    await probe.close();
    const transport = createClovaStudio({ apiKey: process.env.CLOVASTUDIO_API_KEY, baseUrl: process.env.CLOVASTUDIO_BASE_URL });
    const report = await runPilot({ outDir: resolve(out), transport, browserPath, claudeDir: config.dir, claudeModel: config.model, baselinePath, ...narrowed });
    console.log(JSON.stringify({ calls: report.calls, cap: report.cap, capReached: report.capReached, stages: report.stages, tokens: report.tokens }));
  } catch (error) {
    // Avoid printing paths, request bodies, environment values or provider errors.
    const safe = /^PILOT_[A-Z_]+$/.test(error?.message) ? error.message : error?.code === 'EEXIST' ? 'PILOT_OUTPUT_EXISTS' : 'PILOT_FAILED';
    console.error(safe);
    process.exitCode = 1;
  }
}

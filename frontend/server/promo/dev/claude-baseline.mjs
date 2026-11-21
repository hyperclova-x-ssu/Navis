// PROMO-RETRY (D-326 Q8): the Claude baseline for the NAVER scene pilot.
// One headless `claude -p` call per scene input (the same 6 inputs, prompt and schema the NAVER pilot uses), no repair,
// then the same static + browser checks. It never calls NAVER and is not wired into the app.
// Output: one JSON line per input in the file `hcx-pilot.mjs` reads as "matching captures" (hcx-compare.mjs joins it).
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSceneCheck } from '../check-scene.mjs';
import { capture, detectBrowser, detectTools, readConfig } from '../config.mjs';
import { createClaudeRunner } from '../claude-runner.mjs';
import { PromoError, reasonOf } from '../errors.mjs';
import { createExamplePhotoSource } from '../photo-source.mjs';
import { createPipeline } from '../pipeline.mjs';
import { loadReferences } from '../references.mjs';
import { openScene } from '../renderer.mjs';
import { baselineEnv, inspectStream } from '../scene-provider.mjs';
import { inputFingerprint, sceneInputs } from './hcx-pilot.mjs';

// The owner never accepts paid usage credits (D-326 Q8). If the CLI ever offers them, the run stops.
// inspectStream and baselineEnv are shared with the app's own Claude CLI path (scene-provider.mjs), so both behave alike.
export { baselineEnv, inspectStream };
const STOP_CREDITS = 'PILOT_CLAUDE_CREDITS_OFFERED';
const STOP_UNAVAILABLE = 'PILOT_CLAUDE_UNAVAILABLE';

function teeSpawn(spawnProcess, sink) {
  return (command, args, options) => {
    const child = spawnProcess(command, args, options);
    child.stdout?.on('data', chunk => sink.stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => sink.stderr.push(Buffer.from(chunk)));
    return child;
  };
}

const pass = value => value === 'pass';

export async function runClaudeBaseline({
  outFile, claudeCommand, model = 'sonnet', cliVersion = null, references = loadReferences(),
  checkBrowser, spawnProcess = spawn, env = {}, tempRoot = tmpdir(), log = () => {},
}) {
  if (!claudeCommand) throw new Error('PILOT_CLAUDE_MISSING');
  const example = createExamplePhotoSource();
  const items = sceneInputs(references, example);
  await writeFile(outFile, '', { flag: 'wx' }); // An existing capture file prevents an accidental repeat.
  const rows = [];
  let stop = null;

  for (const item of items) {
    const sink = { stdout: [], stderr: [] };
    const claude = createClaudeRunner({
      command: claudeCommand, model, retries: 0, env, tempRoot, spawnProcess: teeSpawn(spawnProcess, sink),
    });
    const events = [];
    const started = Date.now();
    const job = { input: item.input, usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, checks: [], fixCount: 0, stage: 'scenes' };
    let inputSha256 = null;
    let callMs = null;
    let used = 0;
    let output = null;
    let outcome = 'success';
    const sceneRunner = {
      async run(request) {
        // One call per input: a failed first check is not repaired (D-326 Q8).
        if (used++) throw new PromoError('CODE_CHECK_FAILED');
        inputSha256 = inputFingerprint(request);
        const callStarted = Date.now();
        try {
          const result = await claude.run(request);
          output = result.output;
          return result;
        } finally {
          callMs = Date.now() - callStarted;
        }
      },
    };
    job.dir = await mkdtemp(join(tempRoot, 'navis-claude-scene-'));
    try {
      const pipeline = createPipeline({
        sceneRunner, photoSource: example, references, checkScene: checkBrowser,
        onSceneCheck({ staticPassed, browserPassed }) { events.push({ static: staticPassed, browser: browserPassed }); },
      });
      await pipeline.scenes(job, { story: item });
    } catch (error) {
      if (!reasonOf(error)) throw error;
      outcome = error.code;
    } finally {
      await rm(job.dir, { recursive: true, force: true });
    }
    const seen = inspectStream(Buffer.concat(sink.stdout).toString('utf8'), Buffer.concat(sink.stderr).toString('utf8'));
    const first = events[0];
    const row = {
      stage: 'scenes', id: item.id, inputSha256, model, modelId: seen.modelId, cliVersion, outcome,
      output: output ?? null, repairs: 0, firstPassed: first ? first.static === true && first.browser === true : false,
      firstCheck: first ? { static: first.static ? 'pass' : 'fail', browser: first.browser == null ? 'skipped' : first.browser ? 'pass' : 'fail' } : null,
      latencyMs: Date.now() - started, callMs, cliDurationMs: seen.cliDurationMs,
      tokens: { input: job.usage.inputTokens, output: job.usage.outputTokens },
    };
    rows.push(row);
    await writeFile(outFile, `${rows.map(entry => JSON.stringify(entry)).join('\n')}\n`);
    log(row);
    if (seen.credits) { stop = STOP_CREDITS; break; }
    if (outcome === 'AI_UNAVAILABLE' || outcome === 'TOOL_MISSING') { stop = STOP_UNAVAILABLE; break; }
  }
  return { rows, stop, passedFirst: rows.filter(row => pass(row.firstCheck?.static) && pass(row.firstCheck?.browser)).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [out, ...extra] = process.argv.slice(2);
  try {
    if (!out || extra.length) throw new Error('PILOT_USAGE');
    const config = readConfig();
    const tools = await detectTools();
    if (!tools.claude) throw new Error('PILOT_CLAUDE_MISSING');
    const browserPath = await detectBrowser();
    if (!browserPath) throw new Error('PILOT_CHROME_MISSING');
    const probe = await openScene({ html: '<!doctype html><html></html>', assets: new Map(), browserPath });
    if (!probe.ok) throw new Error('PILOT_CHROME_FAILED');
    await probe.close();
    const cliVersion = (await capture(tools.claude, ['--version'])).stdout.trim() || null;
    const env = baselineEnv(process.env);
    const report = await runClaudeBaseline({
      outFile: resolve(out), claudeCommand: tools.claude, model: config.model, cliVersion, env,
      checkBrowser: args => runSceneCheck({ ...args, browserPath }),
      log: row => console.log(JSON.stringify({ id: row.id, outcome: row.outcome, modelId: row.modelId, firstPassed: row.firstPassed, callMs: row.callMs })),
    });
    console.log(JSON.stringify({ inputs: report.rows.length, passedFirst: report.passedFirst, stop: report.stop }));
    if (report.stop) process.exitCode = 2;
  } catch (error) {
    // Avoid printing paths, request bodies, environment values or provider errors.
    const safe = /^PILOT_[A-Z_]+$/.test(error?.message) ? error.message : error?.code === 'EEXIST' ? 'PILOT_OUTPUT_EXISTS' : 'PILOT_FAILED';
    console.error(safe);
    process.exitCode = 1;
  }
}

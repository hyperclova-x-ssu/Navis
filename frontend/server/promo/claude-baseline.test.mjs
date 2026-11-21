import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClovaStudio } from '../clova-studio.mjs';
import { baselineEnv, inspectStream, runClaudeBaseline } from './dev/claude-baseline.mjs';
import { compareBaseline } from './dev/hcx-compare.mjs';
import { runPilot } from './dev/hcx-pilot.mjs';
import { loadReferences } from './references.mjs';
import { PHOTO_META, fakeSpawn, resultLine } from './test/helpers.mjs';

const references = loadReferences();
const MODEL_ID = 'claude-sonnet-5-5';
const modelUsage = { [MODEL_ID]: { inputTokens: 100, outputTokens: 50 } };
const referenceOf = input => /"referenceId":"(ref-[1-6])"/.exec(JSON.parse(input).message.content.at(-1).text)[1];
const galleryReply = input => ({ stdout: resultLine({ html: references.refs.get(referenceOf(input)).exampleHtml }, { modelUsage }) });
const noViolations = async () => ({ violations: [] });

async function tempDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'navis-claude-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function naverPilot(dir) {
  const reply = output => globalThis.Response.json({
    status: { code: '20000' },
    result: { message: { role: 'assistant', content: JSON.stringify(output) }, finishReason: 'stop', usage: { promptTokens: 90, completionTokens: 24, totalTokens: 114 } },
  });
  const transport = createClovaStudio({ apiKey: 'secret-fake-value', fetchImpl: async (url, request) => {
    if (url.split('/').at(-1) === 'HCX-005') return reply(PHOTO_META);
    return reply({ html: references.refs.get(/"referenceId":"(ref-[1-6])"/.exec(JSON.parse(request.body).messages[0].content)[1]).exampleHtml });
  } });
  return runPilot({ outDir: join(dir, 'naver'), transport, references, checkBrowser: noViolations, captureScreens: async () => {} });
}

test('baseline makes one Claude call per input with the NAVER request fingerprint and records the exact model id', async t => {
  const dir = await tempDir(t);
  const report = await naverPilot(dir);
  const outFile = join(dir, 'claude.jsonl');
  const seen = [];
  const result = await runClaudeBaseline({
    outFile, claudeCommand: '/fake/claude', cliVersion: '9.9.9', references, checkBrowser: noViolations, tempRoot: dir,
    spawnProcess: fakeSpawn(galleryReply, seen), env: { PATH: '/bin', HOME: '/h' },
  });
  assert.equal(seen.length, 6);
  assert.equal(result.stop, null);
  assert.deepEqual(seen.map(call => referenceOf(call.input)), ['ref-1', 'ref-2', 'ref-3', 'ref-4', 'ref-5', 'ref-6']);
  assert.ok(seen.every(call => call.args.includes('--model') && call.args[call.args.indexOf('--model') + 1] === 'sonnet'));
  const rows = (await readFile(outFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 6);
  const naver = new Map(report.cases.filter(row => row.stage === 'scenes').map(row => [row.id, row.inputSha256]));
  for (const row of rows) {
    assert.equal(row.inputSha256, naver.get(row.id), `${row.id} fingerprint matches the NAVER first request`);
    assert.deepEqual([row.stage, row.model, row.modelId, row.cliVersion, row.outcome, row.repairs, row.firstPassed], ['scenes', 'sonnet', MODEL_ID, '9.9.9', 'success', 0, true]);
    assert.deepEqual([row.firstCheck, row.tokens], [{ static: 'pass', browser: 'pass' }, { input: 110, output: 50 }]);
    assert.ok(Number.isSafeInteger(row.latencyMs) && Number.isSafeInteger(row.callMs) && row.cliDurationMs === 1234);
    assert.match(row.output.html, /^<!doctype html>/i);
  }
});

test('a failed first check is recorded, not repaired, and a second run never overwrites the capture', async t => {
  const dir = await tempDir(t);
  const outFile = join(dir, 'claude.jsonl');
  const seen = [];
  await runClaudeBaseline({
    outFile, claudeCommand: '/fake/claude', references, checkBrowser: noViolations, tempRoot: dir,
    spawnProcess: fakeSpawn(() => ({ stdout: resultLine({ html: '<!doctype html><html></html>' }, { modelUsage }) }), seen),
  });
  assert.equal(seen.length, 6, 'one call per input, no repair call');
  const rows = (await readFile(outFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.every(row => row.outcome === 'CODE_CHECK_FAILED' && row.firstPassed === false && row.repairs === 0));
  assert.ok(rows.every(row => row.firstCheck.static === 'fail' && row.output.html), 'the failed first answer is kept for review');
  await assert.rejects(runClaudeBaseline({ outFile, claudeCommand: '/fake/claude', references, checkBrowser: noViolations, spawnProcess: fakeSpawn(() => ({}), seen) }), { code: 'EEXIST' });
  assert.equal(seen.length, 6);
});

test('baseline stops at once when the CLI offers usage credits and never passes an API key to the child', async t => {
  const dir = await tempDir(t);
  const seen = [];
  const offer = `${JSON.stringify({ type: 'system', subtype: 'notice', text: 'Switch to usage credits to keep going' })}\n`;
  const result = await runClaudeBaseline({
    outFile: join(dir, 'claude.jsonl'), claudeCommand: '/fake/claude', references, checkBrowser: noViolations, tempRoot: dir,
    spawnProcess: fakeSpawn(() => ({ stdout: offer + resultLine({ html: '<!doctype html><html></html>' }) }), seen),
  });
  assert.equal(result.stop, 'PILOT_CLAUDE_CREDITS_OFFERED');
  assert.equal(seen.length, 1);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(baselineEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'y', CLAUDE_CONFIG_DIR: '/c' }), { PATH: '/bin', CLAUDE_CONFIG_DIR: '/c' });
  const overage = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', isUsingOverage: true } });
  assert.equal(inspectStream(`${overage}\n`).credits, true);
  // Generated HTML that happens to mention credits is not an offer.
  const html = JSON.stringify({ type: 'result', is_error: false, structured_output: { html: '<p>usage credits</p>' }, modelUsage });
  assert.deepEqual([inspectStream(`${html}\n`).credits, inspectStream(`${html}\n`).modelId], [false, MODEL_ID]);
});

test('compare puts the Claude capture next to the NAVER result without calling a provider', async t => {
  const dir = await tempDir(t);
  const report = await naverPilot(dir);
  const baselinePath = join(dir, 'claude.jsonl');
  await runClaudeBaseline({
    outFile: baselinePath, claudeCommand: '/fake/claude', references, checkBrowser: noViolations, tempRoot: dir,
    spawnProcess: fakeSpawn((input, _args, n) => ({ stdout: resultLine({ html: n === 2 ? '<!doctype html><html></html>' : references.refs.get(referenceOf(input)).exampleHtml }, { modelUsage }) })),
  });
  const before = await readFile(join(dir, 'naver', 'parity.md'), 'utf8');
  const shots = [];
  const { matched, cases } = await compareBaseline({
    outDir: join(dir, 'naver'), baselinePath, references, checkBrowser: noViolations,
    captureScreens: async args => { shots.push(args.label); await writeFile(join(args.outDir, `${args.label}.jpg`), ''); },
  });
  assert.equal(matched, 6);
  assert.equal(cases.filter(row => row.stage === 'look' && row.claude).length, 0);
  const claude = cases.filter(row => row.stage === 'scenes').map(row => row.claude);
  assert.deepEqual(claude.map(row => [row.modelId, row.schemaValid, row.passed, row.firstPassed, row.repairs]), [
    [MODEL_ID, true, true, true, 0], [MODEL_ID, true, false, false, 0], ...Array.from({ length: 4 }, () => [MODEL_ID, true, true, true, 0]),
  ]);
  assert.deepEqual(shots, ['ref-1', 'ref-2', 'ref-3', 'ref-4', 'ref-5', 'ref-6'].map(id => `${id}-claude`), 'only the Claude frames are new; NAVER frames stay as the pilot saved them');
  const table = await readFile(join(dir, 'naver', 'parity.md'), 'utf8');
  assert.match(table, /\| scenes \| Claude \(matching captures or cache\) \| 6 \| 6\/6 \| 5\/6 \| 5\/6 \| 0\.00 \(n=6\) \|/);
  assert.match(table, /\| scenes \| NAVER \(matched inputs\) \| 6 \|/);
  assert.equal(await readFile(join(dir, 'naver', 'parity.naver-only.md'), 'utf8'), before);
  const saved = JSON.parse(await readFile(join(dir, 'naver', 'summary.json'), 'utf8'));
  assert.equal(saved.cases.filter(row => row.claude).length, 6);
  assert.equal(saved.calls, report.calls, 'NAVER call counts are untouched');
});

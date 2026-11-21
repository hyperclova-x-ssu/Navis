// Server-only evaluation: node server/dev/navis-eval.mjs --out /path/report.md
// Uses CLOVASTUDIO_API_KEY / BASE_URL / MODEL from the server environment.
// No prompts, answers, upstream bodies, credentials or headers are written.
import { readFile, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge, NAVIS_FORBIDDEN_PHRASES, NAVIS_LIST_LINE, NAVIS_OUTSIDE_SUGGESTIONS, NAVIS_PROMPT_LABEL, navisGroundingIssues, navisForbiddenHits, navisStepsRequested } from '../bridge.mjs';

export function navisAnswerIssues(answer, expected = [], input) {
  const lines = answer.split(/\r?\n/u), issues = [];
  if (/\[(?:IN|OUT)(?:_SCOPE|_OF_SCOPE)?\]/u.test(answer)) issues.push('scope-marker');
  if (lines.some(line => NAVIS_PROMPT_LABEL.test(line.trim()))) issues.push('prompt-label');
  if (lines.some((line, index) => /[:：]$/u.test(line.trim()) && !lines.slice(index + 1).some(next => next.trim()))) issues.push('empty-lead-in');
  if (expected.includes('unsupported-first') && !/직접|수\s*없|못/u.test(answer.split(/[.!?。！？\r\n]/u)[0])) issues.push('action-ability');
  if (/항공사|여행사|본사|프랜차이즈/u.test(answer)) issues.push('forbidden-route');
  if (/\*\*|`|^[ \t]*#/mu.test(answer)) issues.push('markdown');
  if (/^\s/u.test(answer)) issues.push('leading-whitespace');
  if (input && answer.trim()) issues.push(...navisGroundingIssues(answer, input));
  if (navisForbiddenHits(answer).some(phrase => NAVIS_OUTSIDE_SUGGESTIONS.includes(phrase))) issues.push('outside-tool');
  return issues;
}
export function evaluationCounts(rows) {
  const outside = rows.filter(row => row.id.startsWith('h5-out-')), store = rows.filter(row => row.id.startsWith('h5-store-'));
  const reservations = rows.filter(row => row.expected.includes('no-false-refusal'));
  const widgets = rows.filter(row => row.expected.includes('widget-cards'));
  const steps = rows.filter(row => row.expected.includes('fixed-steps'));
  const completed = rows.filter(row => !row.cut && !row.error && !row.code);
  return [
    `Completed: ${completed.length}/${rows.length}; OUT_OF_SCOPE: ${rows.filter(row => row.code === 'OUT_OF_SCOPE').length}; errors: ${rows.filter(row => row.error).length}; cuts: ${rows.filter(row => row.cut).length}; answer retries: ${rows.filter(row => row.answerAttempts === 2).length}.`,
    `H5 OUT_OF_SCOPE with zero text/cards: ${outside.filter(row => row.code === 'OUT_OF_SCOPE' && row.textEvents === 0 && row.cards === 0).length}/${outside.length}; store answers: ${store.filter(row => !row.code && !row.cut && !row.error && row.textEvents > 0 && row.forbidden.length === 0).length}/${store.length}.`,
    ...['scope-marker', 'prompt-label', 'empty-lead-in', 'action-ability', 'forbidden-route', 'markdown', 'leading-whitespace', 'outside-tool', 'grounding', 'navigation', 'repeated-route'].map(issue => `${issue}: ${rows.filter(row => row.issues.includes(issue)).length}/${rows.length}.`),
    `reservation-scope: ${reservations.filter(row => row.issues.includes('reservation-scope')).length}/${reservations.length}.`,
    `fixed-steps: ${steps.filter(row => row.issues.includes('fixed-steps')).length}/${steps.length} mismatches.`,
    `widget-cards: ${widgets.filter(row => row.issues.includes('widget-cards')).length}/${widgets.length} mismatches.`,
    ...widgets.map(row => `${row.id}: ${row.cards} card(s) [${row.cardIds.join(', ')}].`),
  ];
}

export async function loadQuestions() {
  return JSON.parse(await readFile(new URL('./navis-eval-questions.json', import.meta.url), 'utf8'));
}
function forbiddenHits(text, question) {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\s/gu, '');
  const hits = [...NAVIS_FORBIDDEN_PHRASES, '제공된 자료에서 직접'].filter(phrase => normalized.includes(phrase.normalize('NFKC').toLowerCase().replace(/\s/gu, '')));
  if (!navisStepsRequested(question) && text.split(/[\r\n]/u).some(line => NAVIS_LIST_LINE.test(line))) hits.push('numbered-list');
  return hits;
}
async function ask(bridge, input) {
  const start = performance.now();
  let firstTextMs = null, answer = '', cardIds = [], sawDone = false, error = false, code = '', textEvents = 0, buffer = '';
  const req = Readable.from([Buffer.from(JSON.stringify(input))]);
  Object.assign(req, { url: '/api/navis/chat', method: 'POST', headers: { host: '127.0.0.1:5211', origin: 'http://127.0.0.1:5211', 'content-type': 'application/json' }, socket: { localAddress: '127.0.0.1', localPort: 5211 } });
  const res = new Writable({ write(chunk, _encoding, done) {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      try {
        const event = /^event: (\w+)$/mu.exec(frame)?.[1];
        const data = JSON.parse(/^data: (.*)$/mu.exec(frame)?.[1] ?? '{}');
        if (event === 'text_delta') { textEvents++; firstTextMs ??= Math.round(performance.now() - start); answer += data.delta; }
        if (event === 'panels') cardIds = data.panels.map(panel => panel.featureId);
        if (event === 'done') sawDone = true;
        if (event === 'error') { code = ['OUT_OF_SCOPE', 'INVALID_OUTPUT', 'UNAVAILABLE', 'TIMEOUT', 'CANCELLED'].includes(data.code) ? data.code : 'UNKNOWN'; if (code !== 'OUT_OF_SCOPE') error = true; }
      } catch { error = true; }
    }
    done();
  } });
  res.writeHead = status => { res.statusCode = status; return res; };
  res.flushHeaders = () => {};
  try { await bridge(req, res); } catch { error = true; }
  if (res.statusCode !== 200) error = true;
  return { answer, firstTextMs, totalMs: Math.round(performance.now() - start), cut: !sawDone && code !== 'OUT_OF_SCOPE',
    done: sawDone, error, code, textEvents, cards: cardIds.length, cardIds };
}
export async function runEvaluation({ questions, fixture, out, answers, bridgeOptions = {}, intervalMs = 0 } = {}) {
  if (!out) throw new Error('An --out path is required');
  if (answers && resolve(answers) === resolve(out)) throw new Error('--answers and --out paths must be distinct');
  let diagnostic = {}, previousCall = false;
  const bridge = createBridge({ ...bridgeOptions, onDiagnostics: value => { diagnostic = value; } });
  const rows = [], released = [];
  async function request(input) {
    if (previousCall && intervalMs > 0) await delay(intervalMs);
    previousCall = true; diagnostic = {};
    return ask(bridge, input);
  }
  try {
    for (const item of questions) {
      const base = { ...fixture, locale: item.locale ?? fixture.locale ?? 'ko' };
      // A fixture may supply a separate current-layer snapshot/catalog per item.
      // Never invent facts for a layer that has no fixture.
      if (item.layer && item.layer !== base.layer) {
        base.layer = item.layer;
        base.catalog = base.catalog.filter(entry => entry.layer === item.layer);
        const ids = new Set(base.catalog.map(entry => entry.id));
        base.snapshot = base.snapshot.filter(entry => ids.has(entry.featureId) || entry.sourceId);
      }
      const history = [];
      for (const turn of item.priorTurns ?? []) {
        if (turn.role === 'assistant') { history.push(turn); continue; }
        const prior = await request({ ...base, text: turn.text, history });
        if (!prior.cut && !prior.error && prior.answer.trim()) history.push(turn, { role: 'assistant', text: prior.answer });
      }
      const input = { ...base, text: item.question, history };
      const response = await request(input);
      const issues = navisAnswerIssues(response.answer, item.expected, input);
      if (item.expected.includes('no-false-refusal') && response.code === 'OUT_OF_SCOPE') issues.push('reservation-scope');
      if (item.expected.includes('fixed-steps') && (!response.done || response.error || response.answer !== item.expectedAnswer || diagnostic.answerAttempts !== 0)) issues.push('fixed-steps');
      if (item.expected.includes('widget-cards') && (!response.done || response.error || !response.cards || item.expectedCardIds
        && [...response.cardIds].sort().join(',') !== [...item.expectedCardIds].sort().join(','))) issues.push('widget-cards');
      if (answers) released.push({ id: item.id, question: item.question, answer: response.answer });
      rows.push({ id: item.id, question: item.question, expected: item.expected, firstTextMs: response.firstTextMs, totalMs: response.totalMs,
        cut: response.cut || Boolean(diagnostic.interrupted), error: response.error, dropped: diagnostic.droppedSentences ?? 0,
        code: response.code, done: response.done, textEvents: response.textEvents, answerAttempts: diagnostic.answerAttempts ?? 0, cards: response.cards, cardIds: response.cardIds,
        forbidden: forbiddenHits(response.answer, item.question), issues });
    }
  } finally { bridge.close(); }
  const cell = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]/gu, ' ');
  const lines = ['# Navis evaluation', '', 'Metrics only; this report contains no prompts, facts or model answers. Cut includes upstream interruptions even when the bridge safely finished.', '',
    '| id | question | expected | first-text ms | total ms | cut | error | code | text events | answer attempts | dropped | cards | card ids | forbidden | answer checks |',
    '| --- | --- | --- | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${[row.id, row.question, row.expected.join(', '), row.firstTextMs ?? '—', row.totalMs, row.cut, row.error, row.code || '—', row.textEvents, row.answerAttempts, row.dropped, row.cards, row.cardIds.join(', ') || '—', row.forbidden.join(', ') || '—', row.issues.join(', ') || '—'].map(cell).join(' | ')} |`);
  const outside = rows.filter(row => row.id.startsWith('h5-out-'));
  const store = rows.filter(row => row.id.startsWith('h5-store-'));
  if (outside.length || store.length) lines.push('', '## H5 counts', '',
    `OUT_OF_SCOPE with zero text/cards: ${outside.filter(row => row.code === 'OUT_OF_SCOPE' && row.textEvents === 0 && row.cards === 0).length}/${outside.length}.`,
    `Store answers with no error, forbidden phrase or unrequested list: ${store.filter(row => !row.code && !row.cut && !row.error && row.textEvents > 0 && row.forbidden.length === 0).length}/${store.length}.`,
    'Numeric output is constrained by the same bridge guard; dropped counts include rejected numeric, forbidden, ungrounded and list sentences.');
  lines.push('', '## Default answer checks', '', ...evaluationCounts(rows));
  await writeFile(out, lines.join('\n') + '\n', 'utf8');
  // Explicit opt-in only. Exclusive creation prevents following an existing
  // symlink or reusing a more permissive file; never serialize upstream data.
  if (answers) await writeFile(answers, JSON.stringify(released, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return rows;
}
async function main() {
  const args = process.argv.slice(2), at = args.indexOf('--out');
  const usage = 'Usage: node server/dev/navis-eval.mjs --out <report.md> [--answers <private-new.json>] [--fixture <request.json>] [--fake]';
  const answersAt = args.indexOf('--answers'), fixtureAt = args.indexOf('--fixture');
  if ([at, answersAt, fixtureAt].some(index => index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) || at < 0) throw new Error(usage);
  const fake = args.includes('--fake');
  if (!fake && !process.env.CLOVASTUDIO_API_KEY?.trim()) throw new Error('CLOVASTUDIO_API_KEY is required on the server');
  const fixture = JSON.parse(await readFile(fixtureAt < 0 ? new URL('../fixtures/navis-real-request.json', import.meta.url) : args[fixtureAt + 1], 'utf8'));
  const questions = await loadQuestions();
  const bridgeOptions = fake ? { apiKey: 'fake-sentinel', fetchImpl: (await import('../fixtures/navis-eval-fake.mjs')).createNavisEvalFake(fixture) } :
    { apiKey: process.env.CLOVASTUDIO_API_KEY, baseUrl: process.env.CLOVASTUDIO_BASE_URL, model: process.env.CLOVASTUDIO_MODEL };
  const rows = await runEvaluation({ questions, fixture, out: args[at + 1], answers: answersAt < 0 ? undefined : args[answersAt + 1], intervalMs: fake ? 0 : 15000, bridgeOptions });
  process.stdout.write(`Evaluation finished: ${questions.length} questions.\n`);
  process.stdout.write(evaluationCounts(rows).join('\n') + '\n');
  if (fake) process.stdout.write('Fake transport only; real-model answer quality remains unverified.\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Only our own static setup messages are safe to print.
    process.stderr.write(['An --out path is required', 'Usage: node server/dev/navis-eval.mjs --out <report.md> [--answers <private-new.json>] [--fixture <request.json>]', 'CLOVASTUDIO_API_KEY is required on the server', '--answers and --out paths must be distinct'].includes(error.message) ? `${error.message}\n` : 'Evaluation failed; check the output path and server configuration (answers requires a new private path).\n');
    process.exitCode = 1;
  });
}

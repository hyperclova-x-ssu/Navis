// npm run promo:smoke — 실제 claude·Chrome·ffmpeg로 ref-1·15초·5장 한 편을 만든다(사용자 계정 사용량을 씀).
// 단계별 시간·토큰·고치기 횟수·검사 위반 종류·파일 정보를 출력하고, mp4가 720×1280·15.0±0.1초·h264·aac인지 확인한다.
// 작업 폴더는 NAVIS_PROMO_DIR(기본 os.tmpdir()/navis-promo-smoke)에 남는다. 프롬프트·생성 코드는 출력하지 않는다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPromoService } from './service.mjs';
import { probeVideo } from './recorder.mjs';
import { detectTools } from './config.mjs';

const dir = process.env.NAVIS_PROMO_DIR || join(tmpdir(), 'navis-promo-smoke');
const env = { ...process.env, NAVIS_PROMO_DIR: dir };
delete env.NAVIS_PROMO_FAULT;
const input = {
  menuIds: ['financier'], photoIds: ['fin-01', 'fin-03', 'fin-05', 'fin-07', 'fin-09'], moods: ['lively'], concepts: ['new-item'],
  memo: process.env.SMOKE_MEMO ?? '', referenceId: process.env.SMOKE_REF || 'ref-1', lengthSec: Number(process.env.SMOKE_LENGTH || 15), locale: 'ko',
};
const time = () => new Date().toISOString();
const log = line => process.stdout.write(`${line}\n`);

const svc = createPromoService({ env });
const server = createServer((req, res) => svc(req, res));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let exitCode = 1;
try {
  const est = await (await fetch(`${base}/api/promo/estimate-model`)).json();
  log(`[smoke] ${time()} dir=${dir}`);
  log(`[smoke] tools available=${JSON.stringify(est.available)} estimate(${input.lengthSec}s·5장)=${est.table[input.lengthSec][5].seconds}s ${est.table[input.lengthSec][5].costKrw}원 basis=${est.basis}`);
  if (!Object.values(est.available).every(Boolean)) throw new Error('도구 없음(TOOL_MISSING)');
  const res = await fetch(`${base}/api/promo/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ idempotencyKey: `smoke-${randomBytes(6).toString('hex')}`, input }) });
  const accepted = await res.json();
  if (res.status !== 202) throw new Error(`접수 실패 ${res.status} ${JSON.stringify(accepted)}`);
  log(`[smoke] job ${accepted.jobId} ${JSON.stringify(input)}`);
  const started = Date.now();
  let last = '';
  let job;
  for (;;) {
    job = await (await fetch(`${base}/api/promo/jobs/${accepted.jobId}`)).json();
    const now = `${job.status}/${job.stage}/${job.stageState}`;
    if (now !== last) { log(`[smoke] +${((Date.now() - started) / 1000).toFixed(1)}s ${now}`); last = now; }
    if (job.status === 'done' || job.status === 'failed') break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const full = JSON.parse(await readFile(join(dir, 'jobs', accepted.jobId, 'job.json'), 'utf8'));
  log(`[smoke] total ${((Date.now() - started) / 1000).toFixed(1)}s stageMs=${JSON.stringify(full.stageMs)}`);
  log(`[smoke] usage=${JSON.stringify(full.usage)} fixCount=${full.fixCount} storyRewriteCount=${full.storyRewriteCount}`);
  for (const c of full.checks) {
    const counts = {};
    for (const v of c.violations) counts[v.rule] = (counts[v.rule] || 0) + 1;
    log(`[smoke] check v${c.version}${c.stage ? `(${c.stage})` : ''} passed=${c.passed} ${c.checkMs}ms violations=${JSON.stringify(counts)}`);
  }
  if (job.status !== 'done') throw new Error(`실패 ${job.stage} ${job.failReason} ${JSON.stringify(full.checkSummary)}`);
  const file = join(dir, 'jobs', accepted.jobId, 'final.mp4');
  const info = await probeVideo((await detectTools({ env })).ffmpeg.ffprobe, file);
  log(`[smoke] file=${file}`);
  log(`[smoke] ffprobe ${JSON.stringify(info)} music=${JSON.stringify(job.result.music)}`);
  const ok = info.width === 720 && info.height === 1280 && Math.abs(info.durationSec - input.lengthSec) <= 0.1 && info.videoCodec === 'h264' && info.audioCodec === 'aac';
  log(`[smoke] ${ok ? 'PASS' : 'FAIL'} 720x1280·${input.lengthSec}±0.1s·h264·aac`);
  exitCode = ok ? 0 : 1;
} catch (err) {
  log(`[smoke] FAIL ${err.message}`);
} finally {
  await svc.close();
  server.close();
}
process.exit(exitCode);

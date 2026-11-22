import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:18180';
const store = 'c05409a6-f082-5964-a787-c1ed3184988b';
const actor = '9fee123c-ad63-5539-9775-3381f3c67ffe';
const otherStore = '33123a19-6780-4d38-9bca-ce96efcf8559';
const history = ['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17'];
const forecastDay = '2026-11-24';
const fixtureNow = day => `${day}T06:45:00Z`;
const root = `/api/v1/stores/${store}`;
const forecastPath = `/forecasts/${forecastDay}/weekday-4w-v1`;
const phase3 = { ...process.env, NAVIS_PHASE3_FIXTURES: '1', NAVIS_FIXTURE_SMS_ENABLED: '1',
  NAVIS_BACKEND_DEMO_AUTH: '1', NAVIS_PROMO_FIXTURE_STAGE_INTERVAL_MS: '3000',
  NAVIS_POS_FIXTURE_NOW: fixtureNow(history.at(-1)), NAVIS_INSIGHT_FIXTURE_NOW: fixtureNow(history.at(-1)),
  NAVIS_FORECAST_FIXTURE_NOW: fixtureNow(forecastDay) };

function compose(args, env = phase3, stdin) {
  const { bavail, bsize } = statfsSync(backend);
  if (bavail * bsize < 3_000_000_000) throw new Error('Phase ③ smoke requires 3 GB of free disk');
  return execFileSync('docker', ['compose', '--env-file', '/dev/null', '-p', 'navis-backend-local',
    '--profile', 'phase3', '--profile', 'forecast', '--profile', 'streams', ...args], {
    cwd: backend, env, input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();
}

function inside(workload, source, ...args) {
  return JSON.parse(compose(['exec', '-T', workload, 'node', '--input-type=module', '-', ...args], phase3, source));
}

function scopedQuery(workload, service, role, scope, sql) {
  return inside(workload, `
    import { dbPool } from './packages/db/index.ts';
    const [service, role, scope, sql] = process.argv.slice(2);
    const pool = dbPool(service, role);
    const db = await pool.connect();
    try {
      await db.query('BEGIN READ ONLY');
      if (scope) await db.query("SELECT set_config('app.store_id', $1, true), set_config('app.stream_scope', $1, true)", [scope]);
      console.log(JSON.stringify((await db.query(sql)).rows));
    } finally { db.release(true); await pool.end(); }
  `, service, role, scope, sql);
}

await (process.argv[2] === '--prepare' ? prepare() : smoke());

async function prepare() {
  const { dbPool } = await import('../../packages/db/index.ts');
  for (const service of ['pos', 'inventory']) {
    const pool = dbPool(service, 'migrate');
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.store_id', $1, true)", [store]);
      const dates = service === 'pos' ? history : [forecastDay];
      // Both schemas persist the effective business-day boundary.
      await db.query(`INSERT INTO ${service}.business_day (store_id, business_date, starts_at, ends_at${service === 'pos' ? ', seq' : ''})
        SELECT $1, d, (d + time '05:00') AT TIME ZONE 'Asia/Seoul', (d + 1 + time '05:00') AT TIME ZONE 'Asia/Seoul'${service === 'pos' ? ', 0' : ''}
        FROM unnest($2::date[]) d ON CONFLICT DO NOTHING`, [store, dates]);
      await db.query('COMMIT');
    } finally { db.release(true); await pool.end(); }
  }
}

async function smoke() {
  const edge = (path, init) => fetch(origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const login = await edge('/api/v1/auth/demo', { method: 'POST', headers: { origin } });
  assert.equal(login.status, 200, 'Demo owner must be enabled for the fresh fixture');
  const access = await login.json();
  assert.equal(access.storeId, store);
  const request = (path, body, headers = {}) => edge(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${access.accessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function json(path, status, body) {
    const response = await request(path, body);
    assert.equal(response.status, status, path);
    return response.json();
  }
  async function eventually(label, read, matches, timeout = 25_000) {
    const until = Date.now() + timeout;
    do {
      const value = await read();
      if (matches(value)) return value;
      await delay(150);
    } while (Date.now() < until);
    throw new Error(`Timed out waiting for ${label}`);
  }

  const { items } = await json(`/api/v1/inventory/catalog?storeId=${store}`, 200);
  assert.equal(items.length, 24);
  const published = compose(['ps', '--format', '{{.Service}} {{.Ports}}']).split('\n').filter(row => row.includes('->'));
  assert.deepEqual(published, ['edge 127.0.0.1:18180->80/tcp']);

  const base = { conversation: true, runId: randomUUID(), snapshotRevision: 7, locale: 'ko', layer: 'marketing',
    businessDate: history.at(-1), slots: [], catalog: [], snapshot: [], searches: [] };
  async function chat(turn, actionSlots) {
    const response = await request(root + '/navis/chat', actionSlots ? { turn, actionSlots } : turn,
      { 'x-navis-protocol': 'agent-v1' });
    assert.equal(response.status, 200, 'Navis SSE response');
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    return Object.fromEntries((await response.text()).split('\n\n').flatMap(frame => {
      const match = /^event:\s*([^\n]+)\ndata:\s*(.*)$/.exec(frame);
      return match ? [[match[1], JSON.parse(match[2])]] : [];
    }));
  }

  const actionSlots = { menuIds: ['financier'], photoIds: ['fin-01', 'fin-02', 'fin-03', 'fin-04', 'fin-05'],
    moods: ['warm'], concepts: ['new-item'], memo: '' };
  const args = { referenceId: 'ref-1', lengthSec: 10, locale: 'ko',
    ...Object.fromEntries(Object.keys(actionSlots).map(key => [key, { slot: key }])) };
  const turn = await chat({ ...base, slots: Object.keys(actionSlots),
    intent: { kind: 'command', command: 'video.make', args } }, actionSlots);
  assert.equal(turn.done?.outcome, 'proposal');
  const proposal = turn.action_proposal;
  assert.ok(proposal?.proposalId);
  const talk = await chat({ ...base, runId: randomUUID(),
    intent: { kind: 'conversation', action: 'confirm', pendingId: proposal.proposalId } });
  assert.equal(talk.action_proposal, undefined);
  assert.deepEqual(scopedQuery('marketing', 'marketing', 'runtime', store, 'SELECT 1 FROM marketing.promo_job'), []);
  const confirmPath = root + `/navis/proposals/${proposal.proposalId}/confirm`;
  const card = { source: 'card', runId: base.runId, snapshotRevision: base.snapshotRevision };
  assert.equal((await request(confirmPath, { ...card, source: 'text' })).status, 400);
  assert.equal((await request(confirmPath, { ...card, snapshotRevision: 8 })).status, 409);
  assert.equal((await request(confirmPath.replace(store, otherStore), card, { 'x-navis-store-id': otherStore })).status, 403);

  const { jobId } = await json(confirmPath, 202, card);
  assert.equal((await json(confirmPath, 202, card)).jobId, jobId);
  const jobPath = root + '/promo/jobs/' + jobId;
  const checkpoint = await eventually('durable look checkpoint', () => json(jobPath, 200),
    job => ['story', 'scenes', 'merge'].includes(job.stage) && job.status !== 'done');
  assert.ok(checkpoint.stage);
  compose(['restart', 'marketing-worker']);
  const publishedJob = await eventually('validated promo output after worker restart', () => json(jobPath, 200), job => {
    assert.notEqual(job.status, 'failed', 'fixture promo rendering failed');
    return job.status === 'done';
  }, 45_000);
  assert.ok(publishedJob.assetId);
  assert.equal((await json(jobPath, 200)).assetId, publishedJob.assetId);
  const fullVideo = await request(jobPath + '/video.mp4');
  assert.equal(fullVideo.status, 200);
  const expectedClip = readFileSync(new URL('../../../frontend/server/promo/references/ref-1/preview.mp4', import.meta.url));
  assert.ok(Buffer.from(await fullVideo.arrayBuffer()).equals(expectedClip), 'Authorized video matches the validated clip');
  const video = await request(jobPath + '/video.mp4', undefined, { range: 'bytes=0-31' });
  assert.equal(video.status, 206);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.match(video.headers.get('content-range') ?? '', /^bytes 0-31\/\d+$/);
  assert.equal((await video.arrayBuffer()).byteLength, 32);
  assert.equal((await request(jobPath.replace(store, otherStore) + '/video.mp4')).status, 403);
  const usage = scopedQuery('insight', 'insight', 'runtime', store,
    "SELECT stage, count(*)::int AS attempts, count(input_tokens)::int AS reported FROM insight.ai_usage WHERE feature='promo' GROUP BY stage ORDER BY stage");
  assert.deepEqual(usage.map(row => row.stage), ['look', 'scenes', 'story']);
  assert.ok(usage.every(row => row.attempts === row.reported && row.attempts > 0));
  assert.deepEqual(scopedQuery('insight', 'insight', 'runtime', otherStore, "SELECT 1 FROM insight.ai_usage WHERE feature='promo'"), []);
  console.log('ok 1 - owner-card promo, durable checkpoint, restart, private MP4 range and per-attempt usage');

  const sms = await json(root + '/sens/test-card', 200);
  assert.equal((await request(root + '/sens/attempts', { ...sms, source: 'text' })).status, 400);
  assert.equal((await request(root + '/sens/attempts', { ...sms, input: { ...sms.input, targetId: 'other-target' } })).status, 403);
  const queued = await json(root + '/sens/attempts', 202, sms);
  assert.equal((await json(root + '/sens/attempts', 202, sms)).receiptId, queued.receiptId);
  const receiptPath = root + '/sens/attempts/' + queued.receiptId;
  const uncertain = await eventually('lost fake SENS response', () => json(receiptPath, 200), row => row.state === 'uncertain');
  assert.equal(uncertain.acceptance, null);
  compose(['restart', 'marketing-worker']);
  const accepted = await eventually('reconciled SENS acceptance', () => json(receiptPath, 200), row => row.state === 'accepted');
  assert.equal(accepted.delivery.status, 'pending');
  assert.match(accepted.acceptance.requestId, /^fake-/);
  const delivered = await eventually('separate delivery receipt', () => json(receiptPath, 200), row => row.delivery?.status === 'delivered');
  assert.deepEqual(delivered.acceptance, accepted.acceptance);
  assert.deepEqual(await json(root + '/sens/attempts', 200, sms), delivered);
  assert.equal((await request(receiptPath.replace(store, otherStore))).status, 403);
  assert.deepEqual(scopedQuery('marketing', 'marketing', 'runtime', store, `
    SELECT count(*)::int AS attempts, count(first_send_at)::int AS sends, count(retry_send_at)::int AS retries
    FROM marketing.sens_attempt`), [{ attempts: 1, sends: 1, retries: 0 }]);
  console.log('ok 2 - lost SENS response, reconciliation across process restart, stable repeat and acceptance/delivery');

  const menu = items.find(item => item.name.replaceAll(' ', '') === '카페라떼');
  assert.ok(menu, 'Seed café latte');
  const { menuId, price } = menu;
  const temperature = 'c5a0a175-9513-5b5a-bb92-c98a1609ddef';
  for (const day of history) {
    compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', 'pos'], { ...phase3, NAVIS_POS_FIXTURE_NOW: fixtureNow(day) });
    inside('pos', `
      import assert from 'node:assert/strict';
      import { randomUUID } from 'node:crypto';
      import { readSecret } from './packages/db/index.ts';
      const [store, actor, menuId, price, cancel, temperature] = process.argv.slice(2);
      async function post(path, input, key = randomUUID()) {
        const res = await fetch('http://127.0.0.1:3000/internal/v1/pos/stores/' + store + path, {
          method: 'POST', headers: { authorization: 'Bearer ' + readSecret('/run/secrets/gateway_pos_token'),
            'x-navis-store-id': store, 'x-navis-user-id': actor, 'x-navis-store-role': 'owner',
            'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(input),
        });
        assert.equal(res.status, 200, path);
        return res.json();
      }
      const { value: bill } = await post('/bills', { type: 'takeout', lines: [{ menuId, qty: 2, optionIds: [temperature] }] });
      const key = randomUUID();
      const { value: approval } = await post('/approvals', { billId: bill.billId, quoteRevision: bill.quoteRevision,
        splits: [{ method: 'card', amount: Number(price) * 2 }] }, key);
      const { value: payment } = await post('/approvals/' + approval.attemptId + '/finish',
        { expectedQuoteFingerprint: approval.quoteFingerprint }, key);
      if (cancel === 'true') {
        const quote = await post('/payments/' + payment.paymentId + '/reversal-quote', { kind: 'cancel' });
        assert.equal(quote.stockEffect, 'restore');
        await post('/corrections', { quoteToken: quote.quoteToken, confirmed: true });
      }
      console.log('true');
    `, store, actor, menuId, String(price), String(day === history[1]), temperature);
  }

  function sales() {
    return inside('insight', `
      import assert from 'node:assert/strict';
      import { readSecret } from './packages/db/index.ts';
      const [store, from, to] = process.argv.slice(2);
      const res = await fetch('http://127.0.0.1:3000/internal/v1/insight/stores/' + store + '/sales?from=' + from + '&to=' + to, {
        headers: { authorization: 'Bearer ' + readSecret('/run/secrets/forecast_insight_token'), 'x-navis-store-id': store },
      });
      assert.equal(res.status, 200);
      console.log(JSON.stringify(await res.json()));
    `, store, history[0], history.at(-1));
  }
  const observed = await eventually('Insight projected all four business days and the cancellation', sales,
    result => result.days.length === 4 && Number(result.days.find(i => i.businessDate === history[1])?.netSales) === 0);
  assert.deepEqual(observed.days.map(day => Number(day.netSales)), [2 * price, 0, 2 * price, 2 * price]);
  const read = await chat({ ...base, runId: randomUUID(), layer: 'management', intent: { kind: 'read', sourceId: 'pos' } });
  assert.equal(read.done?.outcome, 'reply');

  const forecast = [1, 2].map(() => JSON.parse(compose(['run', '-T', '--rm', '--no-deps', '--pull', 'never', 'forecast-cron'])));
  assert.deepEqual(forecast[0], forecast[1]);
  assert.equal(forecast[0].status, 'ready');
  const result = await json(root + forecastPath, 200);
  assert.equal(result.status, 'ready');
  const menuForecast = result.results.find(row => row.scope === 'menu');
  assert.equal(menuForecast?.targetId, menuId);
  assert.equal(Number(menuForecast?.expected), 1.5);
  assert.equal(new Set(result.results.map(row => `${row.scope}:${row.targetId}`)).size, result.results.length);
  assert.deepEqual(scopedQuery('inventory', 'inventory', 'runtime', store,
    "SELECT count(*)::int AS count FROM inventory.outbox WHERE event_type='inventory.forecast_generated.v1'"),
  [{ count: result.results.length }]);
  assert.equal((await request((root + forecastPath).replace(store, otherStore))).status, 403);
  console.log('ok 3 - POS history and correction reached Insight, cron repeat retained one forecast and event per key');

  const workerGrants = scopedQuery('marketing-worker', 'marketing', 'worker', '', `
    SELECT current_user AS identity, has_table_privilege('marketing.outbox','SELECT') AS outbox,
      has_column_privilege('marketing.promo_job','dispatched_at','UPDATE') AS dispatch,
      has_database_privilege('insight','CONNECT') AS other_database,
      (SELECT count(*)::int FROM marketing.promo_job) AS unscoped`);
  assert.deepEqual(workerGrants, [{ identity: 'marketing_wrk', outbox: false, dispatch: true, other_database: false, unscoped: 0 }]);
  assert.deepEqual(scopedQuery('relay', 'marketing', 'relay', '',
    `SELECT count(*)::int AS published FROM marketing.outbox WHERE published_at IS NOT NULL`), [{ published: 2 }]);
  console.log('ok 4 - sole edge port, scoped worker and relay grants, and runtime A/B access');
}

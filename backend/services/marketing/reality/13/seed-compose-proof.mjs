// GAP-SEED compose proof. Run in the tools container of an isolated real-plan-local.py project after
// `npm run migrate` and `npm run seed`:  node services/marketing/reality/13/seed-compose-proof.mjs before|after
// It reads the seeded official data as the café owner through api-gateway -> marketing -> PostgreSQL.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dbPool } from '../../../../packages/db/index.ts';
import { provisionOwner } from '../../../account/reality/00/provision.ts';
import { seed } from '../../seed.ts';

const phase = process.argv[2];
assert.ok(phase === 'before' || phase === 'after', 'Usage: seed-compose-proof.mjs before|after');
const official = JSON.parse(readFileSync(new URL('./data/sangdo-official.json', import.meta.url), 'utf8'));
const { snapshot } = official;
const cafe = 'c05409a6-f082-5964-a787-c1ed3184988b';
const origin = process.env.NAVIS_ACCOUNT_TEST_ORIGIN;
const gateway = process.env.GAP_SEED_GATEWAY ?? 'http://api-gateway:3000';
const statePath = process.env.GAP_SEED_STATE ?? '/tmp/gap-seed-state.json';
assert.ok(origin, 'NAVIS_ACCOUNT_TEST_ORIGIN is required');
let accessToken;
let cookie;

function send(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
    const outgoing = httpRequest(gateway + path, { method, headers, signal: AbortSignal.timeout(10_000) }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

async function call(method, path, status, { body, key } = {}) {
  const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin' };
  if (path.startsWith('/api/v1/auth/') && cookie) headers.cookie = cookie;
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await send(method, path, headers, body === undefined ? undefined : JSON.stringify(body));
  const refresh = response.headers['set-cookie']?.find(value => value.startsWith('navis_refresh='));
  if (refresh) cookie = refresh.split(';')[0];
  const text = response.body.toString('utf8');
  assert.equal(response.status, status, `${method} ${path} expected ${status}, got ${response.status}: ${text.slice(0, 300)}`);
  assert.equal(response.headers['cache-control'], 'no-store');
  return text ? JSON.parse(text) : undefined;
}

const marketing = `/api/v1/stores/${cafe}/marketing`;
const range = (from, to) => `from=${from}&to=${to}`;
const log = (label, value) => console.info(`${label} ${JSON.stringify(value)}`);

async function signIn(loginId, password) {
  accessToken = undefined;
  cookie = undefined;
  ({ accessToken } = await call('POST', '/api/v1/auth/login', 200, { body: { loginId, password } }));
  ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
}

async function readTradeArea(quarter, weekday, from, to) {
  return call('GET', `${marketing}/trade-area?${range(from, to)}&quarter=${quarter}&weekday=${weekday}`, 200);
}

async function checkTradeArea() {
  const trade = await readTradeArea('2026-Q4', 2, '2026-11-11', '2026-11-17');
  const expected = snapshot.population.filter(band => band.quarter === '2026-Q4' && band.weekday === 2);
  assert.equal(trade.population.status, 'available');
  assert.equal(trade.population.source, 'seoul-living-population');
  assert.equal(trade.population.items.length, 24);
  for (const [index, band] of trade.population.items.entries()) {
    assert.equal(band.region, snapshot.region);
    assert.equal(band.startHour, expected[index].startHour);
    assert.equal(band.estimate, expected[index].estimate);
    assert.equal(band.referenceDate, '2026-11-17');
    assert.equal(band.sourceUrl, 'https://data.seoul.go.kr/dataList/OA-23016/S/1/datasetView.do');
  }
  log('TRADE 2026-Q4 Tue label=서울 공개 자료 ·', { referenceDate: trade.population.items[0].referenceDate,
    region: trade.population.items[0].region, hour14: trade.population.items[14].estimate, salesStatus: trade.sales.status });
  const summer = await readTradeArea('2026-Q3', 6, '2026-09-24', '2026-09-30');
  assert.equal(summer.population.items.length, 24);
  assert.equal(summer.population.items[0].referenceDate, '2026-09-30');
  const future = await readTradeArea('2027-Q1', 2, '2027-01-05', '2027-01-11');
  assert.equal(future.population.status, 'unavailable');
  assert.deepEqual(future.population.items, []);
  return trade.population.items;
}

async function readChanges(from, to) {
  return call('GET', `${marketing}/local-changes?${range(from, to)}&limit=200`, 200);
}

if (phase === 'before') {
  // A rerun on the same disposable project reuses the owner it provisioned for the café store.
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const loginId = previous.loginId ?? `gap-seed-${randomBytes(6).toString('hex')}@example.invalid`;
  const password = previous.password ?? randomBytes(24).toString('base64url');
  writeFileSync(statePath, JSON.stringify({ loginId, password }));
  const accountMigrator = dbPool('account', 'migrate');
  try {
    await provisionOwner(accountMigrator, { loginId, password, ownerName: 'GAP-SEED proof owner',
      storeId: cafe, storeName: '안숭잘부 카페', businessDayStart: '05:00' });
  } finally { await accountMigrator.end(); }
  await signIn(loginId, password);
  const bands = await checkTradeArea();

  const all = await readChanges('2026-07-01', '2026-11-30');
  assert.deepEqual(all.coverage, { region: snapshot.region, referenceDate: snapshot.coverageDate, kinds: snapshot.kinds });
  assert.equal(all.items.length, snapshot.changes.length);
  assert.equal(all.unreadCount, snapshot.changes.length);
  assert.equal(all.sourceRevision, 1, 'Two seed runs advance the local-changes revision once');
  for (const item of all.items) {
    const source = snapshot.changes.find(change => change.id === item.id);
    assert.ok(source, `Unexpected row ${item.id}`);
    assert.equal(item.title, source.title);
    assert.equal(item.sourceUrl, source.sourceUrl);
    assert.equal(item.dateKind, source.kind === 'food-license' ? 'license-date' : 'event-date');
    assert.equal(item.revision, 1);
  }
  const thisWeek = await readChanges('2026-11-16', '2026-11-22');
  assert.deepEqual(thisWeek.coverage, all.coverage);
  log('LOCAL week 2026-11-16..22', { items: thisWeek.items.length, unreadCount: thisWeek.unreadCount });
  const october = await readChanges('2026-10-19', '2026-10-25');
  log('LOCAL week 2026-10-19..25', october.items.map(item => `${item.referenceDate} ${item.kind} ${item.title}`));
  const target = october.items.find(item => item.title.startsWith('메가엠지씨커피 상도역점'));
  assert.ok(target, 'The 2026-10-22 official license is visible in its week');

  const briefing = await call('GET', `/api/v1/stores/${cafe}/insight/briefings`, 200);
  assert.equal(briefing.sources.local.state, 'ready');
  assert.deepEqual(briefing.sources.local.data.coverage, all.coverage);
  log('BRIEFING local', { businessDay: briefing.businessDay, coverage: briefing.sources.local.data.coverage,
    unreadCount: briefing.sources.local.data.unreadCount });

  const ack = await call('POST', `${marketing}/local-changes/${target.id}/ack`, 200, {
    key: `gap-seed-ack-${target.id}`, body: { expectedRevision: target.revision } });
  assert.equal(ack.resourceId, target.id);
  assert.equal(ack.revision, 2);
  assert.ok(ack.undoUntil);
  const migrator = dbPool('marketing', 'migrate');
  try { await seed(migrator); } finally { await migrator.end(); }
  const reseeded = await readChanges('2026-10-19', '2026-10-25');
  const kept = reseeded.items.find(item => item.id === target.id);
  assert.equal(kept.revision, 2, 'A seed rerun keeps the owner acknowledgement revision');
  assert.ok(kept.acknowledgedAt, 'A seed rerun keeps the owner acknowledgement');
  writeFileSync(statePath, JSON.stringify({ loginId, password, targetId: target.id, bands, ackReceipt: ack.receiptId }));
  console.info('PASS before: owner reads seeded Seoul public data through api-gateway, acknowledges one row, and a seed rerun keeps it');
} else {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  await signIn(state.loginId, state.password);
  const bands = await checkTradeArea();
  assert.deepEqual(bands, state.bands, 'Trade area re-reads the same bands after the marketing restart');
  const all = await readChanges('2026-07-01', '2026-11-30');
  assert.equal(all.items.length, snapshot.changes.length);
  assert.equal(all.unreadCount, snapshot.changes.length - 1);
  const target = all.items.find(item => item.id === state.targetId);
  assert.equal(target.revision, 2);
  assert.ok(target.acknowledgedAt);
  console.info('PASS after: new session after marketing restart re-reads the same official bands, rows and acknowledgement');
}

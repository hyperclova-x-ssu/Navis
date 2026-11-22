// GAP-INS Compose proof. Browser-equivalent requests enter the real gateway code (ES256 owner session, origin,
// membership and operating clock), which forwards over HTTP to the real Insight entrypoint (`services/insight/index.ts`)
// in its container, which reads the private naver-virtual service and its PostgreSQL. FAKE/virtual NAVER only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { createGateway } from '../../../../gateway/app.ts';

const mode = process.argv[2] ?? 'verify';
const out = process.env.GAPINS_OUT ?? '/proof-out';
const storeId = 'c05409a6-f082-5964-a787-c1ed3184988b';
const otherStore = 'aa000000-0000-4000-8000-0000000000aa';
const actorId = 'bb000000-0000-4000-8000-0000000000bb';
const host = 'gapins.invalid';
const insightOrigin = 'http://insight:3000';
const adsRecord = 'cmp-a001-01-000000000000001';
const secret = name => readFileSync('/run/secrets/' + name, 'utf8').trim();
const log = [];
const note = line => { log.push(line); console.log(line); };

async function ready(url) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (await fetch(url, { signal: AbortSignal.timeout(1_000) }).then(r => r.ok, () => false)) return;
    await pause(1_000);
  }
  throw new Error('Not ready: ' + url);
}

async function gatewayFor() {
  const keys = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...await exportJWK(keys.publicKey), alg: 'ES256', use: 'sig', kid: 'gapins-proof' }] };
  const upstream = [];
  const fetcher = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'account') {
      if (url.pathname === '/internal/v1/auth/jwks') return Response.json(jwks);
      if (url.pathname === '/internal/v1/auth/authorize') return new Response(null, { status: 204 });
      if (/^\/internal\/v1\/account\/stores\/[^/]+\/operating-clock$/.test(url.pathname)) {
        return Response.json({ timezone: 'Asia/Seoul', businessDayStart: '05:00' });
      }
    }
    if (url.origin === insightOrigin) {
      upstream.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      return fetch(url, init);
    }
    throw new Error('Unexpected upstream ' + url.origin);
  };
  const gateway = createGateway({
    accountUrl: 'http://account:3000', accountToken: 'gapins-account-workload',
    inventoryUrl: 'http://inventory:3000', inventoryToken: 'gapins-inventory-workload',
    insightRecords: { url: insightOrigin, token: secret('gateway_insight_token') },
    accountOrigin: 'http://' + host, fetcher, logging: false,
  });
  const session = (store = storeId, role = 'owner') => new SignJWT({ sid: randomUUID(), store_id: store, role })
    .setProtectedHeader({ alg: 'ES256', kid: 'gapins-proof' }).setSubject(actorId).setIssuer('navis-account')
    .setAudience('navis-api').setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
  const call = async (token, suffix, { method = 'GET', store = storeId } = {}) => {
    const response = await gateway.inject({ method, url: `/api/v1/stores/${store}/insight${suffix}`,
      headers: { host, origin: 'http://' + host, ...(token && { authorization: `Bearer ${token}` }) } });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null,
      requestId: response.headers['x-request-id'] ?? null, cache: response.headers['cache-control'] ?? null };
  };
  return { gateway, session, call, upstream };
}

async function reads(call, token) {
  const ok = async suffix => {
    const response = await call(token, suffix);
    assert.equal(response.status, 200, suffix + ' ' + JSON.stringify(response.body));
    assert.equal(response.cache, 'no-store', 'protected reads are not cached');
    note(`200 GET /api/v1/stores/${storeId}/insight${suffix} request=${response.requestId}`);
    return response.body;
  };
  const list = await ok('/financial-center/recommendations');
  const detail = await ok('/financial-center/recommendations/' + list.items[0].ref);
  return {
    list, detail,
    reviews: await ok('/review-insights'),
    reviewsMonth: await ok('/review-insights?unit=month'),
    ads: await ok('/channel-reports/search-ads'),
    adsWeek: await ok('/channel-reports/search-ads?date=2026-11-16&unit=week'),
    briefing: await ok('/briefings'),
  };
}

async function personaDb(run) {
  const pool = new pg.Pool({ host: process.env.NAVIS_DB_HOST ?? 'test-db', database: 'naver_virtual', user: 'nvirtual_mig',
    password: secret('nvirtual_mig_password'), max: 1,
    // Persona tables use account-scoped RLS; read the café's rows as the provider does.
    options: '-c app.persona_account_id=ansungjalbu-cafe' });
  try { return await run(pool); } finally { await pool.end(); }
}

async function verify() {
  await ready(insightOrigin + '/readyz');
  const { call, session, upstream } = await gatewayFor();
  const writesBefore = await personaDb(pool => pool.query('SELECT count(*)::int AS n FROM naver_virtual.effect_journal'));
  const first = await reads(call, await session());

  // Financial Center: read-only list/detail with source label, values equal the persona DB rows.
  const db = await personaDb(async pool => ({
    recommendations: (await pool.query(`SELECT ref, projection FROM naver_virtual.pn09_recommendation
      WHERE account_id = 'ansungjalbu-cafe' ORDER BY ref`)).rows,
    adsDay: (await pool.query(`SELECT sum(impressions)::int AS impressions, sum(clicks)::int AS clicks, sum(cost)::int AS cost
      FROM naver_virtual.pn12_ads WHERE account_id = 'ansungjalbu-cafe' AND ad_id = $1 AND day = '2026-11-16'`, [adsRecord])).rows[0],
    adsWeek: (await pool.query(`SELECT sum(impressions)::int AS impressions, sum(clicks)::int AS clicks, sum(cost)::int AS cost,
      count(*)::int AS days FROM naver_virtual.pn12_ads
      WHERE account_id = 'ansungjalbu-cafe' AND ad_id = $1 AND day BETWEEN '2026-11-10' AND '2026-11-16'`, [adsRecord])).rows[0],
    raters: (await pool.query(`SELECT count(DISTINCT reviewer_ref)::int AS n FROM naver_virtual.pn03_reviews
      WHERE account_id = 'ansungjalbu-cafe' AND scope = 'venue' AND visible AND stars IS NOT NULL`)).rows[0].n,
    showAverage: (await pool.query(`SELECT show_venue_average FROM naver_virtual.pn03_settings
      WHERE account_id = 'ansungjalbu-cafe'`)).rows[0]?.show_venue_average ?? null,
  }));
  assert.equal(first.list.state, 'ready');
  assert.equal(first.list.source, 'naver-financial-center');
  assert.deepEqual(first.list.items.map(item => item.ref), db.recommendations.map(row => row.ref));
  assert.equal(first.list.items[0].title, db.recommendations[0].projection.title);
  assert.equal(first.list.items[0].officialNoticeUrl, db.recommendations[0].projection.officialNoticeUrl);
  for (const key of ['overview', 'eligibility', 'applicationMethod']) assert.equal(first.detail[key], db.recommendations[0].projection[key]);
  assert.deepEqual(Object.keys(first.detail).sort(), ['applicationMethod', 'asOf', 'documents', 'eligibility', 'endDate',
    'officialNoticeUrl', 'overview', 'ref', 'source', 'sourceUrl', 'startDate', 'status', 'title'].sort());
  note(`financial-center ref=${first.list.items[0].ref} status=${first.list.items[0].status ?? '-'} rev=${first.list.sourceRevision} (persona DB rows=${db.recommendations.length})`);

  // Review AI statistics: provider coverage two days behind the business day; official average only at >= 10 raters.
  const stats = first.reviews.statistics;
  assert.equal(first.reviews.businessDate, '2026-11-17');
  assert.equal(stats.state, 'ready');
  assert.deepEqual(stats.coverage, { requestedTo: '2026-11-17', dataThrough: '2026-11-15', lagDays: 2 });
  assert.equal(stats.period.unit, 'week');
  assert.equal(first.reviewsMonth.statistics.period.from, '2026-11-01');
  const shown = db.showAverage === true && db.raters >= 10;
  assert.equal(first.reviews.averageRating.state, shown ? 'shown' : 'hidden');
  assert.equal(first.reviews.averageRating.minimumReviewers, 10);
  note(`review-insights week ${stats.period.from}..${stats.period.to} lag=${stats.coverage.lagDays} themes=${stats.themes.length} ` +
    `average=${first.reviews.averageRating.state}:${first.reviews.averageRating.value} (DB raters=${db.raters} display=${db.showAverage})`);

  // Dependent surface: the B12 briefing reads the same PN03 statistics for the same business day.
  const briefingStats = first.briefing.sources.reviewStatistics;
  assert.equal(briefingStats.state, 'ready');
  assert.deepEqual(briefingStats.period, { from: stats.period.from, to: stats.period.to });
  assert.deepEqual(briefingStats.data.themes, stats.themes);
  assert.deepEqual(briefingStats.data.topKeywords, stats.topKeywords);
  note(`briefing reviewStatistics period ${briefingStats.period.from}..${briefingStats.period.to} matches review-insights`);

  // Search Ads: impressions, clicks and cost for the linked record and the requested period, equal to the DB rows.
  const [day] = first.ads.items;
  assert.equal(day.channel, 'search-ads');
  assert.equal(day.state, 'ready');
  assert.deepEqual(day.period, { startDate: '2026-11-16', endDate: '2026-11-16' });
  assert.deepEqual(day.cards, [{ metric: 'impressions', value: db.adsDay.impressions },
    { metric: 'clicks', value: db.adsDay.clicks }, { metric: 'cost', value: db.adsDay.cost }]);
  const [week] = first.adsWeek.items;
  assert.equal(db.adsWeek.days, 7);
  assert.deepEqual(week.period, { startDate: '2026-11-10', endDate: '2026-11-16' });
  assert.deepEqual(week.cards.map(card => card.value), [db.adsWeek.impressions, db.adsWeek.clicks, db.adsWeek.cost]);
  note(`search-ads day=${JSON.stringify(day.cards)} week=${JSON.stringify(week.cards)}`);

  // Authorization and read-only surface through the edge.
  assert.equal((await call(null, '/review-insights')).status, 401);
  assert.equal((await call(await session(storeId, 'staff'), '/review-insights')).status, 403);
  for (const suffix of ['/financial-center/recommendations', '/review-insights', '/channel-reports/search-ads']) {
    assert.equal((await call(await session(), suffix, { method: 'POST' })).status, 404, 'no write route ' + suffix);
  }
  const other = await call(await session(otherStore), '/review-insights', { store: otherStore });
  assert.equal(other.status, 200);
  assert.equal(other.body.state, 'not-connected');
  note('401 unauthenticated, 403 staff, 404 POST, other store not-connected');

  // A new session re-reads the same records.
  const second = await reads(call, await session());
  assert.deepEqual(second, first);
  const writesAfter = await personaDb(pool => pool.query('SELECT count(*)::int AS n FROM naver_virtual.effect_journal'));
  assert.equal(writesAfter.rows[0].n, writesBefore.rows[0].n, 'no provider writes');
  note(`new session re-read equal; persona effect_journal ${writesBefore.rows[0].n} -> ${writesAfter.rows[0].n} (0 writes)`);
  note(`gateway -> insight upstream calls: ${upstream.length}`);
  writeFileSync(out + '/gapins-proof-snapshot.json', JSON.stringify(first, null, 2));
  writeFileSync(out + '/gapins-proof-verify.log', log.join('\n') + '\n');
  console.log('GAP-INS Compose proof passed');
}

async function reread() {
  await ready(insightOrigin + '/readyz');
  const { call, session } = await gatewayFor();
  const saved = JSON.parse(readFileSync(out + '/gapins-proof-snapshot.json', 'utf8'));
  const again = await reads(call, await session());
  assert.deepEqual(again, saved);
  note('after naver-virtual and insight restart, a new session re-read equals the saved snapshot');
  writeFileSync(out + '/gapins-proof-reread.log', log.join('\n') + '\n');
  console.log('GAP-INS Compose re-read passed');
}

if (mode === 'verify') await verify();
else if (mode === 'reread') await reread();
else throw new Error('Use verify or reread');

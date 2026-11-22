import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import { demoIdentity, newPassword } from '../../services/account/identity.ts';
import { provisionOwner } from '../../services/account/reality/00/provision.ts';
import { inStore as withAccountStore } from '../../services/account/transaction.ts';
import { withStoreTransaction as withPosStore } from '../../services/pos/transaction.ts';
import { verifyNaverCards, verifyNaverInventory, verifyNaverPos } from './real-plan-gap.mjs';
import { verifyNoticeSms } from './real-plan-notice-sms.mjs';

const origin = process.env.NAVIS_ACCOUNT_TEST_ORIGIN ?? 'http://127.0.0.1:18180';
const edge = process.env.NAVIS_ACCOUNT_TEST_EDGE ?? origin;
const password = randomBytes(24).toString('base64url');
const loginId = `${randomUUID()}@example.invalid`;
const first = randomUUID();
const second = randomUUID();
const outsider = randomUUID();
const outsiderLogin = `${randomUUID()}@example.invalid`;
const db = dbPool('account', 'migrate');
const pool = dbPool('account');
let cookie;
let accessToken;
function send(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
    const outgoing = httpRequest(url, { method, headers, signal: AbortSignal.timeout(8000) }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
async function call(method, path, status, { body, bytes, key, range, raw = false } = {}) {
  const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin' };
  if (path.startsWith('/api/v1/auth/') && cookie) headers.cookie = cookie;
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (key) headers['idempotency-key'] = key;
  if (range) headers.range = range;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bytes) headers['content-type'] = 'image/png';
  const response = await send(edge + path, method, headers, bytes ?? (body === undefined ? undefined : JSON.stringify(body)));
  let reason = '';
  if (response.status !== status && response.status >= 400 && response.headers['content-type']?.startsWith('application/json')) {
    const error = JSON.parse(response.body);
    reason = ` (${error.reason ?? error.code ?? 'HTTP error'})`;
  }
  assert.equal(response.status, status, `${method} ${path} expected ${status}${reason}`);
  assert.equal(response.headers['cache-control'], 'no-store');
  const setCookie = response.headers['set-cookie']?.find(value => value.startsWith('navis_refresh='));
  if (setCookie) cookie = setCookie.split(';')[0];
  if (raw) return response;
  if (status === 204) return;
  return response.headers['content-type']?.startsWith('image/') ? response.body : JSON.parse(response.body);
}
const store = id => `/api/v1/stores/${id}`;
const board = id => `${store(id)}/boards/management`;
async function waitForStock(path, expectedBase) {
  const deadline = Date.now() + 15_000;
  let stock;
  while (Date.now() < deadline) {
    stock = (await call('GET', path, 200)).stock;
    if (stock.rawQuantityBase === expectedBase) return;
    await delay(200);
  }
  assert.equal(stock?.rawQuantityBase, expectedBase, 'Standalone worker must apply the relayed POS event');
}
async function verifyAccount() {
  const gateSeed = process.argv.includes('--gate-seed');
  const noticePhase = process.env.NOTICE_SMS_PROOF_STATE && process.argv.includes('--notice-sms') ? process.argv.at(-1) : undefined;
  if (process.argv.includes('--replay-demo') || gateSeed || noticePhase) {
    assert.notEqual(new URL(origin).port, '18180');
    async function demoSession() {
      ({ accessToken } = await call('POST', '/api/v1/auth/demo', 200));
      assert.ok(cookie, 'Alternate-port demo issues the same refresh cookie');
      assert.ok((await call('GET', '/api/v1/stores', 200)).items.some(store => store.storeId === demoIdentity.storeId));
    }
    async function endDemoSession() {
      await call('POST', '/api/v1/auth/logout', 204);
      cookie = undefined;
      accessToken = undefined;
    }
    await demoSession();
    ({ accessToken } = await call('POST', '/api/v1/auth/refresh', 200));
    const cafeRoot = store(demoIdentity.storeId);
    assert.ok((await call('GET', cafeRoot + '/profile', 200)).businessType);
    if (gateSeed) {
      const peerId = '33123a19-6780-4d38-9bca-ce96efcf8559';
      async function readGateFixtures() {
        const peers = await call('GET', cafeRoot + '/marketing/offers/peers', 200);
        assert.equal(peers.status, 'available');
        const peer = peers.items.find(row => row.storeId === peerId);
        assert.ok(peer, 'The seeded comparison store must be available for a community proposal');
        const offers = await call('GET', cafeRoot + '/marketing/offers', 200);
        const offer = offers.items.find(row => row.senderStoreId === peerId && row.recipientStoreId === demoIdentity.storeId
          && row.status === 'pending' && row.canRespond);
        assert.ok(offer, 'The seeded cafe owner must have a received community proposal awaiting response');
        const bookings = await call('GET', cafeRoot + '/reservations?source=naver&status=confirmed', 200);
        const booking = bookings.items.find(row => row.sourceMetadata?.npayLinked && row.sourceMetadata.paymentAmount === 4500);
        assert.ok(booking?.actions.cancel && booking.actions.cancelRequiresRefund, 'The seeded Npay booking must support cancellation with a refund');
        const detail = await call('GET', cafeRoot + '/reservations/' + booking.reservationId, 200);
        assert.equal(detail.sourceMetadata.paymentAmount, 4500);
        return { peer, offer, detail };
      }
      const fixtures = await readGateFixtures();
      await endDemoSession();
      await demoSession();
      assert.deepEqual(await readGateFixtures(), fixtures);
      console.info('PASS reviewer pair, reply-ready community proposal, and confirmed Npay 4500 booking persist in a new cafe owner session');
    }
    if (noticePhase) await verifyNoticeSms(call, cafeRoot, noticePhase);
    await endDemoSession();
    console.info('PASS alternate disposable loopback port issues, refreshes and revokes a café owner session through the gateway');
    if (noticePhase) return;
  }
  const owner = { loginId, password, ownerName: 'Synthetic owner' };
  for (const [storeId, storeName] of [[first, 'First location'], [second, 'Second location']]) {
    await provisionOwner(db, { ...owner, storeId, storeName, businessDayStart: '04:30' });
  }
  await provisionOwner(db, {
    loginId: outsiderLogin, password, ownerName: 'Another owner', storeId: outsider, storeName: 'Private location',
  });
  const login = () => call('POST', '/api/v1/auth/login', 200, { body: { loginId, password } });
  assert.equal((await call('POST', '/api/v1/auth/login', 401, { body: { loginId, password: randomUUID() } })).reason, 'BAD_CREDENTIALS');
  ({ accessToken } = await login());
  const { items } = await call('GET', '/api/v1/stores', 200);
  assert.deepEqual(items.map(item => item.storeId).sort(), [first, second].sort());
  await call('POST', '/api/v1/auth/store', 403, { body: { storeId: outsider } });
  ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
  await call('GET', `${store(first)}/boards`, 403);
  const profile = await call('GET', `${store(second)}/profile`, 200);
  const change = { businessType: 'restaurant', paymentStyle: 'postpaid', onboardingDone: true, expectedRevision: profile.revision };
  const saved = await call('PATCH', `${store(second)}/profile`, 200, { key: 'profile-change', body: change });
  assert.deepEqual(await call('PATCH', `${store(second)}/profile`, 200, { key: 'profile-change', body: change }), saved);
  assert.equal((await call('PATCH', `${store(second)}/profile`, 409, { key: 'stale-profile', body: change })).reason, 'STALE_REVISION');
  const prefs = await call('GET', `${store(second)}/preferences`, 200);
  await call('PATCH', `${store(second)}/preferences`, 200, { key: 'theme-change', body: { theme: 'dark', expectedRevision: prefs.revision } });
  const arrangement = { currentPage: 0, pages: [{ pageId: 'page-1', panels: [{ featureId: 'menu', column: 0, row: 0, width: 2, height: 2 }] }] };
  const emptyBoard = (await call('GET', `${store(second)}/boards`, 200)).items.find(item => item.boardId === 'management');
  const layoutRequest = { key: 'board-change', body: { ...arrangement, expectedRevision: emptyBoard.revision } };
  await call('PUT', board(second), 400, { key: 'duplicate-widget', body: {
    ...layoutRequest.body, pages: [...arrangement.pages, { pageId: 'page-2', panels: arrangement.pages[0].panels }],
  } });
  await call('PUT', board(second), 400, { key: 'wrong-board', body: {
    ...layoutRequest.body, pages: [{ pageId: 'page-1', panels: [{ ...arrangement.pages[0].panels[0], featureId: 'promo-video' }] }],
  } });
  const [firstWrite, retry] = await Promise.all([
    call('PUT', board(second), 200, layoutRequest), call('PUT', board(second), 200, layoutRequest),
  ]);
  assert.deepEqual(firstWrite, retry);
  assert.equal((await call('PUT', board(second), 409, { ...layoutRequest, body: {
    ...layoutRequest.body, pages: [{ pageId: 'other-page', panels: [] }],
  } })).reason, 'IDEMPOTENCY_CONFLICT');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ncYQAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(image).digest('hex');
  const metadata = { purpose: 'menu-photo', contentType: 'image/png', size: image.length, sha256 };
  const { fileId } = await call('POST', `${store(second)}/files`, 200, { key: `file:menu-photo:${sha256}`, body: metadata });
  const file = `${store(second)}/files/${fileId}`;
  await call('POST', `${file}/complete`, 409, { body: {} });
  const altered = Buffer.from(image);
  altered[altered.length - 1] ^= 1;
  await call('PUT', `${file}/content`, 400, { bytes: altered });
  await call('PUT', `${file}/content`, 204, { bytes: image });
  await call('POST', `${file}/complete`, 200, { body: {} });
  if (process.argv.includes('--pos-preflight')) {
    const root = store(second);
    const pos = root + '/pos';
    const { businessDate } = await call('GET', root + '/inventory/items', 200);
    const tomorrow = new Date(Date.parse(businessDate) + 86_400_000).toISOString().slice(0, 10);
    const member = await call('POST', root + '/customers', 200, { key: 'pos-preflight-member',
      body: { name: '박사전', phone: '01000000818' } });
    const template = await call('POST', pos + '/custom-templates', 200, { key: 'pos-preflight-template',
      body: { name: '확인 주문서', fields: [{ fieldId: 'note', label: '문구', input: 'text', required: true, options: [] }] } });
    const orderPath = pos + '/custom-orders';
    const payload = { templateId: template.templateId, expectedRevision: template.revision, answers: { note: '축하합니다' },
      productLabel: '사전 확인 케이크', channel: 'phone', quantity: 1, desiredPickupAt: `${tomorrow}T17:00`, memberId: member.resourceId };
    await call('POST', orderPath, 404, { key: 'pos-preflight-reject-menu-photo', body: { ...payload, referencePhotoKeys: [fileId] } });
    const { fileId: referenceId } = await call('POST', root + '/files', 200, { key: 'pos-preflight-custom-photo',
      body: { ...metadata, purpose: 'custom-reference-photo' } });
    const reference = `${root}/files/${referenceId}`;
    await call('PUT', `${reference}/content`, 204, { bytes: image });
    await call('POST', `${reference}/complete`, 200, { body: {} });
    const request = { key: 'pos-preflight-create', body: { ...payload, referencePhotoKeys: [referenceId] } };
    const order = await call('POST', orderPath, 200, request);
    assert.deepEqual(await call('POST', orderPath, 200, request), order);
    const readback = await call('GET', `${orderPath}/${order.customOrderId}`, 200);
    assert.equal(readback.memberId, member.resourceId);
    assert.deepEqual(readback.referencePhotoKeys, [referenceId]);
    console.info('PASS production POS custom order preflight verifies Customer member and Account reference, with stable retry');
  }
  if (process.argv.includes('--tax')) {
    const pos = `${store(second)}/pos`;
    const dueOn = '2026-12-10';
    const payment = await call('POST', pos + '/tax-payments', 200, {
      key: 'tax-owner-record', body: { taxType: '원천세', amount: 183_000, dueOn },
    });
    const paymentPath = pos + `/tax-payments/${payment.resourceId}`;
    await call('POST', paymentPath + '/evidence', 404, { key: 'deny-menu-as-tax', body: {
      fileId, expectedRevision: payment.revision,
    } });
    const { fileId: evidence } = await call('POST', `${store(second)}/files`, 200, {
      key: 'tax-own-evidence', body: { ...metadata, purpose: 'tax-evidence' },
    });
    const evidencePath = `${store(second)}/files/${evidence}`;
    await call('PUT', evidencePath + '/content', 204, { bytes: image });
    await call('POST', evidencePath + '/complete', 200, { body: {} });
    const attached = await call('POST', paymentPath + '/evidence', 200, { key: 'tax-verified-attachment', body: {
      fileId: evidence, expectedRevision: payment.revision,
    } });
    const projections = `${store(second)}/calendar/projections?startDate=${dueOn}&endDate=${dueOn}`;
    let visible = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      visible = (await call('GET', projections, 200)).items.some(row => row.source === 'tax-due' && row.sourceId === payment.resourceId);
      if (visible) break;
      await delay(250);
    }
    assert.ok(visible);
    await call('POST', paymentPath + '/paid', 200, { key: 'tax-owner-recorded-paid', body: { expectedRevision: attached.revision } });
    ({ accessToken } = await login());
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
    const paid = await call('GET', paymentPath, 200);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.evidenceFiles[0].fileId, evidence);
    console.info('PASS tax deadline projects to Calendar and the paid record re-reads with verified Account evidence');
  }
  if (process.argv.includes('--marketing-local')) {
    const [left, right] = JSON.parse(process.env.NAVIS_MARKETING_TEST_STORES);
    const secondOwner = `${randomUUID()}@example.invalid`;
    await provisionOwner(db, { ...owner, storeId: left, storeName: '검증 가게 A' });
    await provisionOwner(db, { ...owner, loginId: secondOwner, storeId: right, storeName: '검증 가게 B' });
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: left } }));
    const marketing = id => `${store(id)}/marketing`;
    const briefings = `${store(left)}/insight/briefings`;
    const { businessDay: day, sources } = await call('GET', briefings, 200);
    assert.equal(sources.local.state, 'ready');
    assert.equal(sources.local.data.unreadCount, 0);
    const local = await call('POST', marketing(left) + '/local-changes', 200, {
      key: 'record-local-change', body: { title: '동네 휴무 안내', region: '서울', referenceDate: day },
    });
    assert.equal((await call('GET', briefings, 200)).sources.local.data.unreadCount, 1);
    await call('POST', marketing(left) + `/local-changes/${local.resourceId}/ack`, 200, {
      key: 'ack-local-change', body: { expectedRevision: local.revision },
    });
    assert.equal((await call('GET', briefings, 200)).sources.local.data.unreadCount, 0);
    const peerPath = marketing(left) + '/offers/peers';
    assert.deepEqual((await call('GET', peerPath, 200)).items, [{ storeId: right, displayName: '검증 가게 B' }]);
    const offerInput = { title: '이웃 행사 협업', terms: '행사 협업을 제안합니다.', startsOn: day, endsOn: day, respondBy: day };
    await call('POST', marketing(left) + '/offers', 403, { key: 'deny-unapproved-offer',
      body: { ...offerInput, recipientStoreId: outsider } });
    const offer = await call('POST', marketing(left) + '/offers', 200, {
      key: 'create-approved-offer', body: { ...offerInput, recipientStoreId: right },
    });
    ({ accessToken } = await call('POST', '/api/v1/auth/login', 200, { body: { loginId: secondOwner, password } }));
    const inbox = marketing(right) + '/offers';
    assert.equal((await call('GET', inbox, 200)).items[0].id, offer.resourceId);
    await call('POST', inbox + `/${offer.resourceId}/accept`, 200, {
      key: 'accept-community-offer', body: { expectedRevision: offer.revision },
    });
    const projections = `${store(right)}/calendar/projections?startDate=${day}&endDate=${day}`;
    let visible = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      visible = (await call('GET', projections, 200)).items.some(row => row.source === 'community-offer' && row.sourceId === offer.resourceId);
      if (visible) break;
      await delay(250);
    }
    assert.ok(visible, 'The accepted community offer did not project in Calendar');
    ({ accessToken } = await call('POST', '/api/v1/auth/login', 200, { body: { loginId: outsiderLogin, password } }));
    assert.deepEqual((await call('GET', marketing(outsider) + '/offers', 200)).items, []);
    await call('GET', inbox, 403);
    ({ accessToken } = await login());
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: left } }));
    assert.equal((await call('GET', marketing(left) + '/offers', 200)).items[0].status, 'accepted');
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
    console.info('PASS B13 approved independent owners re-read their accepted bilateral offer, the outsider sees no offer, and B12 reads the weekly unread count');
  }
  if (process.argv.includes('--marketing-cards')) {
    const root = `${store(second)}/marketing`;
    const notice = await call('POST', root + '/notices', 200, {
      key: 'notice-for-card', body: { title: '오늘 안내', text: '오늘은 정상 영업합니다.', channel: 'manual' },
    });
    const approvals = root + '/notice-reply-approvals';
    const draft = root + `/notices/${notice.resourceId}/draft`;
    const card = { approvalId: randomUUID(), operation: 'notice.deleteDraft', resourceId: notice.resourceId,
      command: { expectedRevision: notice.revision } };
    const action = { ...card.command, approvalId: card.approvalId };
    await call('DELETE', draft, 403, { key: 'unissued-delete', body: action });
    const press = await call('POST', approvals, 200, { body: { ...card, stage: 'press' } });
    assert.equal(press.requiresConfirmation, true);
    assert.deepEqual(await call('POST', approvals, 200, { body: { ...card, stage: 'press' } }), press);
    await call('DELETE', draft, 403, { key: 'single-step-delete', body: action });
    await call('POST', approvals, 404, { body: { ...card, approvalId: randomUUID(), stage: 'confirm' } });
    const ready = await call('POST', approvals, 200, { body: { ...card, stage: 'confirm' } });
    assert.equal(ready.expiresAt, press.expiresAt);
    assert.equal(ready.requiresConfirmation, false);
    const request = { key: 'authorized-delete', body: action };
    const deleted = await call('DELETE', draft, 200, request);
    assert.deepEqual(await call('DELETE', draft, 200, request), deleted);
    await call('DELETE', draft, 404, { ...request, key: 'new-delete-attempt' });
    const undone = await call('POST', root + `/notice-reply-receipts/${deleted.receiptId}/undo`, 200, {
      key: 'undo-confirmed-delete', body: {},
    });
    assert.equal(undone.resourceId, notice.resourceId);
    console.info('PASS B15 rejects unissued and first-step-only destructive cards, keeps receipt replay durable, and restores through scoped undo');
  }
  if (process.argv.includes('--booking')) {
    const pos = `${store(second)}/pos`;
    const tables = `http://pos:3000/internal/v1/pos/stores/${second}/booking-tables`;
    const workload = readSecret('/run/secrets/customer_pos_token');
    const actor = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url'));
    const readTables = (role = 'owner', token = workload, scope = second) => fetch(tables, { headers: {
      authorization: `Bearer ${token}`, 'x-navis-store-role': role, 'x-navis-store-id': scope, 'x-navis-user-id': actor.sub,
    } });
    assert.equal((await readTables('staff')).status, 403);
    assert.equal((await readTables('owner', randomUUID())).status, 401);
    assert.equal((await readTables('owner', workload, first)).status, 403);
    assert.deepEqual(await (await readTables()).json(), { enabled: false, tables: [] });
    const createTable = (label, layoutTableId, seats) => call('POST', pos + '/tables', 200, {
      key: `booking-${layoutTableId}`, body: { label, layoutTableId, seats },
    });
    const mapped = await createTable('예약 2번', 'T2', 4);
    const named = await createTable('특별 예약석', 'custom-a', 6);
    const archived = await createTable('보관', 'T3', 2);
    await call('DELETE', `${pos}/tables/${archived.resourceId}`, 200, {
      key: 'archive-booking-table', body: { expectedRevision: archived.revision, confirmed: true },
    });
    const projection = await (await readTables()).json();
    assert.equal(projection.enabled, true);
    assert.deepEqual(new Map(projection.tables.map(({ tableId, ...table }) => [tableId, table])), new Map([
      [mapped.resourceId, { number: 2, label: '예약 2번', seats: 4, layoutTableId: 'T2' }],
      [named.resourceId, { number: null, label: '특별 예약석', seats: 6, layoutTableId: 'custom-a' }],
    ]));
    await call('GET', pos + '/booking-tables', 404);
    await call('GET', `${store(second)}/reservations?source=local`, 200);
    console.info('PASS authenticated Customer POS table read preserves layout mappings, excludes archived rows and stays private');
  }
  if (process.argv.includes('--booking-persona')) {
    const cafe = process.env.NAVIS_BOOKING_TEST_CAFE;
    assert.ok(cafe);
    const root = store(cafe);
    const booking = root + '/reservations/naver-booking-01';
    await call('GET', booking, 403);
    if (process.argv.includes('--gap-insight')) {
      const reads = '/insight/financial-center/recommendations';
      assert.equal((await call('GET', store(second) + reads, 200)).state, 'not-connected');
      await call('GET', root + reads, 403);
    }
    if (process.argv.some(arg => ['--gap-inventory', '--gap-seed', '--gap-approved-cards'].includes(arg))) {
      await withAccountStore(db, cafe, client => client.query(`
        INSERT INTO account.store_member (store_id, user_id, role, created_at, updated_at)
        SELECT $1, user_id, 'owner', now(), now() FROM account.credential WHERE login_id=$2`, [cafe, loginId]));
      if (process.env.GAP_SEED_STATE) await writeFile(process.env.GAP_SEED_STATE,
        JSON.stringify({ loginId, password }), { mode: 0o600 });
    } else {
      await provisionOwner(db, { ...owner, storeId: cafe, storeName: '예약 검증 카페' });
    }
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
    const newCafeSession = async () => {
      cookie = undefined;
      ({ accessToken } = await login());
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
    };
    if (process.argv.includes('--gap-pos')) await verifyNaverPos(call, root, newCafeSession);
    if (process.argv.includes('--gap-approved-cards')) {
      assert.deepEqual((await call('GET', root + '/marketing/community/cafe-boards', 200)).items, []);
      const loginId = `card-owner-${randomUUID()}@example.invalid`;
      const { salt, hash } = await newPassword(password);
      await withAccountStore(db, cafe, client => client.query(`
        INSERT INTO account.credential (login_id, user_id, salt, password_hash) VALUES ($1,$2,$3,$4)`,
      [loginId, demoIdentity.userId, salt, hash]));
      async function cardOwner() {
        cookie = undefined;
        ({ accessToken } = await call('POST', '/api/v1/auth/login', 200, { body: { loginId, password } }));
        ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
      }
      await cardOwner();
      await verifyNaverCards(call, root, cardOwner);
      await newCafeSession();
    }
    if (process.argv.includes('--gap-inventory')) await verifyNaverInventory(call, root, newCafeSession);
    if (process.argv.includes('--gap-insight')) {
      const recommendations = root + '/insight/financial-center/recommendations';
      const reviews = root + '/insight/review-insights';
      const ads = root + '/insight/channel-reports/search-ads?date=2026-11-16';
      const list = await call('GET', recommendations, 200);
      assert.equal(list.state, 'ready');
      assert.equal(list.source, 'naver-financial-center');
      assert.ok(list.items.length);
      const detailPath = recommendations + '/' + encodeURIComponent(list.items[0].ref);
      const detail = await call('GET', detailPath, 200);
      assert.equal(detail.officialNoticeUrl, list.items[0].officialNoticeUrl);
      const reviewData = await call('GET', reviews, 200);
      assert.equal(reviewData.statistics.state, 'ready');
      assert.equal(reviewData.statistics.coverage.lagDays, 2);
      assert.equal(reviewData.averageRating.minimumReviewers, 10);
      const briefing = await call('GET', root + '/insight/briefings', 200);
      assert.deepEqual(briefing.sources.reviewStatistics.data.themes, reviewData.statistics.themes);
      const adData = await call('GET', ads, 200);
      assert.equal(adData.items[0].state, 'ready');
      assert.deepEqual(adData.items[0].cards.map(card => card.metric), ['impressions', 'clicks', 'cost']);
      await call('POST', recommendations, 404, { body: {} });
      cookie = undefined;
      ({ accessToken } = await login());
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
      for (const [path, expected] of [[recommendations, list], [detailPath, detail], [reviews, reviewData], [ads, adData]]) {
        assert.deepEqual(await call('GET', path, 200), expected);
      }
      console.info('PASS owner gateway PN03, PN09 and PN12 reads, briefing reconciliation, and identical new-session data');
    }
    if (process.argv.includes('--coupon-provider')) {
      const path = root + '/marketing/naver-coupons';
      const list = await call('GET', path, 200);
      assert.equal(list.source, 'naver');
      assert.equal(list.approvalsEnabled, true);
      assert.ok(Array.isArray(list.placeCoupons.items));
      assert.ok(Array.isArray(list.orderPromotions.items));
      assert.ok(Array.isArray(list.membership.items));
      await call('GET', path + '?placeCursor=invalid', 400);
      const approvalPath = root + '/marketing/naver-coupon-approvals';
      const coupon = { type: 'place', name: '구성 검증 할인', benefit: { type: 'amount', value: 500 }, audience: 'all' };
      const place = path + '/place';
      await call('POST', place, 403, { key: 'provider-without-approval', body: coupon });
      const grant = await call('POST', approvalPath, 200, { body: { stage: 'press', operation: 'place.create',
        command: coupon, expectedRevision: list.sourceRevision } });
      const useGrant = { key: 'provider-with-approval', body: { ...coupon, approvalId: grant.approvalId, expectedRevision: list.sourceRevision } };
      const created = await call('POST', place, 201, useGrant);
      assert.equal(created.state, 'applied');
      assert.equal((await call('POST', place, 200, useGrant)).receiptId, created.receiptId);
      const { ref: targetRef } = created.result.coupon;
      const after = await call('GET', path, 200);
      assert.equal(after.sourceRevision, list.sourceRevision + 1);
      assert.ok(after.placeCoupons.items.some(item => item.ref === targetRef));
      const command = { confirmed: true };
      const fields = { operation: 'place.delete', command, targetRef, expectedRevision: after.sourceRevision };
      const firstPress = await call('POST', approvalPath, 200, { body: { stage: 'press', ...fields } });
      assert.equal(firstPress.requiresConfirmation, true);
      const deleteRequest = { key: 'provider-delete-with-approval', body: { ...command,
        approvalId: firstPress.approvalId, expectedRevision: after.sourceRevision } };
      await call('DELETE', `${place}/${targetRef}`, 403, deleteRequest);
      await call('POST', approvalPath, 200, { body: { stage: 'confirm', ...fields, approvalId: firstPress.approvalId } });
      await call('DELETE', `${place}/${targetRef}`, 200, deleteRequest);
      assert.ok(!(await call('GET', path, 200)).placeCoupons.items.some(item => item.ref === targetRef));
      console.info('PASS scoped PN05 FAKE coupon, order promotion and membership reads, card-gated create and twice-confirmed delete');
      const search = new URLSearchParams({ from: '2026-11-15', to: '2026-11-17', keyword: '카페' });
      const { search: trend } = await call('GET', `${root}/marketing/local-trends?${search}`, 200);
      assert.equal(trend.status, 'available');
      assert.equal(trend.unit, 'relative-index');
      assert.ok(trend.items.length > 0 && trend.items.every(point => point.ratio >= 0 && point.ratio <= 100));
      console.info('PASS PN10 FAKE Search Interest remains a relative index within the requested period');
    }
    if (process.argv.includes('--review-reads')) {
      const tax = await call('POST', root + '/pos/tax-payments', 200, { key: 'review-tax-fixture',
        body: { taxType: '원천세', amount: 9000, dueOn: '2026-12-10' } });
      const { sources } = await call('GET', root + '/insight/briefings', 200);
      for (const name of ['tax', 'channels', 'marketingToday', 'coupons']) {
        assert.ok(['ready', 'partial'].includes(sources[name].state), `${name}: ${sources[name].state}`);
        assert.notEqual(sources[name].data, null);
      }
      assert.ok(sources.tax.data.items.some(item => item.taxPaymentId === tax.resourceId));
      assert.ok(sources.channels.data.items.some(item => item.channel === 'place' && item.state === 'ready'));
      console.info('PASS Insight briefing read credentials load POS tax and all three new Marketing sources');
    }
    if (process.argv.includes('--notice-provider')) {
      const marketing = root + '/marketing';
      const approvals = marketing + '/notice-reply-approvals';
      const draft = await call('POST', marketing + '/notices', 200, { key: 'persona-news-draft',
        body: { title: '카페 안내', text: '오늘 카페 운영 안내입니다.', channel: 'place-news' } });
      const send = marketing + `/notices/${draft.resourceId}/send`;
      const approval = { approvalId: randomUUID(), operation: 'notice.send', resourceId: draft.resourceId,
        command: { expectedRevision: draft.revision } };
      const request = { key: 'persona-publish-news', body: { ...approval.command, approvalId: approval.approvalId } };
      await call('POST', send, 403, request);
      await call('POST', approvals, 200, { body: { ...approval, stage: 'press' } });
      const sent = await call('POST', send, 200, request);
      const news = await call('GET', marketing + '/place/news', 200);
      assert.ok(news.items.some(item => item.title === '카페 안내' && item.text === '오늘 카페 운영 안내입니다.'));
      assert.deepEqual(await call('POST', send, 200, request), sent);
      const removal = { approvalId: randomUUID(), operation: 'notice.deleteNews', resourceId: draft.resourceId,
        command: { expectedRevision: sent.revision } };
      const remove = marketing + `/notices/${draft.resourceId}/place-news`;
      const removalRequest = { key: 'persona-delete-news', body: { ...removal.command, approvalId: removal.approvalId } };
      await call('POST', approvals, 200, { body: { ...removal, stage: 'press' } });
      await call('DELETE', remove, 403, removalRequest);
      await call('POST', approvals, 200, { body: { ...removal, stage: 'confirm' } });
      await call('DELETE', remove, 200, removalRequest);
      assert.ok(!(await call('GET', marketing + '/place/news', 200)).items.some(item => item.title === '카페 안내'));
      console.info('PASS PN04 FAKE news publishes only after card approval and deletes only after a second confirmation');
    }
    if (process.argv.includes('--talktalk-inbox')) {
      const marketing = root + '/marketing';
      const token = readSecret('/run/secrets/nvirtual_fixture_aicall_token');
      const delivery = new URL('/internal/naver-virtual/v1/talktalk/webhook-fixtures/inbound-01/dispatch',
        process.env.NAVIS_BOOKING_TEST_PROVIDER);
      const trigger = async auth => {
        const reply = await fetch(delivery, { method: 'POST', headers: auth ? {
          'x-navis-naver-virtual-account': process.env.NAVIS_BOOKING_TEST_ACCOUNT, 'x-navis-naver-virtual-token': auth,
        } : {} });
        await reply.body?.cancel();
        return reply.status;
      };
      await call('POST', marketing + '/talktalk/webhook', 404, { body: {} });
      await fetch('http://marketing:3000/internal/v1/naver/talktalk/webhook', { method: 'POST' }).then(async reply => {
        assert.equal(reply.status, 401);
        await reply.body?.cancel();
      });
      assert.equal(await trigger(), 401);
      assert.equal(await trigger(token), 204);
      assert.equal(await trigger(token), 204);
      const feed = await call('GET', marketing + '/inquiries', 200);
      const candidates = feed.items.filter(item => item.source === 'talktalk' && item.providerRef?.startsWith('inbox-'));
      assert.equal(candidates.length, 1);
      const [candidate] = candidates;
      assert.equal(candidate.status, 'waiting');
      assert.equal(candidate.reply, null);
      assert.ok(!('user' in candidate) && !('providerUser' in candidate));
      const draft = await call('PATCH', marketing + `/inquiries/${candidate.id}/draft`, 200, { key: 'talktalk-inbox-draft',
        body: { text: '문의해 주셔서 감사합니다.', expectedRevision: candidate.revision } });
      const target = marketing + `/inquiries/${candidate.id}/reply`;
      const approval = { approvalId: randomUUID(), operation: 'inquiry.post', resourceId: candidate.id,
        command: { expectedRevision: draft.revision } };
      const replyCommand = { key: 'talktalk-inbox-reply', body: { ...approval.command, approvalId: approval.approvalId } };
      await call('POST', target, 403, replyCommand);
      await call('POST', marketing + '/notice-reply-approvals', 200, { body: { ...approval, stage: 'press' } });
      assert.equal((await call('POST', target, 200, replyCommand)).state, 'accepted');
      const after = await call('GET', marketing + '/inquiries', 200);
      assert.equal(after.items.filter(item => item.source === 'talktalk').length, 1);
      assert.equal(after.items.find(item => item.id === candidate.id).reply.text, '문의해 주셔서 감사합니다.');
      console.info('PASS private TalkTalk callback deduplicates a candidate and the recorded recipient only receives an approved FAKE reply');
    }
    if (process.argv.includes('--promo')) {
      const actor = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url')).sub;
      const { seedCafePromoPhotos } = await import('../../packages/db/promo-cafe.ts');
      await seedCafePromoPhotos(db, actor);
      await seedCafePromoPhotos(db, actor);
      const promo = root + '/marketing/promo';
      const assets = await call('GET', promo + '/assets', 200);
      assert.equal(assets.items.length, 39);
      assert.equal(assets.eligiblePhotoCount, 36);
      const approved = assets.menus.find(menu => menu.photoIds.length >= 5);
      assert.ok(approved);
      assert.deepEqual(await call('GET', root + `/files/${assets.items[0].fileId}/content`, 200).then(value => Boolean(value.length)), true);
      const { fileId: upload } = await call('POST', root + '/files', 200, {
        key: 'promo-upload', body: { ...metadata, purpose: 'promo-photo' },
      });
      const rights = { fileId: upload, menuId: approved.menuId, rightsConfirmed: true };
      await call('POST', promo + '/assets', 404, { key: 'promo-pending-upload', body: rights });
      await call('PUT', root + `/files/${upload}/content`, 204, { bytes: image });
      await call('POST', root + `/files/${upload}/complete`, 200, { body: {} });
      await call('POST', promo + '/assets', 200, { key: 'promo-approved-upload', body: rights });
      assert.equal((await call('GET', promo + '/assets', 200)).eligiblePhotoCount, 37);
      if (process.argv.includes('--groups')) {
        const recommendations = root + '/marketing/recommendations';
        const before = await call('GET', recommendations, 200);
        assert.ok(before.cells.some(cell => cell.kind === 'video' && cell.params.photos === 37));
        const inquiry = await call('POST', root + '/marketing/inquiries', 200, {
          key: 'promo-today-inquiry', body: { title: '확인할 문의', text: '영업 시간 문의합니다.' },
        });
        const after = await call('GET', recommendations, 200);
        assert.ok(after.cells.some(cell => cell.kind === 'replies' && cell.ref.itemId === inquiry.resourceId));
        const channels = await call('GET', root + '/marketing/channel-reports?date=2026-11-17', 200);
        assert.ok(channels.items.some(channel => channel.channel === 'place' && channel.state === 'ready'));
      }
      const context = {
        menuIds: [approved.menuId], photoIds: approved.photoIds.slice(0, 5),
        moods: ['warm'], concepts: ['new-item'], memo: '', referenceId: 'ref-1', lengthSec: 10, locale: 'ko',
      };
      const draft = await call('POST', promo + '/drafts', 200, { key: 'promo-cafe-draft', body: context });
      const generate = promo + `/drafts/${draft.resourceId}/generate`;
      await call('POST', generate, 400, { key: 'promo-unconfirmed', body: { expectedRevision: draft.revision } });
      const make = { key: 'promo-cafe-generated', body: { confirmed: true, expectedRevision: draft.revision } };
      const generated = await call('POST', generate, 202, make);
      assert.deepEqual(await call('POST', generate, 202, make), generated);
      const jobPath = root + `/promo/jobs/${generated.resourceId}`;
      let job;
      for (let attempt = 0; attempt < 120; attempt++) {
        job = await call('GET', jobPath, 200);
        if (job.status === 'done' || job.status === 'failed') break;
        await delay(500);
      }
      assert.equal(job?.status, 'done', JSON.stringify(job));
      const mp4 = await call('GET', jobPath + '/video.mp4?download=1', 206, { raw: true, range: 'bytes=0-31' });
      assert.equal(mp4.headers['content-type'], 'video/mp4');
      assert.match(mp4.headers['content-disposition'], /^attachment/);
      assert.equal(mp4.body.length, 32);
      const publication = promo + `/jobs/${generated.resourceId}`;
      assert.equal((await call('POST', publication + '/reels', 409, {
        key: 'promo-manual-social', body: { confirmed: true, description: '새로운 카페 메뉴' },
      })).reason, 'MANUAL_UPLOAD_REQUIRED');
      await call('POST', publication + '/attest', 200, { key: 'promo-manual-attestation', body: {
        confirmed: true, extraConfirmed: true, route: 'reels', link: 'https://www.instagram.com/reel/fixture/',
      } });
      ({ accessToken } = await login());
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
      assert.equal((await call('GET', promo + '/publications', 200)).items[0].method, 'attestation');
      assert.equal((await call('GET', promo + '/assets', 200)).eligiblePhotoCount, 37);
      console.info('PASS B16 retained the approved café and uploaded photos, produced a FAKE job with scoped MP4, and re-read a publication attestation');
    }
    const requested = await call('GET', booking, 200);
    assert.equal(requested.status, 'needs-check');
    assert.equal((await call('GET', booking, 200)).revision, requested.revision);
    const confirm = { key: 'booking-confirm', body: { type: 'booking.confirm', expectedRevision: requested.revision } };
    const confirmed = await call('POST', booking + '/transitions', 200, confirm);
    assert.equal(confirmed.status, 'confirmed');
    assert.deepEqual(await call('POST', booking + '/transitions', 200, confirm), confirmed);
    const cancel = { type: 'booking.cancel', expectedRevision: confirmed.revision, cancelReason: '일정 변경 요청' };
    assert.equal((await call('POST', booking + '/transitions', 409, { key: 'booking-no-confirm', body: cancel })).reason,
      'CONFIRMATION_REQUIRED');
    assert.equal((await call('GET', booking, 200)).status, 'confirmed');
    await call('POST', booking + '/transitions', 200, { key: 'booking-cancel', body: { ...cancel, confirmed: true } });
    const callback = await fetch('http://customer:3000/internal/naver-virtual/aicall/custom-condition/v2', { method: 'POST' });
    assert.equal(callback.status, 403);
    await callback.body?.cancel();
    const url = new URL('/internal/naver-virtual/v1/aicall/fixture/dispatch', process.env.NAVIS_BOOKING_TEST_PROVIDER);
    const fixtureToken = readSecret('/run/secrets/nvirtual_fixture_aicall_token');
    const deliver = async token => {
      const response = await fetch(url, { method: 'POST', headers: token ? {
        'x-navis-naver-virtual-account': process.env.NAVIS_BOOKING_TEST_ACCOUNT, 'x-navis-naver-virtual-token': token,
      } : {} });
      await response.body?.cancel();
      return response.status;
    };
    assert.equal(await deliver(), 401);
    assert.equal(await deliver(fixtureToken), 204);
    assert.equal(await deliver(fixtureToken), 204);
    const suggestions = root + '/reservation-suggestions';
    const { items } = await call('GET', suggestions, 200);
    assert.equal(items.length, 1);
    const [candidate] = items;
    const accepted = await call('POST', root + `/reservations/${candidate.suggestionId}/transitions`, 200, {
      key: 'confirm-aicall-candidate', body: { type: 'booking.confirm', expectedRevision: candidate.revision },
    });
    assert.equal(accepted.status, 'confirmed');
    ({ accessToken } = await login());
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
    assert.equal((await call('GET', booking, 200)).status, 'canceled');
    const acceptedPath = root + `/reservations/${accepted.reservationId}`;
    assert.equal((await call('GET', acceptedPath, 200)).source, 'phone_ai');
    const calendarPrefs = root + '/calendar/preferences';
    const { revision } = await call('GET', calendarPrefs, 200);
    await call('PATCH', calendarPrefs, 200, {
      key: 'calendar-booking-visible', body: { expectedRevision: revision, source: 'reservation', visible: true },
    });
    const projections = root + `/calendar/projections?startDate=${candidate.date}&endDate=${candidate.date}`;
    assert.ok((await call('GET', projections, 200)).items.some(item => item.sourceId === accepted.reservationId));
    if (process.argv.includes('--booking-claim')) {
      const local = await call('POST', root + '/reservations', 201, {
        key: 'local-claim-booking', body: {
          guest: { name: '검증 예약' }, date: '2026-11-17', time: '16:00', partySize: 2, tableChoice: 'auto',
        },
      });
      const claim = await call('POST', root + `/reservations/${local.resourceId}/first-order-claim`, 202, {
        key: 'first-order-actor-only', body: { sourceVersion: local.revision },
      });
      const claimPath = root + `/claims/${claim.claimId}`;
      assert.ok((await call('GET', claimPath, 200)).commandKey);
      await withAccountStore(db, cafe, sql => sql.query(`
        INSERT INTO account.store_member (store_id, user_id, role, created_at, updated_at)
        SELECT $1, user_id, 'owner', now(), now() FROM account.credential WHERE login_id = $2
      `, [cafe, outsiderLogin]));
      ({ accessToken } = await call('POST', '/api/v1/auth/login', 200, { body: { loginId: outsiderLogin, password } }));
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
      await call('GET', claimPath, 404);
      await call('POST', claimPath + '/reconcile', 404, { body: {} });
      await call('POST', claimPath + '/abort', 404, { body: {} });
      ({ accessToken } = await login());
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: cafe } }));
      assert.equal((await call('GET', claimPath, 200)).state, 'held');
      console.info('PASS the operating reservation claim stays private to its actor even from another store owner');
    }
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
    console.info('PASS owner-confirmed synthetic NAVER booking and extra-confirmed cancel, authenticated AiCall dedupe and Calendar readback');
  }
  if (process.argv.includes('--insight')) {
    const manuals = `${store(second)}/insight/manuals`;
    const { fileId: manualPhoto } = await call('POST', `${store(second)}/files`, 200, {
      key: 'manual-photo', body: { ...metadata, purpose: 'manual-evidence' },
    });
    const photoPath = `${store(second)}/files/${manualPhoto}`;
    const manualInput = photoKey => ({
      title: '오픈 점검', section: 'handover', category: 'opening', steps: [{ body: '창문 열기', photoKey }],
    });
    assert.equal((await call('POST', manuals, 400, { key: 'pending-photo', body: manualInput(manualPhoto) })).reason, 'INVALID_PHOTO');
    await call('PUT', `${photoPath}/content`, 204, { bytes: image });
    await call('POST', `${photoPath}/complete`, 200, { body: {} });
    assert.equal((await call('POST', manuals, 400, { key: 'different-purpose', body: manualInput(fileId) })).reason, 'INVALID_PHOTO');
    const manual = await call('POST', manuals, 200, { key: 'verified-photo', body: manualInput(manualPhoto) });
    await login().then(result => { accessToken = result.accessToken; });
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
    const persisted = await call('GET', `${manuals}/${manual.resourceId}`, 200);
    assert.equal(persisted.steps[0].photoKey, manualPhoto);
    console.info('PASS Insight keeps the completed manual image in a new owner session and rejects pending and unrelated uploads');
    if (process.argv.includes('--briefing')) {
      const briefings = `${store(second)}/insight/briefings`;
      const before = await call('GET', briefings, 200);
      assert.equal(before.acknowledgement, null);
      for (const source of ['calendar', 'shifts', 'calendarProjections', 'stock', 'purchasing', 'pickups', 'closing', 'finance']) {
        assert.equal(before.sources[source].state, 'ready', `${source} did not read from its scoped workload`);
      }
      const ackPath = `${briefings}/${before.businessDay}/ack`;
      const ack = await call('POST', ackPath, 200, { key: 'briefing-owner-ack', body: {} });
      assert.deepEqual(await call('POST', ackPath, 200, { key: 'briefing-owner-ack', body: {} }), ack);
      ({ accessToken } = await login());
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
      assert.equal((await call('GET', briefings, 200)).acknowledgement.receiptId, ack.receiptId);
      console.info('PASS Insight briefing reads POS, Inventory and Customer records and persists the explicit owner acknowledgement');
    }
    if (process.argv.includes('--insight-streams')) {
      const { inStore } = await import('../../services/insight/scope.ts');
      const insight = dbPool('insight');
      const waitFor = async (predicate, description) => {
        for (let attempt = 0; attempt < 60; attempt++) {
          if (await predicate()) return;
          await delay(250);
        }
        assert.fail(description);
      };
      try {
        const table = await call('POST', `${store(second)}/pos/tables`, 200, {
          key: 'insight-table', body: { label: 'CCTV 검증 테이블', seats: 2, layoutTableId: 'T10' },
        });
        const hasTable = archived => inStore(insight, second, async db => Boolean((await db.query(
          'SELECT 1 FROM insight.pos_table_source WHERE store_id=$1 AND table_id=$2 AND archived=$3',
          [second, table.resourceId, archived],
        )).rowCount), true);
        await waitFor(() => hasTable(false), 'POS table did not project in Insight');
        await call('DELETE', `${store(second)}/pos/tables/${table.resourceId}`, 200, {
          key: 'insight-table-archive', body: { expectedRevision: table.revision, confirmed: true },
        });
        await waitFor(() => hasTable(true), 'POS table archive did not project in Insight');
        const grants = `${store(second)}/insight/grant-notices`;
        await call('POST', `${grants}/sync`, 200, { key: 'synthetic-grants', body: { region: '서울', industry: '카페' } });
        const { items: [grant] } = await call('GET', grants, 200);
        assert.equal(grant.sourceMode, 'fake');
        const projections = `${store(second)}/calendar/projections?startDate=${grant.deadline}&endDate=${grant.deadline}`;
        await waitFor(async () => (await call('GET', projections, 200)).items
          .some(item => item.source === 'grant-deadline' && item.sourceId === grant.noticeId),
        'Insight grant deadline did not project in Calendar');
        console.info('PASS POS table creation and archive project in Insight, and the FAKE grant deadline projects in Customer Calendar');
      } finally {
        await insight.end();
      }
    }
  }
  const menu = await call('POST', `${store(second)}/inventory/menu`, 201, {
    key: 'create-menu', body: { name: 'Integration tea', category: 'drink', price: 3000 },
  });
  const menuPath = `${store(second)}/inventory/menu/${menu.resourceId}`;
  const picturedMenu = await call('PATCH', menuPath, 200, {
    key: 'attach-photo', body: { expectedRevision: menu.revision, photoFileId: fileId },
  });
  const inventory = `${store(second)}/inventory`;
  const { businessDate, items: emptyStock } = await call('GET', `${inventory}/items`, 200);
  assert.deepEqual(emptyStock, []);
  const item = await call('POST', `${inventory}/items`, 201, {
    key: 'create-stock-item', body: { sku: 'COMPOSE-MILK', name: '우유', unit: 'L', stock: 1, threshold: 0.9 },
  });
  const itemId = item.resourceId;
  const itemPath = `${inventory}/items/${itemId}`;
  const lot = await call('POST', `${inventory}/stock-batches`, 201, {
    key: 'receive-stock-lot', body: { itemId, expectedRevision: item.revision, expiresOn: businessDate, quantity: 0.4 },
  });
  const lotPath = `${inventory}/stock-batches?itemId=${itemId}`;
  await call('PATCH', `${inventory}/recipes`, 200, {
    key: 'save-recipe',
    body: { menuId: menu.resourceId, expectedRevision: picturedMenu.revision, lines: [{ itemId, quantity: 150, unit: 'mL' }] },
  });
  const bill = await call('POST', `${store(second)}/pos/bills`, 200, {
    key: 'create-live-bill', body: { type: 'takeout', lines: [{ menuId: menu.resourceId, qty: 1 }] },
  });
  assert.equal(bill.quote.payable, 3000);
  const payment = await call('POST', `${store(second)}/pos/bills/${bill.resourceId}/payments`, 200, {
    key: 'record-live-cash', body: { method: 'cash', amount: 3000, quoteRevision: bill.quote.quoteRevision },
  });
  await waitForStock(itemPath, '850');
  const soldLot = (await call('GET', lotPath, 200)).items.find(value => value.batchId === lot.resourceId);
  assert.equal(soldLot.remainingQuantityBase, '250');
  const reversal = await call('POST', `${store(second)}/pos/payments/${payment.paymentId}/reversal-quote`, 200, {
    body: { kind: 'cancel' },
  });
  const correction = await call('POST', `${store(second)}/pos/settlements/${payment.settlementId}/corrections`, 200, {
    key: 'cancel-live-cash', body: { quoteToken: reversal.quoteToken, confirmed: true },
  });
  await call('POST', '/api/v1/auth/logout', 204);
  await call('GET', `${store(second)}/boards`, 401);
  ({ accessToken } = await login());
  ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
  const later = (await call('GET', `${store(second)}/boards`, 200)).items.find(item => item.boardId === 'management');
  assert.deepEqual(later.pages, arrangement.pages);
  assert.equal((await call('GET', `${store(second)}/profile`, 200)).businessType, 'restaurant');
  assert.equal((await call('GET', `${store(second)}/preferences`, 200)).theme, 'dark');
  assert.deepEqual(await call('GET', `${file}/content`, 200), image);
  const listed = await call('GET', `${store(second)}/inventory/menu`, 200);
  assert.equal(listed.items.find(item => item.menuId === menu.resourceId).photoFileId, fileId);
  await waitForStock(itemPath, '1000');
  const restoredLot = (await call('GET', lotPath, 200)).items.find(value => value.batchId === lot.resourceId);
  assert.equal(restoredLot.remainingQuantityBase, '400');
  const history = (await call('GET', `${inventory}/stock-movements?itemId=${itemId}`, 200)).items;
  assert.ok(history.some(row => row.sourceId === payment.settlementId && row.deltaBase === '-150'));
  assert.ok(history.some(row => row.sourceId === correction.resourceId && row.deltaBase === '150'));
  await call('GET', `${store(second)}/pos/payments/${payment.paymentId}/receipt`, 200);
  await call('DELETE', file, 204);
  await call('GET', `${file}/content`, 404);
  const another = await call('POST', `${store(second)}/inventory/menu`, 201, {
    key: 'create-another-menu', body: { name: 'Second tea', category: 'drink', price: 3300 },
  });
  await call('PATCH', `${store(second)}/inventory/menu/${another.resourceId}`, 404, {
    key: 'attach-revoked-photo', body: { expectedRevision: another.revision, photoFileId: fileId },
  });
  for (const setting of [null, '', outsider]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (setting !== null) await client.query("SELECT set_config('app.store_id', $1, true)", [setting]);
      assert.equal((await client.query('SELECT 1 FROM account.attachment WHERE store_id = $1', [second])).rowCount, 0);
      await client.query('COMMIT');
    } finally { client.release(); }
  }
  const events = await db.query('SELECT event_type, payload FROM account.outbox WHERE store_id = $1 ORDER BY store_seq', [second]);
  assert.deepEqual(new Set(events.rows.map(row => row.event_type)), new Set([
    'account.store_changed.v1', 'account.store_membership_changed.v1', 'account.preferences_changed.v1',
    'account.panel_changed.v1', 'account.widget_changed.v1', 'account.file_changed.v1',
  ]));
  assert.ok(events.rows.every(row => !JSON.stringify(row.payload).includes(sha256)));
  console.info('PASS login, live membership, store switch, profile, preferences, board, attachment, menu and cash receipt across sessions');
  console.info('PASS standalone stock worker applied the POS sale and correction, preserving their source IDs across sessions');
  if (process.argv.includes('--customer')) {
    const root = store(second);
    const member = await call('POST', `${root}/customers`, 200, {
      key: 'create-member', body: { name: '연동 테스트 회원', phone: '01000000001' },
    });
    const accountPath = `${root}/pos/member-accounts/${member.resourceId}`;
    const funded = await call('POST', `${accountPath}/entries`, 200, {
      key: 'record-topup', body: { purpose: 'charge_topup', amount: 5000, expectedRevision: 0, splits: [{ method: 'cash', amount: 5000 }] },
    });
    assert.ok(funded.paymentId);
    const memberBill = await call('POST', `${root}/pos/bills`, 200, {
      key: 'create-member-bill', body: { type: 'takeout', lines: [{ menuId: menu.resourceId, qty: 1 }] },
    });
    const memberBillPath = `${root}/pos/bills/${memberBill.resourceId}`;
    const checkout = { memberId: member.resourceId, allocations: [{ kind: 'charge', amount: 3000 }] };
    const quote = await call('POST', `${memberBillPath}/member-quote`, 200, { body: checkout });
    assert.equal(quote.realAmount, 0);
    const record = { ...checkout, quoteRevision: quote.quoteRevision, accountRevision: quote.accountRevision };
    const memberSale = await call('POST', `${memberBillPath}/member-payments`, 200, { key: 'member-payment', body: record });
    assert.equal(memberSale.paymentId, undefined);
    assert.deepEqual(await call('POST', `${memberBillPath}/member-payments`, 200, { key: 'member-payment', body: record }), memberSale);
    await waitForStock(itemPath, '850');
    if (process.argv.includes('--groups')) {
      const groups = root + '/marketing/groups';
      const consent = await call('PATCH', root + `/customers/${member.resourceId}/consents`, 200, {
        key: 'allow-group-contact', body: { expectedRevision: member.revision, contactAllowed: true, marketingAllowed: true },
      });
      let projected;
      for (let attempt = 0; attempt < 60; attempt++) {
        const page = await call('GET', groups + '/first-visit/customers', 200);
        projected = page.items.find(row => row.memberId === member.resourceId && row.marketingAllowed);
        if (projected) break;
        await delay(250);
      }
      assert.ok(projected, 'Marketing did not join migrated Customer consent and POS visit');
      assert.equal(projected.visitCount, 1);
      await call('PATCH', root + `/customers/${member.resourceId}/consents`, 200, {
        key: 'revoke-group-consent', body: { expectedRevision: consent.revision, contactAllowed: true, marketingAllowed: false },
      });
      ({ accessToken } = await login());
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
      let updated;
      for (let attempt = 0; attempt < 60; attempt++) {
        const page = await call('GET', groups + '/first-visit/customers', 200);
        updated = page.items.find(row => row.memberId === member.resourceId && row.marketingAllowed === false);
        if (updated) break;
        await delay(250);
      }
      assert.ok(updated && !updated.selectable);
      console.info('PASS B19 joins Customer consent and a POS visit and re-reads revoked consent in a new owner session');
    }

    const staff = await call('POST', `${root}/staff`, 201, { key: 'create-staff', body: { name: '연동 테스트 직원' } });
    const date = new Date(Date.parse(`${businessDate}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
    const shift = await call('POST', `${root}/shifts`, 201, {
      key: 'create-shift', body: { staffId: staff.resourceId, date, kind: 'work', start: '09:00', end: '13:00' },
    });
    const closure = await call('POST', `${root}/calendar/events`, 201, {
      key: 'create-closure', body: { kind: 'event', date, title: '쉬는 날', storeClosure: { kind: 'temporary', endDate: date } },
    });
    await call('POST', '/api/v1/auth/logout', 204);
    ({ accessToken } = await login());
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
    assert.equal((await call('GET', accountPath, 200)).chargeBalance, 2000);
    const laterMoves = (await call('GET', `${inventory}/stock-movements?itemId=${itemId}`, 200)).items;
    assert.ok(laterMoves.some(row => row.sourceId === memberSale.settlementId && row.deltaBase === '-150'));
    assert.equal((await call('GET', `${root}/shifts/${shift.resourceId}`, 200)).staffId, staff.resourceId);
    assert.equal((await call('GET', `${root}/calendar/events/${closure.resourceId}`, 200)).date, date);
    const exported = await call('GET', `${root}/calendar/exports?startDate=${date}&endDate=${date}`, 200, { raw: true });
    assert.match(exported.headers['content-type'], /^text\/calendar/);
    assert.match(exported.headers['content-disposition'], /attachment/);
    assert.match(exported.body.toString('utf8'), /BEGIN:VCALENDAR/);
    console.info('PASS members and shifts across sessions, exact noncash stock movement, and scoped calendar attachment');
  }
  if (process.argv.includes('--postpaid')) {
    const root = `${store(second)}/pos`;
    const left = await call('POST', `${root}/tables`, 200, { key: 'table-left', body: { label: '검증 1', seats: 2, layoutTableId: 'T1' } });
    const right = await call('POST', `${root}/tables`, 200, { key: 'table-right', body: { label: '검증 2', seats: 4, layoutTableId: 'T2' } });
    const draft = await call('POST', `${root}/bills`, 200, {
      key: 'postpaid-start', body: { type: 'dine_in', lines: [{ menuId: menu.resourceId, qty: 1 }],
        table: { tableId: left.resourceId, expectedRevision: left.revision } },
    });
    const billPath = `${root}/bills/${draft.resourceId}`;
    const addition = await call('POST', `${billPath}/orders`, 200, {
      key: 'postpaid-add', body: { expectedRevision: draft.revision, lines: [{ menuId: menu.resourceId, qty: 1 }] },
    });
    assert.deepEqual(addition.orderIds, [draft.orderId, addition.orderId]);
    const moved = await call('POST', `${billPath}/move`, 200, {
      key: 'postpaid-move', body: { expectedRevision: addition.revision, table: { tableId: right.resourceId, expectedRevision: right.revision } },
    });
    const reverted = await call('POST', `${root}/receipts/${moved.receiptId}/undo`, 200, { key: 'postpaid-move-undo', body: {} });
    assert.equal(reverted.resourceId, draft.resourceId);
    assert.equal((await call('GET', billPath, 200)).tableId, left.resourceId);
    const quote = await call('POST', `${root}/settlement-quotes`, 200, { body: { billId: draft.resourceId } });
    assert.equal(quote.payable, 6000);
    const paid = await call('POST', `${billPath}/payments`, 200, {
      key: 'postpaid-pay', body: { method: 'cash', amount: quote.payable, quoteRevision: quote.quoteRevision },
    });
    await call('POST', '/api/v1/auth/logout', 204);
    ({ accessToken } = await login());
    ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: second } }));
    const current = await call('GET', billPath, 200);
    assert.equal(current.status, 'paid');
    assert.deepEqual(current.orderIds, addition.orderIds);
    assert.equal((await call('GET', `${root}/tables/${left.resourceId}`, 200)).state, 'cleaning');
    const reopened = await call('GET', `${root}/payments/${paid.paymentId}/receipt`, 200);
    assert.equal(reopened.orderNos.length, 2);
    await waitForStock(itemPath, process.argv.includes('--customer') ? '550' : '700');
    console.info('PASS postpaid table, two accepted orders, move undo, cash record and two-order receipt across owner sessions');
  }
  if (process.argv.includes('--purchasing')) {
    const pos = dbPool('pos', 'migrate');
    try {
      // This store has never made a POS sale. The receipt worker must create its own store scope.
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: first } }));
      const root = store(first);
      const inv = `${root}/inventory`;
      const { businessDate } = await call('GET', `${inv}/items`, 200);
      const dueDate = new Date(Date.parse(`${businessDate}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
      const ingredient = await call('POST', `${inv}/items`, 201, {
        key: 'purchase-item', body: { sku: 'PURCHASE-MILK', name: '입고 테스트 우유', unit: 'L', stock: 0, threshold: 1 },
      });
      const supplier = await call('POST', `${inv}/suppliers`, 201, {
        key: 'purchase-supplier', body: { name: '테스트 공급사', contact: '테스트 담당', phone: '01000000000' },
      });
      const terms = await call('POST', `${inv}/purchase-items`, 201, {
        key: 'purchase-terms', body: { itemId: ingredient.resourceId, supplierId: supplier.resourceId, minimumQty: 1,
          orderStep: 1, unitPrice: 2300, leadDays: 2 },
      });
      const purchase = await call('POST', `${inv}/purchase-orders`, 201, {
        key: 'purchase-order', body: { purchaseItemId: terms.resourceId, qty: 2, dueDate, expectedRevision: terms.revision },
      });
      const receipts = `${inv}/purchase-orders/${purchase.poId}/receipts`;
      const receipt = await call('POST', receipts, 201, {
        key: 'purchase-receive', body: { polId: purchase.polId, qty: 1, expectedRevision: purchase.revision },
      });
      assert.equal(receipt.receiptId, receipt.expenseCandidateReceiptId);
      await waitForStock(`${inv}/items/${ingredient.resourceId}`, '1000');
      const undo = await call('POST', `${inv}/purchasing/receipts/${receipt.receiptId}/undo`, 200, {
        key: 'purchase-undo', body: {},
      });
      await waitForStock(`${inv}/items/${ingredient.resourceId}`, '0');
      await call('POST', '/api/v1/auth/logout', 204);
      ({ accessToken } = await login());
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: first } }));
      const laterOrder = await call('GET', `${inv}/purchase-orders/${purchase.poId}`, 200);
      assert.equal(laterOrder.revision, undo.revision);
      assert.equal(laterOrder.lines[0].received, 0);
      await call('GET', `${inv}/purchase-receipt-status/${receipt.receiptId}`, 404);
      let projected;
      let candidate;
      for (let attempt = 0; attempt < 60; attempt++) {
        projected = (await call('GET', `${root}/calendar/projections?startDate=${dueDate}&endDate=${dueDate}`, 200)).items
          .find(row => row.sourceId === purchase.poId);
        const { rows } = await withPosStore(pos, first, db => db.query(`
          SELECT status, amount::integer FROM pos.expense_candidate WHERE store_id = $1 AND receipt_id = $2
        `, [first, receipt.receiptId]), { readOnly: true });
        candidate = rows[0];
        if (projected?.sourceRevision === undo.revision && candidate?.status === 'canceled') break;
        await delay(200);
      }
      assert.equal(projected?.date, dueDate);
      assert.equal(projected?.sourceRevision, undo.revision);
      assert.deepEqual(candidate, { status: 'canceled', amount: 2300 });
      console.info('PASS purchase order and receipt undo across owner sessions, stock 0→1000→0, matching POS candidate and Calendar revision');

      const retained = await call('POST', receipts, 201, {
        key: 'purchase-retain', body: { polId: purchase.polId, qty: 1, expectedRevision: laterOrder.revision },
      });
      const candidates = `${root}/pos/expense-candidates?businessDate=${businessDate}`;
      let financeCandidate;
      for (let attempt = 0; attempt < 60; attempt++) {
        financeCandidate = (await call('GET', candidates, 200)).items.find(row => row.receiptId === retained.receiptId);
        if (financeCandidate) break;
        await delay(200);
      }
      assert.equal(financeCandidate?.amount, 2300);
      await delay(Math.max(0, Date.parse(retained.undoUntil) - Date.now() + 250));
      const expense = await call('POST', `${root}/pos/expense-candidates/${financeCandidate.expenseId}/confirm`, 200, {
        body: { expectedRevision: financeCandidate.revision }, key: 'expense-confirm',
      });
      await call('POST', '/api/v1/auth/logout', 204);
      ({ accessToken } = await login());
      ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId: first } }));
      const persisted = await call('GET', `${root}/pos/expenses/${expense.expenseId}`, 200);
      assert.equal(persisted.receiptId, retained.receiptId);
      assert.equal(persisted.amount, 2300);
      assert.equal((await call('GET', `${root}/pos/ledger?businessDate=${businessDate}`, 200)).totals.expenses, 2300);
      console.info('PASS POS confirmed the retained Inventory receipt using its private status route and re-read the expense and ledger in a new owner session');
    } finally { await pos.end(); }
  }
}
try {
  await verifyAccount();
} finally {
  await Promise.all([db.end(), pool.end()]);
}

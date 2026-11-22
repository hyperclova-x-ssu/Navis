// B14 compose proof: browser-shaped requests through edge → api-gateway → marketing → PostgreSQL, with Inventory lots and
// cost, Customer consent and a real POS bill/payment. Run in the tools container: node --experimental-transform-types <this file>.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { dbPool } from '../../../../packages/db/index.ts';
import { provisionOwner } from '../../../account/reality/00/provision.ts';

const origin = process.env.NAVIS_ACCOUNT_TEST_ORIGIN ?? 'http://127.0.0.1:18294';
const edge = process.env.NAVIS_ACCOUNT_TEST_EDGE ?? origin;
const password = randomBytes(24).toString('base64url');
const loginId = `${randomUUID()}@example.invalid`;
const storeId = randomUUID();
const outsiderStore = randomUUID();
const outsiderLogin = `${randomUUID()}@example.invalid`;
const accountDb = dbPool('account', 'migrate');
const marketingDb = dbPool('marketing', 'migrate');
const log = (step, value) => console.log(JSON.stringify({ step, ...value }));
let cookie;
let accessToken;

function send(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
    const outgoing = httpRequest(url, { method, headers, signal: AbortSignal.timeout(10_000) }, incoming => {
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
  const response = await send(edge + path, method, headers, body === undefined ? undefined : JSON.stringify(body));
  const text = response.body.toString();
  assert.equal(response.status, status, `${method} ${path} expected ${status}: ${text.slice(0, 400)}`);
  const setCookie = response.headers['set-cookie']?.find(value => value.startsWith('navis_refresh='));
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = status === 204 || !text ? undefined : JSON.parse(text);
  return Object.defineProperty(json ?? {}, 'requestId', { value: response.headers['x-request-id'], enumerable: false });
}
const root = `/api/v1/stores/${storeId}`;
const mkt = `${root}/marketing`;
const inSession = async () => {
  ({ accessToken } = await call('POST', '/api/v1/auth/login', 200, { body: { loginId, password } }));
  ({ accessToken } = await call('POST', '/api/v1/auth/store', 200, { body: { storeId } }));
};

try {
  await provisionOwner(accountDb, { loginId, password, ownerName: 'Coupon proof owner', storeId, storeName: 'Coupon proof café', businessDayStart: '05:00' });
  await provisionOwner(accountDb, { loginId: outsiderLogin, password, ownerName: 'Other owner', storeId: outsiderStore, storeName: 'Other café' });
  await inSession();

  // Inventory: retail croissant item with a cost term, a lot expiring today, and a menu whose recipe uses the item.
  const { businessDate } = await call('GET', `${root}/inventory/items`, 200);
  const item = await call('POST', `${root}/inventory/items`, 201, { key: randomUUID(),
    body: { sku: 'B14-CROISSANT', name: '크루아상', unit: 'pcs', stock: 6, threshold: 1 } });
  const supplier = await call('POST', `${root}/inventory/suppliers`, 201, { key: randomUUID(), body: { name: '빵 공급', contact: '담당', phone: '010-0000-0000' } });
  await call('POST', `${root}/inventory/purchase-items`, 201, { key: randomUUID(), body: { itemId: item.resourceId, supplierId: supplier.resourceId,
    minimumQty: 1, orderStep: 1, unitPrice: 1200, leadDays: 1 } });
  const lot = await call('POST', `${root}/inventory/stock-batches`, 201, { key: randomUUID(),
    body: { itemId: item.resourceId, expectedRevision: item.revision, expiresOn: businessDate, quantity: 6 } });
  const menu = await call('POST', `${root}/inventory/menu`, 201, { key: randomUUID(), body: { name: '크루아상', category: 'dessert', price: 3500, memo: null } });
  await call('PATCH', `${root}/inventory/recipes`, 200, { key: randomUUID(),
    body: { menuId: menu.resourceId, expectedRevision: menu.revision, lines: [{ itemId: item.resourceId, quantity: 1, unit: 'pcs' }] } });
  log('inventory', { businessDate, itemId: item.resourceId, lotId: lot.resourceId, menuId: menu.resourceId });
  if (process.argv.includes('--recommendations')) {
    const recommendations = await call('GET', `${mkt}/recommendations`, 200);
    assert.deepEqual(recommendations.cells.find(cell => cell.slot === 'now')?.params, { count: 6, itemName: '크루아상' });
  }

  // Widget 25: lot-linked expiry coupon, Place News draft, replay, attestation.
  const expiryKey = randomUUID();
  const expiryBody = { itemId: item.resourceId, route: 'place_news', benefit: { kind: 'percent', value: 40 } };
  const expiry = await call('POST', `${mkt}/coupons/expiry`, 201, { key: expiryKey, body: expiryBody });
  assert.deepEqual(await call('POST', `${mkt}/coupons/expiry`, 201, { key: expiryKey, body: expiryBody }), expiry);
  assert.equal((await call('POST', `${mkt}/coupons/expiry`, 409, { key: randomUUID(), body: expiryBody })).reason, 'EXPIRY_ALREADY_MADE');
  assert.equal((await call('POST', `${mkt}/coupons/expiry`, 400, { key: randomUUID(),
    body: { ...expiryBody, benefit: { kind: 'percent', value: 66 } } })).reason, 'OVER_LIMIT');
  assert.equal(expiry.issueLimit, 6);
  log('expiry.created', { requestId: expiry.requestId, couponId: expiry.couponId, codeId: expiry.codeId, code: expiry.code, receiptId: expiry.receiptId,
    post: expiry.post, undoUntil: expiry.undoUntil });
  const posted = await call('POST', `${mkt}/coupon-codes/${expiry.codeId}/mark-posted`, 200, { key: randomUUID(), body: {} });
  log('expiry.posted', { requestId: posted.requestId, issued: posted.issued, receiptId: posted.receiptId });
  if (process.argv.includes('--recommendations')) {
    const recommendations = await call('GET', `${mkt}/recommendations`, 200);
    assert.ok(!recommendations.cells.some(cell => cell.slot === 'now'));
    assert.ok(!recommendations.missing.includes('coupons'));
    log('expiry.recommendation', { lotId: lot.resourceId, foldedAfterIssue: true });
  }

  // POS: quote, bill with the coupon discount, claim, cash payment, reconcile.
  const lines = [{ lineId: 'line-1', menuId: menu.resourceId, gross: 3500, basePrice: 3500, options: [] }];
  const quote = await call('POST', `${mkt}/coupon-redemptions/quote`, 200, { body: { code: expiry.code, lines } });
  assert.equal(quote.discount, 1400);
  const bill = await call('POST', `${root}/pos/bills`, 200, { key: randomUUID(),
    body: { type: 'takeout', lines: [{ menuId: menu.resourceId, qty: 1 }], discount: quote.discount } });
  assert.equal(bill.quote.payable, 2100);
  const claim = await call('POST', `${mkt}/coupon-redemptions`, 201, { key: randomUUID(), body: { code: expiry.code, billId: bill.resourceId } });
  assert.equal(claim.redemption.state, 'held');
  const payment = await call('POST', `${root}/pos/bills/${bill.resourceId}/payments`, 200, { key: randomUUID(),
    body: { method: 'cash', amount: 2100, quoteRevision: bill.quote.quoteRevision } });
  const redemptionPath = `${mkt}/coupon-redemptions/${claim.redemption.redemptionId}`;
  if (process.argv.includes('--performance')) {
    let projected;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      projected = await call('GET', redemptionPath, 200);
      if (projected.state === 'committed') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(projected.state, 'committed', 'POS event should commit the redemption without manual reconciliation');
    assert.equal(projected.sale.settlementId, payment.settlementId);
  }
  const reconciled = await call('POST', redemptionPath + '/reconcile', 200, { body: {} });
  assert.equal(reconciled.state, 'committed');
  assert.equal(reconciled.sale.settlementId, payment.settlementId);
  log('pos.redeemed', { billId: bill.resourceId, paymentId: payment.paymentId, settlementId: payment.settlementId,
    redemptionId: claim.redemption.redemptionId, claimRequestId: claim.requestId, reconcileRequestId: reconciled.requestId });
  const unpaid = await call('POST', `${root}/pos/bills`, 200, { key: randomUUID(),
    body: { type: 'takeout', lines: [{ menuId: menu.resourceId, qty: 1 }], discount: 0 } });
  assert.equal((await call('POST', `${mkt}/coupon-redemptions`, 409, { key: randomUUID(),
    body: { code: expiry.code, billId: unpaid.resourceId } })).reason, 'BILL_DISCOUNT_MISMATCH');

  // Widget 24: consented member and quiet-slot coupon queued (not sent: A6 off).
  const member = await call('POST', `${root}/customers`, 200, { key: randomUUID(), body: { name: '쿠폰 회원', phone: '01000001414' } });
  const consent = await call('PATCH', `${root}/customers/${member.resourceId}/consents`, 200, { key: randomUUID(),
    body: { contactAllowed: true, marketingAllowed: true, expectedRevision: member.revision } });
  const tomorrow = new Date(Date.parse(`${businessDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const slotBody = { benefitId: 'free-shot', recipientIds: [member.resourceId],
    slots: [{ slotId: `slot-${tomorrow}-14`, date: tomorrow, startHour: 14, endHour: 17 }] };
  assert.equal((await call('POST', `${mkt}/coupons/slot`, 400, { key: randomUUID(),
    body: { ...slotBody, sendAt: `${tomorrow}T22:00` } })).reason, 'NIGHT_SEND_NOT_ALLOWED');
  const slot = await call('POST', `${mkt}/coupons/slot`, 201, { key: randomUUID(), body: slotBody });
  assert.equal(slot.delivery, 'queued');
  log('slot.issued', { requestId: slot.requestId, couponId: slot.couponId, queued: slot.queued, scheduledLocal: slot.scheduledLocal,
    consentRevision: consent.revision });

  // Widget 28: pause, resume, extend with revisions.
  const paused = await call('POST', `${mkt}/coupons/${slot.couponId}/pause`, 200, { key: randomUUID(), body: { expectedRevision: 1 } });
  assert.equal((await call('POST', `${mkt}/coupons/${slot.couponId}/resume`, 409, { key: randomUUID(), body: { expectedRevision: 1 } })).reason, 'STALE_REVISION');
  await call('POST', `${mkt}/coupons/${slot.couponId}/resume`, 200, { key: randomUUID(), body: { expectedRevision: paused.revision } });
  const extended = await call('POST', `${mkt}/coupons/${slot.couponId}/extend`, 200, { key: randomUUID(), body: { expectedRevision: paused.revision + 1 } });
  log('status.lifecycle', { pausedRevision: paused.revision, extendedEndsOn: extended.endsOn, extendRequestId: extended.requestId });

  // Reload: a new session re-reads the same records.
  await call('POST', '/api/v1/auth/logout', 204);
  accessToken = undefined;
  await call('GET', `${mkt}/coupons`, 401);
  await inSession();
  const listed = await call('GET', `${mkt}/coupons?status=running`, 200);
  const expiryRow = listed.items.find(row => row.couponId === expiry.couponId);
  const slotRow = listed.items.find(row => row.couponId === slot.couponId);
  assert.equal(expiryRow.used, 1);
  assert.equal(expiryRow.discountSum, 1400);
  assert.equal(expiryRow.codes[0].remaining, 5);
  assert.equal(slotRow.endsOn, extended.endsOn);
  const usage = await call('GET', `${mkt}/coupons/usage`, 200);
  assert.equal(usage.used, 1);
  log('reload', { sourceRevision: listed.sourceRevision, items: listed.items.length, expiryUsed: expiryRow.used, usage });
  if (process.argv.includes('--performance')) {
    let measured;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      measured = await call('GET', `${mkt}/performance`, 200);
      if (measured.coupons?.payment?.pendingSettlements === 0) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(measured.state, 'ready');
    assert.equal(measured.coupons.issued, 7);
    assert.equal(measured.coupons.used, 1);
    assert.equal(measured.coupons.payment.paidAmount, 2100);
    assert.equal(measured.coupons.payment.discount, 1400);
    log('performance', { businessDate: measured.businessDate, issued: measured.coupons.issued, used: measured.coupons.used,
      payment: measured.coupons.payment });
  }

  // Another owner's session cannot read this store's coupons.
  ({ accessToken } = await call('POST', '/api/v1/auth/login', 200, { body: { loginId: outsiderLogin, password } }));
  await call('GET', `${mkt}/coupons`, 403);

  // DB re-read under the store scope: IDs from receipts exist with the expected state; events carry no message bodies.
  const db = await marketingDb.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.store_id', $1, true)", [storeId]);
    const coupons = await db.query('SELECT coupon_id, origin, status, lot_key FROM marketing.coupon ORDER BY created_at');
    const redemption = await db.query('SELECT state, settlement_id, discount FROM marketing.coupon_redemption WHERE redemption_id = $1',
      [claim.redemption.redemptionId]);
    const messages = await db.query(`SELECT count(*)::int AS n, bool_and(status = 'queued') AS queued,
      bool_and(starts_with(body, '(광고)') AND body LIKE '%무료수신거부%') AS advertising_preview FROM marketing.coupon_message`);
    const events = await db.query('SELECT event_type, payload FROM marketing.outbox WHERE store_id = $1 ORDER BY store_seq', [storeId]);
    await db.query('COMMIT');
    assert.equal(redemption.rows[0].state, 'committed');
    assert.equal(redemption.rows[0].settlement_id, payment.settlementId);
    assert.deepEqual(messages.rows[0], { n: 1, queued: true, advertising_preview: true });
    assert.ok(!JSON.stringify(events.rows).includes('한산한 시간'));
    log('db', { coupons: coupons.rows, redemption: redemption.rows[0], messages: messages.rows[0],
      events: events.rows.map(row => `${row.event_type}:${row.payload.operation ?? row.payload.kind}`) });
  } finally {
    db.release();
  }
  log('done', { ok: true, storeId });
} finally {
  await accountDb.end();
  await marketingDb.end();
}

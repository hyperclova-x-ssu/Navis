import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../../infra/http.ts';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { inStore } from '../../transaction.ts';
import type { OrderPromotion } from '../../../../packages/naver/contracts/pn05/index.ts';
import type { CouponSources, ExpiryLot, MenuBasis, NaverCouponPort, PosBill, PosBillReader, Recipient } from './clients.ts';
import { couponPosHandlers } from './redemptions.ts';
import { registerCouponRoutes } from './routes.ts';

const databaseUrl = process.env.NAVIS_B14_TEST_DB_URL;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : dbPool('marketing', 'runtime', 'test');
const token = randomBytes(32).toString('hex');
const owner = randomUUID();
// D-313 fixture clock: 2026-11-17 15:45 KST, café business day starts at 05:00.
let now = new Date('2026-11-17T06:45:00Z');
const today = '2026-11-17';

type Fixture = {
  members: Map<string, Recipient>; lots: Map<string, ExpiryLot>; menus: Map<string, MenuBasis>; down: boolean;
  bills: Map<string, PosBill>; naverCalls: string[]; naverFail?: string;
};
const fixtures = new Map<string, Fixture>();
const fixture = (store: string) => {
  if (!fixtures.has(store)) fixtures.set(store, { members: new Map(), lots: new Map(), menus: new Map(), down: false, bills: new Map(), naverCalls: [] });
  return fixtures.get(store)!;
};
const sources: CouponSources = {
  async recipients(actor, ids) {
    const f = fixture(actor.storeId);
    return f.down ? null : new Map(ids.flatMap(id => f.members.has(id) ? [[id, f.members.get(id)!] as const] : []));
  },
  async regulars(actor) {
    const f = fixture(actor.storeId);
    return f.down ? null : [...f.members.values()];
  },
  async expiryLot(actor, itemId) {
    const f = fixture(actor.storeId);
    return f.down ? null : f.lots.get(itemId) ?? 'missing';
  },
  async menuForItem(actor, itemId) {
    const f = fixture(actor.storeId);
    return f.down ? null : f.menus.get(itemId) ?? 'missing';
  },
};
const pos: PosBillReader = {
  async bill(actor, billId) {
    const f = fixture(actor.storeId);
    return f.down ? null : f.bills.get(billId) ?? 'missing';
  },
};
/** An open POS bill as `GET /pos/bills/:id` reports it. */
function openBill(store: string, discount: number, lines: PosBill['lines']) {
  const bill: PosBill = { billId: randomUUID(), status: 'open', discount, lines, settlementId: null, orderId: null };
  fixture(store).bills.set(bill.billId, bill);
  return bill;
}
const pay = (store: string, bill: PosBill, discount = bill.discount) => {
  const paid: PosBill = { ...bill, status: 'paid', discount, settlementId: randomUUID(), orderId: randomUUID() };
  fixture(store).bills.set(bill.billId, paid);
  return { settlementId: paid.settlementId!, billId: bill.billId, orderId: paid.orderId! };
};
const posEvent = (store: string, type: string, payload: Record<string, unknown>, aggregateId: string = randomUUID()) => ({
  eventId: randomUUID(), producer: 'pos' as const, storeId: store, scopeKey: store, storeSeq: '9', eventType: type, schemaVersion: 1,
  aggregateId, occurredAt: '2026-11-17T07:00:00.000Z', payload,
});

function fakeNaver(store: string): NaverCouponPort {
  const f = fixture(store);
  const coupons: Record<string, unknown>[] = [];
  let savedPromotion: OrderPromotion;
  const attempts = new Map<string, unknown>();
  const once = <T>(key: string, run: () => T): T => {
    if (!attempts.has(key)) attempts.set(key, run());
    return attempts.get(key) as T;
  };
  return {
    async listPlaceCoupons() { return { items: coupons, nextCursor: null }; },
    async createPlaceCoupon({ coupon, attemptKey }) {
      f.naverCalls.push(`create:${attemptKey}`);
      if (f.naverFail) throw Object.assign(new Error('fail'), { code: f.naverFail });
      return once(attemptKey, () => {
        const created = { ...coupon, ref: `pc-${coupons.length + 1}`, state: 'active' };
        coupons.push(created);
        return { effect: 'place-coupon-created', coupon: created };
      });
    },
    async deletePlaceCoupon({ ref, attemptKey, confirmation }) {
      expect(confirmation).toBe('confirmed-twice');
      f.naverCalls.push(`delete:${ref}:${attemptKey}`);
      return { effect: 'place-coupon-deleted', earlierDownloadsStayValid: true };
    },
    async listCouponIssues() { return { items: [], nextCursor: null }; },
    async setIssueUsage({ issueRef, used }) {
      return { effect: 'coupon-usage-changed', issue: { ref: issueRef, maskedNumber: '****01',
        issuedOn: today, expiresOn: today, used } };
    },
    async listOrderPromotions() { return { items: [], nextCursor: null }; },
    async createOrderPromotion({ promotion }) {
      savedPromotion = { ...promotion, ref: 'op-1', state: 'upcoming' };
      return { effect: 'order-promotion-created', promotion: savedPromotion };
    },
    async extendOrderPromotion({ ref, to }) { return { effect: 'order-promotion-extended', promotion: { ...savedPromotion, ref, to } }; },
    async endOrderPromotion({ ref, confirmation }) {
      expect(confirmation).toBe('confirmed-twice');
      return { effect: 'order-promotion-ended', promotion: { ...savedPromotion, ref, state: 'ended' } };
    },
    async readMembership() { return { enrolled: false, product: null, benefits: [] }; },
  };
}
const naverPorts = new Map<string, NaverCouponPort>();

function createService() {
  const app = createApp('marketing', async () => {}, false);
  registerCouponRoutes(app, pool, { gatewayToken: token, sources, pos, naverWriteMode: 'fake', now: () => now,
    naver: store => store.startsWith('0') ? null : naverPorts.get(store) ?? naverPorts.set(store, fakeNaver(store)).get(store)! });
  return app;
}
let service = createService();
const headers = (store: string, key?: string, user = owner) => ({
  authorization: `Bearer ${token}`, 'x-navis-store-id': store, 'x-navis-store-role': 'owner', 'x-navis-user-id': user,
  'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00', ...(key && { 'idempotency-key': key }),
});
const url = (store: string, path: string) => `/internal/v1/marketing/stores/${store}${path}`;
function call(store: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object, key: string | null = randomUUID()) {
  return service.inject({ method, url: url(store, path), headers: headers(store, method === 'GET' ? undefined : key ?? undefined), payload });
}
const newStore = () => `1${randomUUID().slice(1)}`;
const member = (consent = true, recent = 3): Recipient => ({ customerId: randomUUID(), marketingAllowed: consent, visitCount: recent, recentVisitCount: recent, lastVisitAt: null });

function seedExpiry(store: string, unitCost: number | null = 1200) {
  const f = fixture(store);
  const itemId = randomUUID();
  const menuId = randomUUID();
  f.lots.set(itemId, { itemId, batchId: randomUUID(), name: '크루아상', expiresOn: today, remainingBase: 6, unit: 'pcs' });
  f.menus.set(itemId, { menuId, name: '크루아상', price: 3500, unitCost, revision: 2, itemIds: [itemId] });
  return { itemId, menuId };
}
const croissant = (menuId: string, gross = 3500) => ({ lineId: 'line-1', menuId, gross, basePrice: gross, options: [] });

if (!databaseUrl) beforeAll(() => runMigrations('marketing', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test'), 60_000);
afterAll(async () => {
  await service.close();
  await pool.end();
});

describe('authorization', () => {
  it('requires the gateway credential and an owner of the same store', async () => {
    const store = newStore();
    expect((await service.inject({ method: 'GET', url: url(store, '/coupons') })).statusCode).toBe(401);
    const other = await service.inject({ method: 'GET', url: url(store, '/coupons'), headers: { ...headers(newStore()) } });
    expect(other.statusCode).toBe(403);
    const staff = await service.inject({ method: 'GET', url: url(store, '/coupons'), headers: { ...headers(store), 'x-navis-store-role': 'staff' } });
    expect(staff.statusCode).toBe(403);
    expect((await call(store, 'POST', '/coupons/expiry', {}, null)).json()).toMatchObject({ reason: 'IDEMPOTENCY_KEY_REQUIRED' });
  });
});

describe('expiry coupon (widget 25)', () => {
  it('creates one lot-linked Place News draft, attests it, re-reads it in a new session and guards duplicates and cost', async () => {
    const store = newStore();
    const { itemId, menuId } = seedExpiry(store);
    const key = randomUUID();
    const body = { itemId, route: 'place_news', benefit: { kind: 'percent', value: 40 } };
    const created = await call(store, 'POST', '/coupons/expiry', body, key);
    expect(created.statusCode).toBe(201);
    const receipt = created.json();
    expect(receipt).toMatchObject({ changed: true, route: 'place_news', issued: 0, issueLimit: 6, sent: false,
      affectedSources: expect.arrayContaining(['expiry-coupon', 'coupon-status']) });
    expect(receipt.code).toMatch(/^NV[A-Z2-9]{8}$/);
    expect(receipt.post).toContain(receipt.code);
    expect(receipt.undoUntil).toBe('2026-11-17T06:45:06.000Z');
    // Same key and body returns the stored receipt; a changed body is refused.
    expect((await call(store, 'POST', '/coupons/expiry', body, key)).json()).toEqual(receipt);
    expect((await call(store, 'POST', '/coupons/expiry', { ...body, benefit: { kind: 'percent', value: 30 } }, key)).json())
      .toMatchObject({ code: 'CONFLICT', reason: 'IDEMPOTENCY_MISMATCH' });
    expect((await call(store, 'POST', '/coupons/expiry', body)).json()).toMatchObject({ reason: 'EXPIRY_ALREADY_MADE' });
    expect((await call(store, 'POST', '/coupons/expiry', { ...seedExpiryBody(store, 66) })).json()).toMatchObject({ reason: 'OVER_LIMIT' });
    expect((await call(store, 'POST', '/coupons/expiry', { ...seedExpiryBody(store, 10, null) })).json()).toMatchObject({ reason: 'COST_UNKNOWN' });

    const posted = await call(store, 'POST', `/coupon-codes/${receipt.codeId}/mark-posted`, {});
    expect(posted.json()).toMatchObject({ changed: true, issued: 6 });
    expect(posted.json().undoUntil).toBeUndefined();
    expect((await call(store, 'POST', `/coupon-codes/${receipt.codeId}/mark-posted`, {})).json()).toMatchObject({ reason: 'ALREADY_DONE' });

    await service.close();
    service = createService();
    const list = (await call(store, 'GET', '/coupons?origin=expiry')).json();
    expect(list).toMatchObject({ businessDate: today, nextCursor: null, sourceRevision: 2 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ couponId: receipt.couponId, origin: 'expiry', status: 'active', issued: 6, used: 0,
      targetRef: menuId, benefit: { kind: 'percent', value: 40 }, endsOn: today, endingSoon: true,
      basis: { price: 3500, unitCost: 1200, maxRatePercent: 65.7 }, codes: [{ code: receipt.code, activated: true, eligible: false, remaining: 6 }] });
  });

  it('undoes an unposted draft within the receipt window only', async () => {
    const store = newStore();
    const { itemId } = seedExpiry(store);
    const receipt = (await call(store, 'POST', '/coupons/expiry', { itemId, route: 'place_news', discountRate: 30 })).json();
    now = new Date('2026-11-17T06:45:07Z');
    expect((await call(store, 'POST', `/coupons/receipts/${receipt.receiptId}/undo`, {})).json()).toMatchObject({ reason: 'UNDO_EXPIRED' });
    now = new Date('2026-11-17T06:45:00Z');
    const again = (await call(store, 'POST', '/coupons/expiry', { itemId, route: 'place_news', discountRate: 20 })).json();
    expect(again.reason).toBe('EXPIRY_ALREADY_MADE');
    const other = seedExpiryBody(store, 30);
    const second = (await call(store, 'POST', '/coupons/expiry', other)).json();
    expect((await call(store, 'POST', `/coupons/receipts/${second.receiptId}/undo`, {}, randomUUID())).json()).toMatchObject({ changed: true });
    expect((await call(store, 'GET', `/coupons/${second.couponId}`)).json()).toMatchObject({ reason: 'COUPON_NOT_FOUND' });
  });

  it('sends the SMS route only to consenting regulars and records queued (not delivered) messages', async () => {
    const store = newStore();
    const f = fixture(store);
    for (const row of [member(true, 3), member(true, 2), member(false, 5), member(true, 1)]) f.members.set(row.customerId, row);
    const created = (await call(store, 'POST', '/coupons/expiry', { ...seedExpiryBody(store, 40), route: 'sms' })).json();
    expect(created).toMatchObject({ route: 'sms', issued: 2, queued: 2, delivery: 'queued', night: false });
    expect(created.undoUntil).toBeUndefined();
    const messages = await inStore(pool, store, db => db.query('SELECT body FROM marketing.coupon_message WHERE coupon_id = $1', [created.couponId]));
    expect(messages.rows).toHaveLength(2);
    for (const { body } of messages.rows) expect(body).toMatch(/^\(광고\) .+\n크루아상을 오늘만 .+\n무료수신거부 /);

    const outbox = await inStore(pool, store, db => db.query(`SELECT event_type, payload FROM marketing.outbox WHERE store_id = $1 ORDER BY store_seq`, [store]));
    expect(outbox.rows.map(row => row.event_type)).toEqual(['marketing.coupon_code_changed.v1', 'marketing.message_queued.v1']);
    expect(JSON.stringify(outbox.rows)).not.toMatch(/오늘만|할인해요/);
    f.down = true;
    expect((await call(store, 'POST', '/coupons/expiry', { ...seedExpiryBody(store, 40), route: 'sms' })).statusCode).toBe(503);
  });
});

function seedExpiryBody(store: string, rate: number, cost: number | null = 1200) {
  const { itemId } = seedExpiry(store, cost);
  return { itemId, route: 'place_news', discountRate: rate };
}

describe('slot coupon (widget 24)', () => {
  const slots = [{ slotId: 'slot-2026-11-18-14', date: '2026-11-18', startHour: 14, endHour: 17 }];
  it('issues a consented quiet-slot coupon, refuses non-consent and duplicates, and schedules night sends for 08:00', async () => {
    const store = newStore();
    const f = fixture(store);
    const yes = member(true);
    const no = member(false);
    f.members.set(yes.customerId, yes);
    f.members.set(no.customerId, no);
    expect((await call(store, 'POST', '/coupons/slot', { slots, benefitId: 'free-shot', recipientIds: [yes.customerId, no.customerId] })).json())
      .toMatchObject({ reason: 'NO_CONSENT' });
    expect((await call(store, 'POST', '/coupons/slot', { slots, benefitId: 'free-shot', recipientIds: [randomUUID()] })).json())
      .toMatchObject({ reason: 'RECIPIENT_NOT_FOUND' });
    now = new Date('2026-11-17T13:30:00Z'); // 22:30 KST
    const draft = { slots, benefitId: 'free-shot', recipientIds: [yes.customerId], body: '직접 작성한 쿠폰' };
    for (const sendAt of ['2026-11-18T07:59', '2026-11-18T21:00']) {
      const response = await call(store, 'POST', '/coupons/slot', { ...draft, sendAt });
      expect(response.json()).toMatchObject({ reason: 'NIGHT_SEND_NOT_ALLOWED' });
    }
    const issued = (await call(store, 'POST', '/coupons/slot', draft)).json();
    expect(issued).toMatchObject({ issued: 1, queued: 1, delivery: 'queued', night: true, scheduledLocal: '2026-11-18T08:00' });
    const queued = await inStore(pool, store, db => db.query('SELECT body FROM marketing.coupon_message WHERE coupon_id = $1', [issued.couponId]));
    expect(queued.rows[0].body).toMatch(/^\(광고\) .+\n직접 작성한 쿠폰\n무료수신거부 /);
    now = new Date('2026-11-17T06:45:00Z');
    expect((await call(store, 'POST', '/coupons/slot', { slots, benefitId: 'percent-10', recipientIds: [yes.customerId] })).json())
      .toMatchObject({ reason: 'SLOT_ALREADY_HANDLED' });
    const coupon = (await call(store, 'GET', `/coupons/${issued.couponId}`)).json();
    expect(coupon).toMatchObject({ origin: 'slot', name: '빈 시간 샷 추가 무료', targetRef: 'opt-extra-shot', issued: 1, reminderTargets: 1,
      validHours: [{ weekday: 3, startHour: 14, endHour: 17 }], endsOn: '2026-11-30', originRef: { slotIds: ['slot-2026-11-18-14'] } });
  });
});

describe('lifecycle (widget 28, D-326)', () => {
  it('pauses, resumes, extends and ends with revision checks, keeping issued code terms', async () => {
    const store = newStore();
    const { itemId } = seedExpiry(store);
    const created = (await call(store, 'POST', '/coupons/expiry', { itemId, route: 'place_news', discountRate: 40 })).json();
    await call(store, 'POST', `/coupon-codes/${created.codeId}/mark-posted`, {});
    const path = `/coupons/${created.couponId}`;
    expect((await call(store, 'POST', `${path}/pause`, { expectedRevision: 2 })).json()).toMatchObject({ reason: 'STALE_REVISION', details: { revision: 1 } });
    const paused = (await call(store, 'POST', `${path}/pause`, { expectedRevision: 1 })).json();
    expect(paused).toMatchObject({ status: 'paused', revision: 2 });
    expect(paused.undoUntil).toBeDefined();
    expect((await call(store, 'POST', `${path}/pause`, { expectedRevision: 2 })).json()).toMatchObject({ reason: 'ALREADY_DONE' });
    expect((await call(store, 'POST', `${path}/resume`, { expectedRevision: 2 })).json()).toMatchObject({ status: 'active', revision: 3 });
    expect((await call(store, 'POST', `${path}/extend`, { expectedRevision: 3 })).json()).toMatchObject({ endsOn: '2026-11-24', revision: 4 });
    const changed = (await call(store, 'PATCH', path, { benefitValue: 30, quantity: 4, expectedRevision: 4 })).json();
    expect(changed).toMatchObject({ benefitValue: 30, quantity: 4, revision: 5 });
    const detail = (await call(store, 'GET', path)).json();
    expect(detail).toMatchObject({ name: '크루아상 오늘만 30%', benefitValue: 30, futureIssueCount: 4 });
    expect(detail.codes).toHaveLength(2);
    expect(detail.codes[0]).toMatchObject({ activated: true, issueCount: 6,
      issuedTerms: { benefitType: 'percent', benefitValue: 40, endsOn: '2026-11-24' } });
    expect(detail.codes[1]).toMatchObject({ activated: false, issueCount: 4, eligible: true });
    expect((await call(store, 'POST', `${path}/end`, { expectedRevision: 5 })).json()).toMatchObject({ reason: 'EXTRA_CONFIRMATION_REQUIRED' });
    const ended = (await call(store, 'POST', `${path}/end`, { expectedRevision: 5, confirmed: true })).json();
    expect(ended).toMatchObject({ status: 'ended', endsOn: today });
    expect((await call(store, 'POST', `/coupons/receipts/${ended.receiptId}/undo`, {})).json()).toMatchObject({ changed: true });
    expect((await call(store, 'GET', path)).json()).toMatchObject({ status: 'active', endsOn: '2026-11-24', revision: 7 });
  });

  it('notifies ending soon only to targets who still consent', async () => {
    const store = newStore();
    const f = fixture(store);
    const a = member(true);
    const b = member(true);
    f.members.set(a.customerId, a);
    f.members.set(b.customerId, b);
    const issued = (await call(store, 'POST', '/coupons/slot', { benefitId: 'amount-500', recipientIds: [a.customerId, b.customerId],
      slots: [{ slotId: 'slot-2026-11-19-15', date: '2026-11-19', startHour: 15, endHour: 17 }] })).json();
    expect((await call(store, 'POST', `/coupons/${issued.couponId}/notify-ending`, {})).json()).toMatchObject({ reason: 'NOT_ENDING_SOON' });
    now = new Date('2026-11-28T06:45:00Z');
    f.members.set(b.customerId, { ...b, marketingAllowed: false });
    const notice = (await call(store, 'POST', `/coupons/${issued.couponId}/notify-ending`, {})).json();
    expect(notice).toMatchObject({ recipients: 1, delivery: 'queued' });
    now = new Date('2026-11-17T06:45:00Z');
  });
});

describe('POS redemption (widgets 25/28/30)', () => {
  it('uses the store business-day cutoff for a same-day expiry coupon', async () => {
    const store = newStore();
    const { itemId, menuId } = seedExpiry(store);
    const created = (await call(store, 'POST', '/coupons/expiry', { itemId, route: 'place_news', discountRate: 40 })).json();
    await call(store, 'POST', `/coupon-codes/${created.codeId}/mark-posted`, {});
    const quote = { code: created.code, lines: [croissant(menuId)] };
    const previous = now;
    try {
      now = new Date('2026-11-17T19:59:00Z'); // Nov 18 04:59 KST, still the Nov 17 business day.
      expect((await call(store, 'POST', '/coupon-redemptions/quote', quote)).json()).toMatchObject({ discount: 1400 });
      now = new Date('2026-11-17T20:00:00Z');
      expect((await call(store, 'POST', '/coupon-redemptions/quote', quote)).json()).toMatchObject({ reason: 'COUPON_ENDED' });
    } finally {
      now = previous;
    }
  });

  it('holds one use for an open POS bill carrying the discount, commits it when paid, enforces the cap and reverses on a cancel event', async () => {
    const store = newStore();
    const { itemId, menuId } = seedExpiry(store);
    fixture(store).lots.get(itemId)!.remainingBase = 1;
    const created = (await call(store, 'POST', '/coupons/expiry', { itemId, route: 'place_news', discountRate: 40 })).json();
    const lines = [croissant(menuId)];
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code: created.code, lines })).json())
      .toMatchObject({ reason: 'COUPON_CODE_INACTIVE' });
    await call(store, 'POST', `/coupon-codes/${created.codeId}/mark-posted`, {});
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code: created.code.toLowerCase(), lines })).json())
      .toMatchObject({ discount: 1400, remaining: 1, scope: { kind: 'line', targetLineIds: ['line-1'] } });
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code: created.code, lines: [{ ...lines[0], menuId: randomUUID() }] })).json())
      .toMatchObject({ reason: 'COUPON_MENU_REQUIRED' });

    const unpriced = openBill(store, 0, lines);
    expect((await call(store, 'POST', '/coupon-redemptions', { code: created.code, billId: unpriced.billId })).json())
      .toMatchObject({ reason: 'BILL_DISCOUNT_MISMATCH', details: { couponDiscount: 1400, billDiscount: 0 } });
    expect((await call(store, 'POST', '/coupon-redemptions', { code: created.code, billId: randomUUID() })).json())
      .toMatchObject({ reason: 'BILL_NOT_FOUND' });
    const bill = openBill(store, 1400, lines);
    const key = randomUUID();
    const claim = await call(store, 'POST', '/coupon-redemptions', { code: created.code, billId: bill.billId }, key);
    expect(claim.statusCode).toBe(201);
    const { redemption } = claim.json();
    expect(redemption).toMatchObject({ state: 'held', discount: 1400, billId: bill.billId, holdUntil: '2026-11-17T06:55:00.000Z' });
    expect((await call(store, 'POST', '/coupon-redemptions', { code: created.code, billId: bill.billId }, key)).statusCode).toBe(200);
    expect((await call(store, 'POST', '/coupon-redemptions', { code: created.code, billId: openBill(store, 1400, lines).billId })).json())
      .toMatchObject({ reason: 'COUPON_EXHAUSTED' });
    expect((await call(store, 'POST', `/coupon-redemptions/${redemption.redemptionId}/reconcile`, {})).statusCode).toBe(202);

    const sale = pay(store, bill);
    const reconciled = await call(store, 'POST', `/coupon-redemptions/${redemption.redemptionId}/reconcile`, {});
    expect(reconciled.json()).toMatchObject({ state: 'committed', sale });
    expect((await call(store, 'POST', `/coupon-redemptions/${redemption.redemptionId}/release`, { confirmed: true })).json())
      .toMatchObject({ reason: 'ALREADY_REDEEMED' });
    expect((await call(store, 'GET', `/coupons/${created.couponId}`)).json()).toMatchObject({ used: 1, discountSum: 1400 });
    expect((await call(store, 'GET', '/coupons/usage?from=2026-11-01&to=2026-11-30')).json())
      .toMatchObject({ used: 1, discount: 1400, issued: 1, reversed: 0 });

    const event = posEvent(store, 'pos.sale_corrected.v1', { ...sale, businessDate: today, lines: [], correctionId: randomUUID(),
      kind: 'cancel', target: 'recognized_sale', usageEffect: 'restore', amountDelta: -2100, costDelta: -1200, incompleteMarginCoverage: false });
    await inStore(pool, store, db => couponPosHandlers['pos.sale_corrected.v1'](db, event));
    await inStore(pool, store, db => couponPosHandlers['pos.sale_corrected.v1'](db, event));
    const after = (await call(store, 'GET', `/coupon-redemptions/${redemption.redemptionId}`)).json();
    expect(after).toMatchObject({ state: 'reversed', correctionId: event.payload.correctionId });
    expect((await call(store, 'GET', `/coupons/${created.couponId}`)).json()).toMatchObject({ used: 0, codes: [{ remaining: 1 }] });
    const outbox = await inStore(pool, store, db => db.query(`SELECT payload->>'operation' AS operation FROM marketing.outbox
      WHERE store_id = $1 AND event_type = 'marketing.coupon_code_changed.v1' ORDER BY store_seq`, [store]));
    expect(outbox.rows.map(row => row.operation)).toEqual(['activated', 'redeemed', 'reversed']);
  });

  it('commits a held claim from the POS sale event and refuses a bill paid without the coupon discount', async () => {
    const store = newStore();
    const { itemId, menuId } = seedExpiry(store);
    const created = (await call(store, 'POST', '/coupons/expiry', { itemId, route: 'place_news', discountRate: 40 })).json();
    await call(store, 'POST', `/coupon-codes/${created.codeId}/mark-posted`, {});
    const first = openBill(store, 1400, [croissant(menuId)]);
    const held = (await call(store, 'POST', '/coupon-redemptions', { code: created.code, billId: first.billId })).json().redemption;
    const sale = pay(store, first);
    const recognized = posEvent(store, 'pos.sale_recognized.v1', { ...sale, businessDate: today, lines: [], amount: 2100, cost: 1200,
      incompleteMarginCoverage: false }, sale.settlementId);
    await inStore(pool, store, db => couponPosHandlers['pos.sale_recognized.v1'](db, recognized));
    await inStore(pool, store, db => couponPosHandlers['pos.sale_recognized.v1'](db, recognized));
    expect((await call(store, 'GET', `/coupon-redemptions/${held.redemptionId}`)).json()).toMatchObject({ state: 'committed', sale });

    const second = openBill(store, 1400, [croissant(menuId)]);
    const claim = (await call(store, 'POST', '/coupon-redemptions', { code: created.code, billId: second.billId })).json().redemption;
    pay(store, second, 0);
    expect((await call(store, 'POST', `/coupon-redemptions/${claim.redemptionId}/reconcile`, {})).json())
      .toMatchObject({ state: 'released', releaseReason: 'rejected' });
    expect((await call(store, 'GET', `/coupons/${created.couponId}`)).json()).toMatchObject({ used: 1 });
  });

  it('releases a coupon from an unpaid bill and keeps member-targeted SMS codes to their targets and hours', async () => {
    const store = newStore();
    const f = fixture(store);
    const target = member(true);
    f.members.set(target.customerId, target);
    const issued = (await call(store, 'POST', '/coupons/slot', { benefitId: 'amount-500', recipientIds: [target.customerId],
      slots: [{ slotId: 'slot-2026-11-17-14', date: today, startHour: 14, endHour: 17 }] })).json();
    const { code } = (await call(store, 'GET', `/coupons/${issued.couponId}`)).json().codes[0];
    const lines = [{ lineId: 'a', menuId: randomUUID(), gross: 4500, basePrice: 4500, options: [] }];
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code, lines })).json()).toMatchObject({ reason: 'COUPON_MEMBER_REQUIRED' });
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code, lines, customerId: target.customerId })).json())
      .toMatchObject({ discount: 500, scope: { kind: 'bill' } });
    const bill = openBill(store, 500, lines);
    const held = (await call(store, 'POST', '/coupon-redemptions', { code, customerId: target.customerId, billId: bill.billId })).json().redemption;
    expect((await call(store, 'POST', `/coupon-redemptions/${held.redemptionId}/release`, {})).json())
      .toMatchObject({ reason: 'EXTRA_CONFIRMATION_REQUIRED' });
    f.down = true;
    expect((await call(store, 'POST', `/coupon-redemptions/${held.redemptionId}/release`, { confirmed: true })).statusCode).toBe(503);
    f.down = false;
    expect((await call(store, 'POST', `/coupon-redemptions/${held.redemptionId}/release`, { confirmed: true })).json())
      .toMatchObject({ state: 'released', releaseReason: 'owner_released' });
    now = new Date('2026-11-17T09:30:00Z'); // 18:30 KST is outside the 14–17 slot
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code, lines, customerId: target.customerId })).json())
      .toMatchObject({ reason: 'COUPON_HOURS' });
    now = new Date('2026-11-17T06:45:00Z');
    await call(store, 'POST', `/coupons/${issued.couponId}/pause`, { expectedRevision: 1 });
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code, lines, customerId: target.customerId })).json())
      .toMatchObject({ reason: 'COUPON_PAUSED' });
  });

  it('honours an issued code after an early end until its original expiry (D-326)', async () => {
    const store = newStore();
    const { itemId, menuId } = seedExpiry(store);
    const created = (await call(store, 'POST', '/coupons/expiry', { itemId, route: 'place_news', discountRate: 40 })).json();
    await call(store, 'POST', `/coupon-codes/${created.codeId}/mark-posted`, {});
    await call(store, 'POST', `/coupons/${created.couponId}/extend`, { expectedRevision: 1 });
    await call(store, 'POST', `/coupons/${created.couponId}/end`, { expectedRevision: 2, confirmed: true });
    now = new Date('2026-11-20T06:45:00Z');
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code: created.code, lines: [croissant(menuId)] })).json())
      .toMatchObject({ discount: 1400, terms: { endsOn: '2026-11-24' } });
    now = new Date('2026-11-25T06:45:00Z');
    expect((await call(store, 'POST', '/coupon-redemptions/quote', { code: created.code, lines: [croissant(menuId)] })).json())
      .toMatchObject({ reason: 'COUPON_ENDED' });
    now = new Date('2026-11-17T06:45:00Z');
  });
});

describe('NAVER PN05 coupons (separate lifecycle)', () => {
  async function press(store: string, operation: string, command: object, expectedRevision: number, targetRef?: string) {
    const card = { operation, command, expectedRevision, targetRef };
    const response = await call(store, 'POST', '/naver-coupon-approvals', { ...card, stage: 'press' });
    expect(response.statusCode, response.body).toBe(200);
    const { approvalId, requiresConfirmation } = response.json();
    return { card, approvalId, requiresConfirmation, body: { ...command, approvalId, expectedRevision } };
  }

  it('records each provider action once, refuses menu-specific coupons and requires a second confirmation to delete', async () => {
    const store = newStore();
    const body = { type: 'place', name: '첫 방문 12.5% 할인', benefit: { type: 'percent', value: 12.5 }, audience: 'all',
      displayPeriod: { from: '2026-11-18', to: '2026-11-30' }, quantity: 50, conditions: null };
    expect((await call(store, 'POST', '/naver-coupons/place', { ...body, menuId: randomUUID() })).json()).toMatchObject({ reason: 'INVALID_REQUEST', field: 'menuId' });
    expect((await call(store, 'POST', '/naver-coupons/place', { ...body, benefit: '12.5% 할인' })).statusCode).toBe(400);
    expect((await call(store, 'POST', '/naver-coupons/place', { ...body, audience: 'marketing-message' })).statusCode).toBe(400);
    const key = randomUUID();
    expect((await call(store, 'POST', '/naver-coupons/place', body, key)).statusCode).toBe(403);
    expect(fixture(store).naverCalls).toHaveLength(0);
    const create = await press(store, 'place.create', body, 0);
    const created = await call(store, 'POST', '/naver-coupons/place', create.body, key);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ source: 'naver', operation: 'place.create', state: 'applied',
      result: { coupon: { ...body, ref: 'pc-1' } } });
    expect((await call(store, 'POST', '/naver-coupons/place', create.body, key)).json()).toEqual(created.json());
    expect(fixture(store).naverCalls.filter(call => call.startsWith('create'))).toHaveLength(1);
    expect((await call(store, 'GET', '/naver-coupons')).json()).toMatchObject({ source: 'naver', placeCoupons: { items: [{ ref: 'pc-1' }] } });
    expect((await call(store, 'DELETE', '/naver-coupons/place/pc-1', {})).json()).toMatchObject({ reason: 'EXTRA_CONFIRMATION_REQUIRED' });
    const remove = await press(store, 'place.delete', { confirmed: true }, 1, 'pc-1');
    expect(remove.requiresConfirmation).toBe(true);
    expect((await call(store, 'DELETE', '/naver-coupons/place/pc-other', remove.body)).statusCode).toBe(403);
    expect((await call(store, 'DELETE', '/naver-coupons/place/pc-1', remove.body)).statusCode).toBe(403);
    expect((await call(store, 'POST', '/naver-coupon-approvals', {
      ...remove.card, stage: 'confirm', approvalId: remove.approvalId,
    })).json()).toMatchObject({ requiresConfirmation: false });
    expect((await call(store, 'DELETE', '/naver-coupons/place/pc-1', remove.body)).json())
      .toMatchObject({ state: 'applied', result: { earlierDownloadsStayValid: true } });
    expect((await call(store, 'DELETE', '/naver-coupons/place/pc-1', remove.body)).statusCode).toBe(403);
    const pending = await press(store, 'place.create', { ...body, name: '두 번째' }, 2);
    fixture(store).naverFail = 'UNKNOWN_OUTCOME';
    const pendingKey = randomUUID();
    expect((await call(store, 'POST', '/naver-coupons/place', pending.body, pendingKey)).statusCode).toBe(202);
    fixture(store).naverFail = undefined;
    expect((await call(store, 'POST', '/naver-coupons/place', pending.body, pendingKey)).json()).toMatchObject({ state: 'pending' });
    const attempts = fixture(store).naverCalls.filter(call => call.startsWith('create'));
    expect(attempts).toHaveLength(2);
  });

  it('sends order amount per stamp and maps existing issue and extension commands to PN05', async () => {
    const store = newStore();
    const promotion = { name: '겨울 스탬프', from: '2026-11-18', to: '2026-11-30', orderAmountPerStamp: 5_000,
      coupons: [{ stampCount: 8, name: '라떼 1잔 무료', validDays: 60, canCombine: false, canUseAlone: true }] };
    expect((await call(store, 'POST', '/naver-coupons/promotions', { ...promotion, stampRule: { kind: 'menu', menuRefs: ['latte'] } })).statusCode).toBe(400);
    const created = await call(store, 'POST', '/naver-coupons/promotions', (await press(store, 'promotion.create', promotion, 0)).body);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ result: { promotion: { ...promotion, ref: 'op-1' } } });
    const extended = await call(store, 'POST', '/naver-coupons/promotions/op-1/extend',
      (await press(store, 'promotion.extend', { endDate: '2026-12-10' }, 1, 'op-1')).body);
    expect(extended.json()).toMatchObject({ result: { promotion: { to: '2026-12-10' } } });
    const used = await call(store, 'PATCH', '/naver-coupons/issues/issue-1/usage',
      (await press(store, 'issue.usage', { status: 'used' }, 2, 'issue-1')).body);
    expect(used.json()).toMatchObject({ result: { issue: { used: true } } });
    const end = await press(store, 'promotion.end', { confirmed: true }, 3, 'op-1');
    expect(end.requiresConfirmation).toBe(true);
    const endPath = '/naver-coupons/promotions/op-1/end';
    expect((await call(store, 'POST', endPath, end.body)).statusCode).toBe(403);
    await call(store, 'POST', '/naver-coupon-approvals', { ...end.card, stage: 'confirm', approvalId: end.approvalId });
    expect((await call(store, 'POST', endPath, end.body)).json()).toMatchObject({ state: 'applied' });
  });

  it('binds a short-lived approval to actor, store, request and current revision', async () => {
    const store = newStore();
    const body = { type: 'place', name: '첫 방문 할인', benefit: { type: 'amount', value: 1000 }, audience: 'all' };
    const approved = await press(store, 'place.create', body, 0);
    const unapprovedActor = await service.inject({ method: 'POST', url: url(store, '/naver-coupons/place'),
      headers: headers(store, randomUUID(), randomUUID()), payload: approved.body });
    expect(unapprovedActor.statusCode).toBe(403);
    expect((await call(newStore(), 'POST', '/naver-coupons/place', approved.body)).statusCode).toBe(403);
    expect((await call(store, 'POST', '/naver-coupons/place', { ...approved.body, name: '다른 쿠폰' })).statusCode).toBe(403);
    expect((await call(store, 'POST', '/naver-coupons/place', { ...approved.body, expectedRevision: 1 })).statusCode).toBe(403);
    expect(fixture(store).naverCalls).toHaveLength(0);

    const next = await press(store, 'place.create', body, 0);
    const key = randomUUID();
    const samePress = await Promise.all([call(store, 'POST', '/naver-coupons/place', next.body, key),
      call(store, 'POST', '/naver-coupons/place', next.body, key)]);
    expect(samePress.some(response => response.statusCode === 201)).toBe(true);
    expect(fixture(store).naverCalls).toHaveLength(1);
    const read = await call(store, 'GET', '/naver-coupons');
    expect(read.json()).toMatchObject({ sourceRevision: 1, placeCoupons: { items: [{ ref: 'pc-1' }] } });
    expect((await call(store, 'POST', '/naver-coupons/place', approved.body)).json()).toMatchObject({ reason: 'STALE_REVISION' });

    const expiring = await press(store, 'place.create', body, 1);
    const previous = now;
    try {
      now = new Date(+previous + 60_000);
      expect((await call(store, 'POST', '/naver-coupons/place', expiring.body)).statusCode).toBe(403);
      expect(fixture(store).naverCalls).toHaveLength(1);
    } finally {
      now = previous;
    }
  });

  it('falls back to the official screen when PN05 is not bound for the store', async () => {
    const store = `0${randomUUID().slice(1)}`;
    expect((await call(store, 'GET', '/naver-coupons')).json()).toMatchObject({ reason: 'NAVER_COUPONS_UNAVAILABLE',
      details: { officialUrl: expect.stringContaining('help.naver.com') } });
  });
});

describe('row-level scope', () => {
  it('never reads or changes another store’s coupons', async () => {
    const a = newStore();
    const b = newStore();
    const created = (await call(a, 'POST', '/coupons/expiry', seedExpiryBody(a, 20))).json();
    expect((await call(b, 'GET', `/coupons/${created.couponId}`)).json()).toMatchObject({ reason: 'COUPON_NOT_FOUND' });
    expect((await call(b, 'POST', `/coupon-codes/${created.codeId}/mark-posted`, {})).json()).toMatchObject({ reason: 'CODE_NOT_FOUND' });
    const rows = await pool.query('SELECT count(*)::int AS n FROM marketing.coupon');
    expect(rows.rows[0].n).toBe(0);
  });
});

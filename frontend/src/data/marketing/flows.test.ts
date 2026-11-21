/** DATA_MODEL 10.15.7: one coupon source, commands, validation, once keys, cross reads (AC-289·290·293·297·300·303·313~318). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureId, QueryCondition } from '../../contracts';
import { inputOf, makeDone as finishVideo } from './promo-fixtures';
import { addDays, TODAY, TOMORROW } from '../db/time';
import { createSeedTables } from '../db/seed';
import { SLOT_COUPON_ENDS } from './derive';
import { NIGHT_SEND_RESTRICTION } from './calc';
import { createWidgetDataStore, selectWidget, type DataCommandResult, type ModelOf, type WidgetDataStore } from '../widget-data';

function modelOf<F extends FeatureId>(store: WidgetDataStore, id: F, condition: QueryCondition = { kind: 'default' }): ModelOf<F> {
  const view = selectWidget(store.getSnapshot(), id, condition, 'normal');
  if (view.status !== 'ready') throw new Error(`${id} not ready: ${view.status}`);
  return view.model as ModelOf<F>;
}
const okResult = (r: DataCommandResult) => {
  if (!r.ok) throw new Error(`command failed: ${r.code} ${r.messageKey} ${r.field ?? ''}`);
  return r;
};
const seed = createSeedTables();
const active = seed.marketing.coupon.find(row => row.status === 'active')!;
const ended = seed.marketing.coupon.find(row => row.status === 'ended')!;
const EXPIRY_ITEM = 'i-basque-cake';
const EXPIRY_NAME = 'seed:바스크 치즈케이크(조각)';
const PHOTO_MENU = 'm-cafe-latte';
const photoRows = Array.from({ length: 10 }, (_, order) => ({
  photoId: `test-photo-${order}`, menuId: PHOTO_MENU, url: `/test/photo/${order}`, width: 900, height: 900, order,
}));
const slot = modelOf(createWidgetDataStore(), 'slot-coupon').openSlots.find(row => row.regularIds.length > 0)!;
const recipient = slot.regularIds[0];
const noConsent = seed.marketing.mktCustomer.find(row => !row.consentSms)!.customerId;
const regulars = () => slot.regularIds;
const sendMatchedSlot = (store: WidgetDataStore, key = 'send-1', extra: Record<string, unknown> = {}) =>
  store.dispatch({ type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: regulars(), benefit: 'percent-10', idempotencyKey: key, ...extra });
const withPhotos = () => createWidgetDataStore({ marketing: { ...seed.marketing, promoPhoto: photoRows } });
const makeDone = (store: WidgetDataStore, key?: string) => finishVideo(store, key, 5, { menuIds: [PHOTO_MENU] });

describe('one coupon source: slot coupon to the matched cafe regular (AC-313·314, F-55)', () => {
  it('one snapshot change moves coupon status, results and today’s promotions together', () => {
    const store = createWidgetDataStore();
    const before = store.getSnapshot().revision;
    const r = okResult(sendMatchedSlot(store));
    expect(r.noticeKey).toBe('data.notice.sent');
    expect(r.undoToken).toBeUndefined();
    expect(store.getSnapshot().revision).toBe(before + 1);
    const status = modelOf(store, 'coupon-status');
    expect(status.activeCount).toBe(2);
    expect(status.endingSoonCount).toBe(0);
    const fresh = status.rows.find((x) => x.origin === 'slot')!;
    expect([fresh.used, fresh.issued, fresh.daysLeft, fresh.endsOn, fresh.name]).toEqual([0, 1, 13, SLOT_COUPON_ENDS, { key: 'data.marketing.coupon.slotPercent', params: { p: 10 } }]);
    expect([status.runningUsed, status.endedUsed, status.monthUsed]).toEqual([223, 142, 365]);
    const perf = modelOf(store, 'marketing-performance');
    expect([perf.issued, perf.used, perf.rate, perf.rateDelta?.value]).toEqual([300, 223, 74, 16]);
    expect(perf.routes.find((x) => x.route === 'sms')).toMatchObject({ issued: 300, used: 223, rate: 74 });
    expect([perf.revenue.total, perf.profit, perf.returnRate]).toEqual([1_739_400, 1_139_685, null]);
    expect(perf.recentIssued).toBe(1);
    expect(perf.byCoupon.find((x) => x.couponId === fresh.couponId)).toMatchObject({ issued: 1, used: 0 });
    const today = modelOf(store, 'marketing-today');
    expect(today.cells[0].kind === 'quiet-hours' && [today.cells[0].quietSlot.slotId, today.cells[0].params.regulars]).toEqual([`slot-${TOMORROW}-15`, 0]);
    const slot = modelOf(store, 'slot-coupon');
    expect([slot.slotCount, slot.slots.find(row => row.regularIds.length > 0)?.handled, slot.regularsCount]).toEqual([8, true, 0]);
    expect(slot.sent).toHaveLength(1);
    // mock sends only, never a use (Q-35)
    const m = store.getSnapshot().tables.marketing;
    expect(m.messageSend.filter((x) => x.couponId === fresh.couponId).every((x) => x.status === 'mock' && !x.isNight)).toBe(true);
    expect(m.couponTarget.filter((x) => x.couponId === fresh.couponId)).toHaveLength(1);
    expect(m.couponRedemptionAgg).toEqual(createWidgetDataStore().getSnapshot().tables.marketing.couponRedemptionAgg);
  });
  it('the same idempotency key twice issues once', () => {
    const store = createWidgetDataStore();
    const first = okResult(sendMatchedSlot(store, 'k'));
    const revision = store.getSnapshot().revision;
    const second = okResult(sendMatchedSlot(store, 'k'));
    expect(second.duplicate).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(store.getSnapshot().revision).toBe(revision);
    expect(modelOf(store, 'coupon-status').activeCount).toBe(2);
    expect(store.dispatch({ type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: [recipient], benefit: 'percent-10', idempotencyKey: '' })).toMatchObject({ ok: false, field: 'idempotencyKey' });
  });
  it('handling every quiet slot falls back to the expiring items before folding the cell', () => {
    const store = createWidgetDataStore();
    okResult(sendMatchedSlot(store, 'a'));
    const slot = modelOf(store, 'slot-coupon');
    okResult(store.dispatch({ type: 'coupon.sendSlot', slotIds: slot.openSlots.map((s) => s.slotId), recipientIds: regulars(), benefit: 'percent-10', idempotencyKey: 'b' }));
    expect(modelOf(store, 'slot-coupon').canSend).toBe(false);
    const today = modelOf(store, 'marketing-today');
    expect(today.cells[0]).toMatchObject({ slot: 'now', kind: 'expiry', params: { count: 6 }, itemNameKey: EXPIRY_NAME, ref: { featureId: 'expiry-coupon', focus: 'action' } });
    okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: 'c' }));
    okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: 'i-saltbread', benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: 'd' }));
    const photoCount = seed.marketing.promoPhoto.length;
    expect(modelOf(store, 'marketing-today').folded).toEqual(photoCount >= 5 ? ['now'] : ['now', 'week']);
  });
});

describe('validation: consent, night, recipients (AC-289·290)', () => {
  it('rejects no recipients, unknown/non-consenting customers, unknown or handled slots, bad benefit', () => {
    const store = createWidgetDataStore();
    const base = { type: 'coupon.sendSlot', slotIds: [slot.slotId], benefit: 'percent-10', idempotencyKey: 'x' } as const;
    expect(store.dispatch({ ...base, recipientIds: [] })).toEqual({ ok: false, code: 'VALIDATION', field: 'recipientIds', messageKey: 'data.marketing.error.noRecipients' });
    expect(store.dispatch({ ...base, recipientIds: [recipient, noConsent], idempotencyKey: 'y' })).toEqual({ ok: false, code: 'VALIDATION', field: 'recipientIds', messageKey: 'data.marketing.error.noConsent' });
    expect(store.dispatch({ ...base, recipientIds: ['nobody'], idempotencyKey: 'z' })).toMatchObject({ ok: false, code: 'NOT_FOUND', field: 'recipientIds' });
    expect(store.dispatch({ ...base, slotIds: ['slot-x'], recipientIds: [recipient], idempotencyKey: 'w' })).toMatchObject({ ok: false, code: 'NOT_FOUND', field: 'slotIds' });
    expect(store.dispatch({ ...base, slotIds: [], recipientIds: [recipient], idempotencyKey: 'v' })).toMatchObject({ ok: false, code: 'VALIDATION', field: 'slotIds' });
    expect(store.dispatch({ ...base, benefit: 'free-cake' as never, recipientIds: [recipient], idempotencyKey: 'u' })).toMatchObject({ ok: false, field: 'benefit' });
    expect(store.getSnapshot().revision).toBe(0);
    okResult(sendMatchedSlot(store, 't'));
    expect(store.dispatch({ ...base, recipientIds: [recipient], idempotencyKey: 's' })).toMatchObject({ ok: false, code: 'CONFLICT' });
  });
  it('any time of day can be scheduled or sent (no night restriction, owner decision 2026-11-20); past and malformed times are still refused', () => {
    expect(NIGHT_SEND_RESTRICTION).toBe(false);
    const store = createWidgetDataStore();
    const night = { type: 'coupon.sendSlot', slotIds: [slot.slotId], benefit: 'percent-10', sendAt: `${TODAY}T21:30` } as const;
    expect(store.dispatch({ ...night, sendAt: `${TODAY}T09:00`, recipientIds: [recipient], idempotencyKey: 'n2' })).toMatchObject({ ok: false, field: 'send_at', messageKey: 'data.marketing.error.sendAtPast' });
    expect(store.dispatch({ ...night, sendAt: `${TODAY} 21:30`, recipientIds: [recipient], idempotencyKey: 'n3' })).toMatchObject({ ok: false, field: 'send_at' });
    // Every regular, whether or not they agreed to night messages, gets the 21:30 send.
    const everyone = [recipient, seed.marketing.mktCustomer.find(row => row.consentSms && !row.consentNight && row.customerId !== recipient)!.customerId];
    expect(store.getSnapshot().tables.marketing.mktCustomer.some((c) => everyone.includes(c.customerId) && !c.consentNight)).toBe(true);
    const ok = okResult(store.dispatch({ ...night, recipientIds: everyone, idempotencyKey: 'n4' }));
    expect(ok.params).toEqual({ count: everyone.length });
    expect(store.getSnapshot().tables.marketing.messageSend.every((s) => s.isNight && s.scheduledAt === `${TODAY}T21:30`)).toBe(true);
  });
  it.each([`${TOMORROW}T03:00`, `${TODAY}T22:00`, `${TODAY}T23:59`])('a send at %s is accepted for the regulars', (sendAt) => {
    const store = createWidgetDataStore();
    okResult(sendMatchedSlot(store, 'late', { sendAt }));
  });
  it('owner edits are stored as raw text; the fixed ad head and opt-out tail are not part of the body', () => {
    const store = createWidgetDataStore();
    okResult(sendMatchedSlot(store, 'e', { messageEdits: '  화요일에 뵈어요  ' }));
    expect(store.getSnapshot().tables.marketing.messageSend[0].body).toEqual({ raw: '화요일에 뵈어요' });
  });
});

describe('sell-today coupon (AC-293·294·315·317, R2 RELAY ⑤)', () => {
  it('text route issues to 151 consenting regulars for today and updates the SMS results', () => {
    const store = createWidgetDataStore();
    const r = okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: 'x1' }));
    expect(r.noticeKey).toBe('data.marketing.notice.couponCreated');
    expect(r.value).toMatchObject({ route: 'sms', issued: 151, sent: true });
    const status = modelOf(store, 'coupon-status');
    expect([status.activeCount, status.endingSoonCount, status.monthUsed]).toEqual([2, 1, 365]);
    const fresh = status.rows.find((x) => x.origin === 'expiry')!;
    expect([fresh.issued, fresh.used, fresh.daysLeft, fresh.benefitValue, fresh.name]).toEqual([151, 0, 0, 40, { key: 'data.marketing.coupon.expiryToday', params: { p: 40 }, keyParams: { item: EXPIRY_NAME } }]);
    expect(store.getSnapshot().tables.marketing.coupon.find((c) => c.origin === 'expiry')?.originRef).toEqual({ itemId: EXPIRY_ITEM });
    expect(modelOf(store, 'marketing-performance').routes.find((x) => x.route === 'sms')).toMatchObject({ issued: 450, used: 223 });
    expect(modelOf(store, 'expiry-coupon').items.find(row => row.itemId === EXPIRY_ITEM)?.handled).toBe(true);
  });
  it('a percent above the 51 limit or outside 1–100 is refused; unknown items and routes are refused', () => {
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 52 }, route: 'sms', idempotencyKey: 'r52' })).toEqual({ ok: false, code: 'VALIDATION', field: 'benefit', messageKey: 'data.marketing.error.overLimit' });
    for (const value of [0, 40.5, 101]) expect(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value }, route: 'sms', idempotencyKey: `r${value}` })).toEqual({ ok: false, code: 'VALIDATION', field: 'benefit', messageKey: 'data.marketing.error.percentRange' });
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: 'i-milk', benefit: { kind: 'percent', value: 10 }, route: 'sms', idempotencyKey: 'm' })).toMatchObject({ ok: false, field: 'itemId' });
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 10 }, route: 'clip' as never, idempotencyKey: 'c' })).toMatchObject({ ok: false, field: 'route' });
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'free' as never, value: 10 }, route: 'sms', idempotencyKey: 'k' })).toEqual({ ok: false, code: 'VALIDATION', field: 'benefit', messageKey: 'data.marketing.error.benefitInvalid' });
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, route: 'sms', idempotencyKey: 'n' } as never)).toMatchObject({ ok: false, field: 'benefit' });
    expect(store.getSnapshot().revision).toBe(0);
    okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 51 }, route: 'sms', idempotencyKey: 'max' }));
  });
  it.each([
    ['percent', 40, { benefitType: 'percent', benefitValue: 40 }, 'data.marketing.coupon.expiryToday', 'data.marketing.sms.expiry', { p: 40 }],
    ['amount', 700, { benefitType: 'amount', benefitValue: 700 }, 'data.marketing.coupon.expiryTodayAmount', 'data.marketing.sms.expiryAmount', { amount: '700' }],
    ['setPrice', 2_800, { benefitType: 'set_price', benefitValue: 2_800 }, 'data.marketing.coupon.expiryTodaySetPrice', 'data.marketing.sms.expirySetPrice', { price: '2,800' }],
  ] as const)('a %s benefit is stored in benefitType + benefitValue only and named, texted and posted in its own words', (kind, value, stored, nameKey, smsKey, nameParams) => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind, value }, route: 'sms', idempotencyKey: `k-${kind}` }));
    const m = store.getSnapshot().tables.marketing;
    const coupon = m.coupon.find((c) => c.origin === 'expiry')!;
    expect(coupon).toMatchObject({ ...stored, originRef: { itemId: EXPIRY_ITEM }, name: { key: nameKey, params: nameParams, keyParams: { item: EXPIRY_NAME } } });
    expect(JSON.stringify(coupon)).not.toMatch(/setPrice/);
    const sends = m.messageSend.filter((x) => x.couponId === coupon.couponId);
    expect(sends).toHaveLength(151);
    expect(sends.every((x) => 'key' in x.body && x.body.key === smsKey && JSON.stringify(x.body.params) === JSON.stringify(nameParams))).toBe(true);
    const row = modelOf(store, 'coupon-status').rows.find((x) => x.origin === 'expiry')!;
    expect([row.benefitType, row.benefitValue]).toEqual([stored.benefitType, stored.benefitValue]);
  });
  it('amount and set price are refused at 0, above the item price, or below the cost', () => {
    const store = createWidgetDataStore();
    const make = (kind: 'amount' | 'setPrice', value: number) => store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind, value }, route: 'sms', idempotencyKey: `${kind}-${value}` });
    expect(make('amount', 0)).toMatchObject({ ok: false, field: 'benefit', messageKey: 'data.marketing.error.amountRange' });
    expect(make('setPrice', 0)).toMatchObject({ ok: false, field: 'benefit', messageKey: 'data.marketing.error.setPriceRange' });
    expect(make('amount', 5_201)).toMatchObject({ ok: false, field: 'benefit', messageKey: 'data.marketing.error.overPrice' });
    expect(make('setPrice', 5_201)).toMatchObject({ ok: false, field: 'benefit', messageKey: 'data.marketing.error.overPrice' });
    expect(make('amount', 2_683)).toMatchObject({ ok: false, field: 'benefit', messageKey: 'data.marketing.error.overLimit' });
    expect(make('setPrice', 2_517)).toMatchObject({ ok: false, field: 'benefit', messageKey: 'data.marketing.error.overLimit' });
    expect(store.getSnapshot().revision).toBe(0);
    okResult(make('amount', 2_682));
  });
  it('the same item cannot get a second sell-today coupon today; the same key replays the first receipt', () => {
    const store = createWidgetDataStore();
    const first = okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: 'first' }));
    const revision = store.getSnapshot().revision;
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: 'first' })).toEqual({ ...first, duplicate: true });
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'amount', value: 500 }, route: 'place_news', idempotencyKey: 'second' })).toEqual({ ok: false, code: 'CONFLICT', field: 'itemId', messageKey: 'data.marketing.error.expiryAlreadyMade' });
    expect(store.getSnapshot().revision).toBe(revision);
    expect(store.getSnapshot().tables.marketing.coupon.filter((c) => c.origin === 'expiry')).toHaveLength(1);
  });
  it('place news counts only after ‘올렸어요’ (10 more issued), once per key', () => {
    const store = createWidgetDataStore();
    const r = okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'place_news', idempotencyKey: 'p1' }));
    const codeId = (r.value as { codeId: string }).codeId;
    expect(modelOf(store, 'marketing-performance').issued).toBe(299);
    const pending = modelOf(store, 'expiry-coupon').pendingPosts;
    expect(pending).toHaveLength(1);
    expect(pending[0].post).toMatchObject({ key: 'data.marketing.post.expiry', params: { p: 40 }, keyParams: { item: EXPIRY_NAME } });
    expect(JSON.stringify(modelOf(store, 'expiry-coupon'))).not.toMatch(/"set"/);
    expect(modelOf(store, 'coupon-status').rows.find((x) => x.origin === 'expiry')?.issued).toBe(0);
    expect(modelOf(store, 'coupon-status').activeCount).toBe(modelOf(store, 'coupon-status').rows.length);
    const posted = okResult(store.dispatch({ type: 'coupon.markPosted', codeId, idempotencyKey: 'post-1' }));
    expect(posted.noticeKey).toBe('data.marketing.notice.counting');
    const perf = modelOf(store, 'marketing-performance');
    expect([perf.issued, perf.routes.find((x) => x.route === 'place_news')?.issued]).toEqual([309, 10]);
    expect(store.dispatch({ type: 'coupon.markPosted', codeId, idempotencyKey: 'post-1' })).toMatchObject({ ok: true, duplicate: true });
    expect(store.dispatch({ type: 'coupon.markPosted', codeId, idempotencyKey: 'post-2' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(store.dispatch({ type: 'coupon.markPosted', codeId: 'cc-thanks-sms', idempotencyKey: 'post-3' })).toMatchObject({ ok: false, field: 'codeId' });
    expect(modelOf(store, 'expiry-coupon').pendingPosts).toEqual([]);
  });
  it('changing cake stock updates the sell-today count and zero stock removes the item', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'inventory.updateItem', itemId: EXPIRY_ITEM, stock: 5 }));
    expect(modelOf(store, 'expiry-coupon').target?.qty).toBe(3);
    expect(modelOf(store, 'expiry-coupon').target?.atRecommended?.ifAllSold).toBe(1_806);
    okResult(store.dispatch({ type: 'inventory.updateItem', itemId: EXPIRY_ITEM, stock: 0 }));
    okResult(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-saltbread', stock: 0 }));
    expect(selectWidget(store.getSnapshot(), 'expiry-coupon', { kind: 'default' }, 'normal')).toEqual({ status: 'empty', featureId: 'expiry-coupon', variant: 'normal', messageKey: 'data.state.expiry-coupon.none' });
    expect(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: 'z' })).toMatchObject({ ok: false, messageKey: 'data.marketing.error.noExpiryStock' });
    // Café seed: both rows expire today and stay outside the replenishment count (PRD F-25).
    expect(modelOf(store, 'inventory-booking').restockCount).toBe(0);
  });
});

describe('reach out to customers who may leave (AC-303·315)', () => {
  it('18 consenting customers → 18 issued as a new coupon line; non-consenting or other groups are refused', () => {
    const store = createWidgetDataStore();
    const g = modelOf(store, 'customer-groups');
    expect(store.dispatch({ type: 'coupon.sendReachOut', recipientIds: [...g.reachOut.recipientIds, g.reachOut.blockedIds[0]], idempotencyKey: 'a' })).toMatchObject({ ok: false, messageKey: 'data.marketing.error.noConsent' });
    expect(store.dispatch({ type: 'coupon.sendReachOut', recipientIds: [recipient], idempotencyKey: 'b' })).toMatchObject({ ok: false, messageKey: 'data.marketing.error.notInGroup' });
    okResult(store.dispatch({ type: 'coupon.sendReachOut', recipientIds: g.reachOut.recipientIds, idempotencyKey: 'c' }));
    const row = modelOf(store, 'coupon-status').rows.find((x) => x.origin === 'group')!;
    expect([row.issued, row.used, row.endsOn, row.endingSoon, row.name]).toEqual([18, 0, addDays(TODAY, 14), false, { key: 'data.marketing.coupon.thanksBackGroup' }]);
    expect(modelOf(store, 'customer-groups').sent).toHaveLength(1);
  });
  it('sell-today and reach-out issue 169 more texts without recording redemptions', () => {
    const store = createWidgetDataStore();
    okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: 'e' }));
    okResult(store.dispatch({ type: 'coupon.sendReachOut', recipientIds: modelOf(store, 'customer-groups').reachOut.recipientIds, idempotencyKey: 'g' }));
    const perf = modelOf(store, 'marketing-performance');
    expect([perf.issued, perf.used, perf.rate]).toEqual([468, 223, 48]);
    expect(perf.routes.find((x) => x.route === 'sms')).toMatchObject({ issued: 468, used: 223, rate: 48 });
    const status = modelOf(store, 'coupon-status');
    expect([status.activeCount, status.endingSoonCount, status.runningUsed, status.endedUsed, status.monthUsed]).toEqual([3, 1, 223, 142, 365]);
  });
});

describe('active coupons: reminder, pause, resume, extend (AC-300)', () => {
  it('reminder records mock sends only and keeps every number', () => {
    const store = createWidgetDataStore();
    const issued = okResult(sendMatchedSlot(store, 'reminder-audience'));
    const { couponId: campaign } = issued.value as { couponId: string };
    const before = modelOf(store, 'coupon-status');
    const r = okResult(store.dispatch({ type: 'coupon.notifyEnding', couponId: campaign, idempotencyKey: 'n' }));
    expect([r.noticeKey, r.params]).toEqual(['data.notice.sent', { count: 1 }]);
    expect(modelOf(store, 'coupon-status').rows).toEqual(before.rows);
    expect(store.dispatch({ type: 'coupon.notifyEnding', couponId: campaign, idempotencyKey: 'n' })).toMatchObject({ ok: true, duplicate: true });
    expect(store.getSnapshot().tables.marketing.couponReminder).toHaveLength(1);
    // The seed campaign has no explicit text targets.
    expect(store.dispatch({ type: 'coupon.notifyEnding', couponId: active.couponId, idempotencyKey: 'n2' })).toMatchObject({ ok: false, code: 'VALIDATION', reason: 'NO_REMINDER_RECIPIENTS' });
    expect(store.getSnapshot().tables.marketing.couponReminder).toHaveLength(1);
    expect(store.dispatch({ type: 'coupon.notifyEnding', couponId: ended.couponId, idempotencyKey: 'n3' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(store.dispatch({ type: 'coupon.notifyEnding', couponId: 'nope', idempotencyKey: 'n4' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
  it('pause and resume the running cafe campaign; extending and undoing preserve redemption totals', () => {
    const store = createWidgetDataStore();
    const paused = okResult(store.dispatch({ type: 'coupon.pause', couponId: active.couponId }));
    expect(paused.noticeKey).toBe('data.marketing.notice.paused');
    expect(paused.value).toEqual({ couponId: active.couponId, name: active.name });
    let s = modelOf(store, 'coupon-status');
    expect([s.activeCount, s.runningUsed, s.monthUsed, s.rows.find((x) => x.couponId === active.couponId)?.status]).toEqual([0, 223, 365, 'paused']);
    expect(s.pausedCount).toBe(1);
    expect(store.dispatch({ type: 'coupon.notifyEnding', couponId: active.couponId, idempotencyKey: 'p' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    okResult(store.undo(paused.undoToken!));
    expect(modelOf(store, 'coupon-status').activeCount).toBe(1);
    const extended = okResult(store.dispatch({ type: 'coupon.extend', couponId: active.couponId }));
    expect(extended.params).toEqual({ days: 7 });
    s = modelOf(store, 'coupon-status');
    expect(s.rows.find((x) => x.couponId === active.couponId)).toMatchObject({ endsOn: addDays(active.endsOn, 7), daysLeft: 20, endingSoon: false });
    expect([s.endingSoonCount, s.monthUsed]).toEqual([0, 365]);
    okResult(store.undo(extended.undoToken!));
    expect(modelOf(store, 'coupon-status').rows.find((x) => x.couponId === active.couponId)?.daysLeft).toBe(13);
    okResult(store.dispatch({ type: 'coupon.pause', couponId: active.couponId }));
    expect(store.dispatch({ type: 'coupon.pause', couponId: active.couponId })).toMatchObject({ ok: false, code: 'CONFLICT' });
    okResult(store.dispatch({ type: 'coupon.resume', couponId: active.couponId }));
    expect(store.dispatch({ type: 'coupon.resume', couponId: active.couponId })).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(store.dispatch({ type: 'coupon.extend', couponId: ended.couponId })).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(modelOf(store, 'marketing-performance').used).toBe(223);
  });
});

it('syncs the cafe storefront metadata with photos and preserves cafe identity on a legacy refresh', () => {
  const store = createWidgetDataStore();
  const cafe = seed.marketing.promoStore[0];
  const catalog = {
    sourceId: 'cafe', store: { name: cafe.name, location: cafe.location, exteriorPhotoId: 'test-storefront', exteriorUrl: '/test/storefront' },
    menus: [{ menuId: PHOTO_MENU, names: seed.marketing.promoMenu.find(row => row.menuId === PHOTO_MENU)!.names, photoIds: photoRows.map(row => row.photoId) }],
    photos: photoRows,
  };
  okResult(store.dispatch({ type: 'promo.syncCatalog', catalog }));
  const synced = store.getSnapshot();
  expect(synced.tables.marketing.promoStore[0]).toEqual({ ...catalog.store, sourceId: 'cafe' });
  expect(synced.tables.marketing.promoMenu).toBe(seed.marketing.promoMenu);
  okResult(store.dispatch({ type: 'promo.syncCatalog', catalog }));
  expect(store.getSnapshot()).toBe(synced);
  okResult(store.dispatch({ type: 'promo.syncCatalog', catalog: { ...catalog, sourceId: 'legacy', store: { ...catalog.store, name: '옛 매장' } } }));
  expect(store.getSnapshot().tables.marketing.promoStore[0]).toEqual(synced.tables.marketing.promoStore[0]);
});

describe('AI promo video: posted video and the clip coupon (AC-337·345~347·318, 10.15.7 regression)', () => {
  it('save preserves state and a Clip post issues ten codes on the active cafe campaign', () => {
    const store = withPhotos();
    const videoId = makeDone(store);
    const code = (route: string) => modelOf(store, 'marketing-performance').routes.find((x) => x.route === route)?.issued;
    expect(modelOf(store, 'marketing-performance').issued).toBe(299);
    const revision = store.getSnapshot().revision;
    expect(okResult(store.dispatch({ type: 'video.save', videoId })).noticeKey).toBe('data.marketing.notice.saveStarted');
    expect(store.getSnapshot().revision).toBe(revision);
    expect(code('clip')).toBe(0);
    okResult(store.dispatch({ type: 'video.markPosted', videoId, route: 'clip', idempotencyKey: 'post' }));
    const perf = modelOf(store, 'marketing-performance');
    expect([perf.issued, perf.used, perf.rate, code('clip')]).toEqual([309, 223, 72, 10]);
    expect(perf.byVideo).toEqual([{ videoId, couponId: active.couponId, postedRoute: 'clip', issued: 10, used: 0, rate: 0 }]);
    expect(modelOf(store, 'coupon-status').rows.find((x) => x.couponId === active.couponId)).toMatchObject({ used: 223, issued: 309 });
    const after = modelOf(store, 'promo-video');
    expect([after.postedCount, after.lastPostedRoute, after.lastPostedCounting, after.state]).toEqual([1, 'clip', true, 'posted']);
    expect(modelOf(store, 'marketing-today').folded).toEqual(['week']);
    expect(store.dispatch({ type: 'video.markPosted', videoId, route: 'clip', idempotencyKey: 'post2' })).toMatchObject({ ok: false, code: 'CONFLICT' });
  });
  it('shorts and reels add the video but no clip code (Q-45, AC-347); a second clip video adds one more code', () => {
    const store = withPhotos();
    okResult(store.dispatch({ type: 'video.markPosted', videoId: makeDone(store, 'a'), route: 'clip', idempotencyKey: 'p1' }));
    okResult(store.dispatch({ type: 'video.markPosted', videoId: makeDone(store, 'b'), route: 'shorts', idempotencyKey: 'p2' }));
    const mid = modelOf(store, 'promo-video');
    expect([mid.postedCount, mid.lastPostedRoute, mid.lastPostedCounting]).toEqual([2, 'shorts', false]);
    expect(modelOf(store, 'marketing-performance').routes.find((x) => x.route === 'clip')?.issued).toBe(10);
    okResult(store.dispatch({ type: 'video.markPosted', videoId: makeDone(store, 'c'), route: 'clip', idempotencyKey: 'p3' }));
    expect(modelOf(store, 'marketing-performance').routes.find((x) => x.route === 'clip')?.issued).toBe(20);
  });
  it('a posted video is not the same as a made one: the route is required and only a finished video can be posted', () => {
    const store = withPhotos();
    const made = okResult(store.dispatch({ type: 'video.make', input: inputOf(store, 5, { menuIds: [PHOTO_MENU] }), idempotencyKey: 'x' }));
    const videoId = (made.value as { videoId: string }).videoId;
    expect(store.dispatch({ type: 'video.markPosted', videoId, route: 'clip', idempotencyKey: 'y' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    okResult(store.dispatch({ type: 'video.settle', videoId, outcome: { kind: 'failed', reason: 'AI_TIMEOUT' } }));
    expect(store.dispatch({ type: 'video.markPosted', videoId, route: 'x' as never, idempotencyKey: 'z' })).toMatchObject({ ok: false, field: 'route' });
    expect(store.dispatch({ type: 'video.save', videoId })).toMatchObject({ ok: false, code: 'CONFLICT' });
  });
  it('replies lower the cafe task count and leave photo material independent of praise (AC-318)', () => {
    const [praise, review] = seed.inquiryThread.filter(row => row.type === 'review' && row.isPublic);
    const thread = seed.inquiryThread.find(row => row.type === 'message' && row.status === 'waiting')!;
    const inquiryThread = seed.inquiryThread.map(row => row === praise ? { ...row, sentiment: 'positive' as const, status: 'done' as const } : row);
    const store = createWidgetDataStore({ marketing: { ...seed.marketing, promoPhoto: photoRows }, inquiryThread });
    okResult(store.dispatch({ type: 'inquiry.send', threadId: thread.threadId, idempotencyKey: 's' }));
    expect(modelOf(store, 'marketing-today').cells.find((c) => c.slot === 'today')?.params).toEqual({ count: modelOf(store, 'ai-response').waitingCount });
    expect(modelOf(store, 'ai-response').waitingCount).toBe(46);
    okResult(store.dispatch({ type: 'inquiry.post', threadId: review.threadId, idempotencyKey: 'r' }));
    expect(modelOf(store, 'ai-response').praiseCount).toBe(31);
    expect(modelOf(store, 'promo-video').praiseCount).toBe(31);
    expect(modelOf(store, 'promo-video').materialsCount).toBe(10);
    expect(modelOf(store, 'marketing-today').cells.find((c) => c.slot === 'today')?.params).toEqual({ count: 45 });
    expect(modelOf(store, 'marketing-today').cells.find((c) => c.slot === 'week')?.params).toEqual({ photos: 10 });
  });
});

describe('today’s promotions fold away when everything is handled (AC-287)', () => {
  it('after all slots, expiry items, replies and a posted video: empty with the active-coupons action', () => {
    const inquiryThread = seed.inquiryThread.filter(row => row.type !== 'call' && (row.type !== 'review' || row.isPublic));
    const store = createWidgetDataStore({ marketing: { ...seed.marketing, promoPhoto: photoRows }, inquiryThread });
    const slot = modelOf(store, 'slot-coupon');
    okResult(store.dispatch({ type: 'coupon.sendSlot', slotIds: slot.openSlots.map((s) => s.slotId), recipientIds: slot.recipients.map((r) => r.customerId), benefit: 'percent-10', idempotencyKey: '1' }));
    okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: '2' }));
    okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: 'i-saltbread', benefit: { kind: 'percent', value: 40 }, route: 'sms', idempotencyKey: '2b' }));
    for (const th of modelOf(store, 'ai-response').priority) okResult(store.dispatch({ type: th.type === 'review' ? 'inquiry.post' : 'inquiry.send', threadId: th.threadId, idempotencyKey: th.threadId }));
    okResult(store.dispatch({ type: 'video.markPosted', videoId: makeDone(store, '3'), route: 'reels', idempotencyKey: '4' }));
    expect(selectWidget(store.getSnapshot(), 'marketing-today', { kind: 'default' }, 'normal')).toEqual({ status: 'empty', featureId: 'marketing-today', variant: 'normal', messageKey: 'data.state.marketing-today.none', actionKey: 'data.marketing.action.viewActiveCoupons' });
  });
});

describe('determinism (no clock, no randomness, no device timezone)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('the same commands on two stores give identical snapshots and views', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now used'); });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used'); });
    const runAll = () => {
      const store = withPhotos();
      okResult(sendMatchedSlot(store, 'a'));
      okResult(store.dispatch({ type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 40 }, route: 'place_news', idempotencyKey: 'b' }));
      makeDone(store, 'c');
      return store;
    };
    const a = runAll(), b = runAll();
    expect(JSON.stringify(a.getSnapshot())).toBe(JSON.stringify(b.getSnapshot()));
    for (const id of ['marketing-today', 'slot-coupon', 'expiry-coupon', 'promo-video', 'coupon-status', 'customer-groups', 'marketing-performance'] as const) {
      expect(JSON.stringify(selectWidget(a.getSnapshot(), id, { kind: 'default' }, 'normal'))).toBe(JSON.stringify(selectWidget(b.getSnapshot(), id, { kind: 'default' }, 'normal')));
    }
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });
});

describe('once keys (DATA_MODEL 10.15.4 ‘한 번만 키: 예’)', () => {
  it('every once-command needs a key, and the same key twice applies once', () => {
    const store = withPhotos();
    const g = modelOf(store, 'customer-groups');
    const videoId = makeDone(store, 'mk');
    const commands = [
      { type: 'coupon.sendSlot', slotIds: [slot.slotId], recipientIds: regulars(), benefit: 'percent-10' },
      { type: 'coupon.createExpiry', itemId: EXPIRY_ITEM, benefit: { kind: 'percent', value: 30 }, route: 'place_news' },
      { type: 'coupon.markPosted', codeId: '' },
      { type: 'coupon.sendReachOut', recipientIds: g.reachOut.recipientIds },
      { type: 'coupon.notifyEnding', couponId: '' },
      { type: 'video.make', input: inputOf(store, 6, { moods: ['lively'], menuIds: [PHOTO_MENU] }) },
      { type: 'video.markPosted', videoId, route: 'clip' },
    ] as const;
    let postCodeId = '';
    let campaign = '';
    for (const base of commands) {
      const c = base.type === 'coupon.markPosted' ? { ...base, codeId: postCodeId } : base.type === 'coupon.notifyEnding' ? { ...base, couponId: campaign } : base;
      expect(store.dispatch(c as never), c.type).toMatchObject({ ok: false, code: 'VALIDATION', field: 'idempotencyKey' });
      const first = okResult(store.dispatch({ ...c, idempotencyKey: `once-${c.type}` } as never));
      if (c.type === 'coupon.sendSlot') campaign = (first.value as { couponId: string }).couponId;
      if (c.type === 'coupon.createExpiry') postCodeId = (first.value as { codeId: string }).codeId;
      const revision = store.getSnapshot().revision;
      expect(store.dispatch({ ...c, idempotencyKey: `once-${c.type}` } as never), c.type).toEqual({ ...first, duplicate: true });
      expect(store.getSnapshot().revision, c.type).toBe(revision);
    }
    const m = store.getSnapshot().tables.marketing;
    expect([m.coupon.length, m.promoVideo.length, m.couponReminder.length]).toEqual([5 + 3, 2, 1]);
  });
});

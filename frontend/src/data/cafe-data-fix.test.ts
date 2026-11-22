import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../i18n';
import { getPaymentBillId, quotePaymentBill } from '../pos/loyalty';
import { setup } from '../pos/loyalty/test-setup';
import { selectReceipt } from '../pos/reversals';
import { seedCatalog } from './db/generated/catalog';
import { MONTH_START, TODAY } from './db/time';
import { dataBundles } from './messages';
import { createWidgetDataStore, deriveStock, readModel, resolveDataText, selectWidget, widgetFacts } from './widget-data';

const store = createWidgetDataStore();
const snapshot = store.getSnapshot();
const ko = createTranslator('ko', ...dataBundles);
const getText = (value: Parameters<typeof resolveDataText>[1]) => resolveDataText(ko.t, value);

describe('cafe data fixes', () => {
  it('charges for a seeded shot, deducts only the base recipe, and records the shot in the receipt', () => {
    const h = setup();
    const menu = h.pos.read().data.catalog.items.find(m => m.menuId === 'm-americano')!;
    const options = menu.groups.flatMap(group => group.options);
    const shot = options.find(o => o.name === '에스프레소 1샷');
    expect(shot).toMatchObject({ extraPrice: 500, extraRecipe: [] });
    const optionIds = ['HOT', '레귤러', '에스프레소 1샷'].map(name => options.find(o => o.name === name)!.optionId);
    const stock = () => new Map(deriveStock(h.data.getSnapshot(), { date: TODAY }).rows.map(row => [row.itemId, row.rawBase]));
    const before = stock();
    expect(h.pos.execute({ type: 'cart.add', menuId: menu.menuId, qty: 1, optionIds, meta: h.meta() }).ok).toBe(true);
    const billId = getPaymentBillId(h.pos.read());
    const quote = quotePaymentBill(h.pos.read(), billId);
    expect(h.pos.beginApproval({ billId, quoteRevision: quote.revision, splits: [{ method: 'card', amount: 3500 }], meta: h.meta() }).ok).toBe(true);
    expect(h.finish().ok).toBe(true);
    const after = stock();
    for (const [id, qty] of before) {
      expect(after.get(id)).toBe(qty - (menu.recipeBase.find(part => part.itemId === id)?.quantityBase ?? 0));
    }
    const paymentId = h.pos.read().pos.payments.at(-1)!.paymentId;
    expect(selectReceipt(h.pos.read(), { paymentId })).toMatchObject({ amount: 3500, lines: [{ amount: 3500, options: expect.arrayContaining([expect.objectContaining({ name: '에스프레소 1샷', extraPrice: 500 })]) }] });
  });

  it('supplies a JPEG for each of the 25 café menu entries and the acceptance memo', () => {
    const menu = readModel(snapshot, 'menu');
    expect(menu.rows).toHaveLength(25);
    expect(menu.rows.map(row => row.menuId).sort()).toEqual(seedCatalog.menu.map(row => row.menuId).sort());
    for (const { menuId, customPhotoUrl } of menu.rows) {
      const photoUrl = `/menu-photos/cafe-${menuId.slice(2)}-01.jpeg`;
      expect(customPhotoUrl, menuId).toBe(photoUrl);
      expect(readFileSync(`public${photoUrl}`).subarray(0, 2).toString('hex'), photoUrl).toBe('ffd8');
    }
    expect(getText(menu.rows.find(row => row.menuId === 'm-cafe-latte')?.memo)).toBe('우유는 매일 아침 한강목장 유업유통');
  });

  it('deducts one finished strawberry cake slice after a paid sale', () => {
    const h = setup();
    const menu = h.pos.read().data.catalog.items.find(row => row.menuId === 'm-strawberry-cake')!;
    const available = () => deriveStock(h.data.getSnapshot(), { date: TODAY }).rows
      .find(row => row.itemId === 'i-strawberry-cake-slice')?.rawBase;
    expect(menu).toMatchObject({ price: 6500, unitCost: 2420 });
    expect(available()).toBe(6);
    expect(h.pos.execute({ type: 'cart.add', menuId: menu.menuId, qty: 1, optionIds: [], meta: h.meta() }).ok).toBe(true);
    const billId = getPaymentBillId(h.pos.read());
    const { revision } = quotePaymentBill(h.pos.read(), billId);
    expect(h.pos.beginApproval({ billId, quoteRevision: revision, splits: [{ method: 'card', amount: 6500 }], meta: h.meta() }).ok).toBe(true);
    expect(h.finish().ok).toBe(true);
    expect(available()).toBe(5);
  });

  it('deducts one tracked bakery piece after a paid sale', () => {
    const h = setup();
    const menu = h.pos.read().data.catalog.items.find(row => row.menuId === 'm-saltbread')!;
    const available = () => deriveStock(h.data.getSnapshot(), { date: TODAY }).rows
      .find(row => row.itemId === 'i-saltbread')?.rawBase;
    expect(available()).toBe(12);
    const optionIds = [menu.groups[0].options[0].optionId];
    expect(h.pos.execute({ type: 'cart.add', menuId: menu.menuId, qty: 1, optionIds, meta: h.meta() }).ok).toBe(true);
    const billId = getPaymentBillId(h.pos.read());
    const { revision } = quotePaymentBill(h.pos.read(), billId);
    expect(h.pos.beginApproval({ billId, quoteRevision: revision, splits: [{ method: 'card', amount: 3200 }], meta: h.meta() }).ok).toBe(true);
    expect(h.finish().ok).toBe(true);
    expect(available()).toBe(11);
  });

  it('classifies 40 reviews and shares the praise count with promo facts', () => {
    const response = readModel(snapshot, 'ai-response');
    const reviews = response.threads.filter(row => row.type === 'review');
    expect(['positive', 'neutral', 'negative'].map(sentiment => reviews.filter(row => row.sentiment === sentiment).length)).toEqual([31, 5, 4]);
    expect(response.praiseCount).toBe(31);
    expect(widgetFacts(selectWidget(snapshot, 'promo-video', { kind: 'default' }, 'normal'))).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'video.praiseReviews', value: 31 })]));
  });

  it('flags personal and ungrounded requests, and leaves already handled threads out of priority', () => {
    const response = readModel(snapshot, 'ai-response');
    const find = (match: string) => response.threads.find(row => getText(row.body).includes(match));
    expect(find('연락처 010')).toMatchObject({ needsPersonReason: 'privacy' });
    expect(find('지출증빙용')).toMatchObject({ needsPersonReason: 'privacy' });
    expect(find('동아리 회의용')).toMatchObject({ needsPersonReason: 'no-ground' });
    expect(find('더 일찍 여시나요')).toMatchObject({ needsPersonReason: null, waiting: false });
    expect(response.priority[0].needsPersonReason).not.toBeNull();
  });

  it('uses translated event timing labels and keeps one direct offer with a browse catalog', () => {
    const changes = readModel(snapshot, 'local-changes').changes;
    for (const change of changes) {
      expect(change.whenKey).toMatch(/^data\.localChange\.when\./);
      expect(ko.t(change.whenKey)).not.toMatch(/^\d{4}-/);
      expect(ko.has(change.whenKey)).toBe(true);
    }
    const community = readModel(snapshot, 'community');
    expect(community.pendingCount).toBe(1);
    expect(community.publicOffers).toHaveLength(3);
    expect(community.publicOffers.every(row => row.period.start > TODAY && row.period.end >= row.period.start)).toBe(true);
  });

  it('carries the demo dates in each slot SMS and projects two blocked seeded members only in the mixed preview', () => {
    const slot = readModel(snapshot, 'slot-coupon');
    for (const body of Object.values(slot.message.bodies)) {
      expect(body).toHaveProperty('params.startDay', 18);
      expect(getText(body)).toContain('11월 18일~11월 24일');
      expect(getText(body)).toContain('11월 30일까지');
    }
    const mixed = selectWidget(snapshot, 'slot-coupon', { kind: 'default' }, 'consent-mixed');
    expect(mixed.status).toBe('ready');
    if (mixed.status !== 'ready') throw new Error('Missing consent preview');
    expect(mixed.model.regularsCount).toBe(slot.regularsCount);
    const blocked = mixed.model.recipients.filter(row => !row.selectable);
    expect(blocked).toHaveLength(2);
    for (const row of blocked) {
      expect(snapshot.tables.memberProfile.some(member => member.customerId === row.customerId)).toBe(true);
      expect(row).toMatchObject({ consentSms: false, reasonKey: 'data.marketing.error.noConsent' });
    }
  });

  it('lists only this month’s ended coupons and uses November redemptions in the sum and rows', () => {
    const status = readModel(snapshot, 'coupon-status');
    expect(status).toMatchObject({ runningUsed: 223, endedUsed: 142, monthUsed: 365 });
    expect(status.ended.map(row => [getText(row.name), row.endsOn, row.used])).toEqual([['가을 신메뉴 800원 체험 쿠폰', '2026-11-12', 142]]);
    expect(status.ended.every(row => row.endsOn >= MONTH_START)).toBe(true);
    expect(status.monthUsed).toBe(status.runningUsed + (status.endedUsed ?? 0));
  });

  it('includes a named pause toast, with the existing undo token', () => {
    const localStore = createWidgetDataStore();
    const coupon = readModel(localStore.getSnapshot(), 'coupon-status').rows[0];
    const result = localStore.dispatch({ type: 'coupon.pause', couponId: coupon.couponId });
    expect(result).toMatchObject({ ok: true, params: { name: getText(coupon.name) }, undoToken: expect.any(String) });
    if (!result.ok || !result.noticeKey) throw new Error('Missing pause notice');
    expect(ko.t(result.noticeKey, result.params)).toContain(getText(coupon.name));
  });

  it('uses the real matched audience for Today’s Promotion and exposes missing campaign attribution', () => {
    const slot = readModel(snapshot, 'slot-coupon');
    const quiet = readModel(snapshot, 'marketing-today').cells.find(cell => cell.kind === 'quiet-hours');
    expect(slot.regularsCount).toBe(1);
    expect(quiet).toMatchObject({ params: { regulars: 1 }, quietSlot: { slotId: slot.openSlots.find(row => row.regularIds.length > 0)?.slotId } });
    const performance = selectWidget(snapshot, 'marketing-performance', { kind: 'default' }, 'normal');
    expect(performance).toMatchObject({ model: { returnRate: null, returnRateDelta: null } });
    expect(widgetFacts(performance).some(fact => fact.key === 'perf.returnRate')).toBe(false);
  });

  it('shows the approved café photos, and saved drafts cannot bypass the minimum photo count', () => {
    expect(readModel(snapshot, 'promo-video')).toMatchObject({ photoCount: 177, materialsCount: 177, state: 'before' });
    const marketing = snapshot.tables.marketing;
    const few = createWidgetDataStore({ marketing: { ...marketing, promoPhoto: marketing.promoPhoto.slice(0, 4) } }).getSnapshot();
    expect(selectWidget(few, 'promo-video', { kind: 'default' }, 'normal')).toMatchObject({ status: 'empty', messageKey: 'data.state.promo-video.few-photos' });
  });

  it('creates a title-only manual, keeps empty steps on update, and returns a deletion notice', () => {
    const localStore = createWidgetDataStore();
    const created = localStore.dispatch({ type: 'manuals.create', section: 'handover', title: '시험기간 안내', category: 'cleaning', steps: [], idempotencyKey: 'cafe-data-fix-title' });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error('Manual was not saved');
    const { manualId } = created.value as { manualId: string };
    expect(localStore.dispatch({ type: 'manuals.update', manualId, patch: { steps: [] } }).ok).toBe(true);
    expect(localStore.getSnapshot().tables.manualStep.some(row => row.manualId === manualId)).toBe(false);
    expect(localStore.dispatch({ type: 'manuals.delete', manualId })).toMatchObject({ ok: true, noticeKey: 'data.management.notice.deleted' });
  });

  it('supplies a changing environment trend from opening until the current seeded reading', () => {
    const environment = snapshot.tables.storeEnvironment;
    const trend = environment.readings;
    expect(trend).toHaveLength(32);
    expect(trend[0].measuredAt).toBe(`${TODAY}T08:00`);
    expect(trend.at(-1)).toEqual(environment.current);
    expect(environment.current).toMatchObject({ measuredAt: `${TODAY}T15:45`, temperatureC: 22.4, humidityPct: 47 });
    expect(new Set(trend.map(row => row.temperatureC)).size).toBeGreaterThan(1);
    expect(new Set(trend.map(row => row.humidityPct)).size).toBeGreaterThan(1);
  });

  it('uses the extracted booking time and party size in all call summary translations', () => {
    const call = snapshot.tables.callLog.find(row => row.callId === 'sample-call-over-capacity')!;
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const text = resolveDataText(createTranslator(locale, ...dataBundles).t, call.summary);
      expect(text).toContain(call.extracted.time);
      expect(text).toContain(String(call.extracted.party));
    }
  });
});

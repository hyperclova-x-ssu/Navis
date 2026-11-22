import '../../../ui/test-setup';
import { cleanup, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { ExpiryCouponDetail } from '../../../features/widgets/mkt-coupon/expiry-coupon';
import { SlotCouponDetail } from '../../../features/widgets/mkt-coupon/slot-coupon';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore } from '../../db/store';
import { selectWidget } from '../../models/select';
import { createRealPort, type DomainAdapter } from '../00';
import { fakeBackend, reply } from '../00/testing';
import { groupsAdapter } from '../19/adapter';
import { groupsService } from '../19/testing';

const day = '2026-11-22', asOf = day + 'T03:00:00Z';
const page = (items: readonly unknown[]) => ({ items, nextCursor: null, asOf, businessDate: day, sourceRevision: 1 });
const source = ['slot-coupon', 'expiry-coupon', 'coupon-status'];
const receipt = { resourceId: 'coupon-1', receiptId: 'receipt-1', revision: 8, affectedSources: source,
  changed: true, undoUntil: new Date(Date.now() + 6000).toISOString() };
const coupon = { couponId: 'coupon-1', origin: 'slot', name: '빈 시간 10% 할인', benefitType: 'percent',
  benefitValue: 10, targetRef: null, validHours: [{ weekday: 1, startHour: 10, endHour: 11 }],
  startsOn: day, endsOn: '2026-12-05', status: 'active', daysLeft: 13, endingSoon: false,
  revision: 7, businessDate: day, createdAt: asOf, originRef: { slotIds: [] }, basis: null, futureIssueCount: null,
  reminderTargets: 1, issued: 2, used: 1, discountSum: 300, canPause: true, canResume: false, canExtend: true,
  canEnd: true, canNotify: false, codes: [{ codeId: 'code-1', code: 'SM-TEST', route: 'sms', issueCount: 2,
    activated: true, activatedAt: asOf, unpublishedAt: null, issuedTerms: null, used: 1, discountSum: 300, revision: 1 }] };

async function harness(configure?: (backend: ReturnType<typeof fakeBackend>) => void, groups = false) {
  const adapters = Object.values(import.meta.glob<{ couponsAdapter: DomainAdapter }>('./adapter.ts', { eager: true }))
    .map(module => module.couponsAdapter);
  const backend = groups ? groupsService().backend : fakeBackend();
  if (groups) adapters.push(groupsAdapter);
  backend.on('GET', '/marketing/coupons', () => page([coupon]));
  backend.on('GET', '/marketing/coupons/usage', () => ({ issued: 2, used: 1, asOf, sourceRevision: 2 }));
  backend.on('GET', '/marketing/naver-coupons', () => reply(503, { code: 'SERVICE_UNAVAILABLE', reason: 'NAVER_COUPONS_UNAVAILABLE' }));
  backend.on('GET', '/inventory/items', () => page([{ itemId: 'item-1', name: '당일 빵', unit: 'pcs' }]));
  backend.on('GET', '/inventory/menu', ({ query }) => Number(query.limit) > 100
    ? reply(400, { code: 'INVALID_REQUEST', field: 'limit' })
    : page([{ menuId: 'menu-1', name: '당일 빵', price: 4000, unitCost: 1500, groups: [], saleStatus: 'selling', recipeLines: [{ itemId: 'item-1', quantity: 1 }] }]));
  backend.on('GET', '/inventory/stock-batches', () => page([{ batchId: 'batch-1', itemId: 'item-1', remainingQuantityBase: '3', expiresOn: day, discardedAt: null }]));
  backend.on('GET', '/customers', () => page([]));
  backend.on('GET', '/pos/coupon-sales', () => ({ businessDate: day, hours: [], visits: [], menuFrequency: [], soldToday: [] }));
  configure?.(backend);
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters, source: () => 'http' });
  store.bindReal(port);
  await port.load('coupons');
  if (groups) await port.load('groups');
  return { store, port, backend };
}

afterEach(cleanup);

describe('real marketing coupon port', () => {
  it('replaces seeded codes, preserves other marketing fields and clears the scoped ledger', async () => {
    const { store, port } = await harness();
    expect(store.getSnapshot().tables.marketing.coupon.map(row => row.couponId)).toEqual(['coupon-1']);
    expect(store.getSnapshot().tables.marketing.promoMenu.length).toBeGreaterThan(0);
    expect(selectWidget(store.getSnapshot(), 'coupon-status', { kind: 'default' }, 'normal')).toMatchObject({
      status: 'ready', model: { activeCount: 1, monthUsed: 1, rows: [{ reminderRecipients: 1, routes: [{ code: 'SM-TEST' }] }] },
    });
    port.reset();
    expect(store.getSnapshot().tables.marketing.coupon).toEqual([]);
    expect(store.getSnapshot().tables.marketing.promoMenu.length).toBeGreaterThan(0);
  });

  it('uses the server revision, keeps a single in-flight key and undoes the stored receipt', async () => {
    const { store, port, backend } = await harness();
    backend.on('POST', '/marketing/coupons/coupon-1/pause', () => receipt);
    backend.on('POST', '/marketing/coupons/receipts/receipt-1/undo', () => ({ ...receipt, receiptId: 'undo-1', undoUntil: undefined }));
    const command = { type: 'coupon.pause' as const, couponId: coupon.couponId };
    const [first, second] = await Promise.all([store.execute(command), store.execute(command)]);
    expect(first).toMatchObject({ ok: true, undoToken: 'real-undo:receipt-1' });
    expect(second).toEqual(first);
    const calls = backend.callsTo('POST', '/marketing/coupons/coupon-1/pause');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ expectedRevision: 7 });
    expect(calls[0].headers.get('idempotency-key')).toBeTruthy();
    await expect(port.undo('real-undo:receipt-1')).resolves.toMatchObject({ ok: true });
    expect(backend.callsTo('GET', '/marketing/coupons')).toHaveLength(3);
  });

  it('uses the real expiring lot and server cost in the stable item command', async () => {
    const { store, backend } = await harness();
    expect(selectWidget(store.getSnapshot(), 'expiry-coupon', { kind: 'default' }, 'normal')).toMatchObject({
      status: 'ready', model: { target: { itemId: 'item-1', qty: 3, unitCost: 1500 }, routes: { placeNews: { issueLimit: 3 } } },
    });
    backend.on('POST', '/marketing/coupons/expiry', () => receipt);
    await expect(store.execute({ type: 'coupon.createExpiry', itemId: 'item-1',
      benefit: { kind: 'amount', value: 500 }, route: 'place_news', idempotencyKey: 'create-1' })).resolves.toMatchObject({ ok: true });
    expect(backend.callsTo('POST', '/marketing/coupons/expiry')[0]?.body).toEqual({
      itemId: 'item-1', batchId: 'batch-1', menuId: 'menu-1', benefit: { kind: 'amount', value: 500 }, route: 'place_news',
    });
  });

  it.each([
    { status: 'no_data', results: [] },
    { status: 'ready', results: [{ scope: 'menu', targetId: 'menu-1', expected: '8' }], stale: true },
  ])('keeps expiry estimates partial until a current forecast is read (%j)', async initial => {
    const forecastPath = `/inventory/forecasts/${day}/weekday-4w-v1`;
    const { backend, store, port } = await harness(backend => {
      backend.on('GET', forecastPath, () => ({ targetDate: day, ...initial }));
    });
    expect(store.getSnapshot().tables.realCoupons).toMatchObject({ missing: ['expiry-coupon'], expiry: { target: { qty: 3 } } });
    backend.on('GET', forecastPath, () => ({ targetDate: day, status: 'ready',
      results: [{ scope: 'menu', targetId: 'menu-1', expected: '1' }] }));

    await port.retry('coupons');
    expect(store.getSnapshot().tables.realCoupons).toMatchObject({ missing: [], expiry: { target: { qty: 2 } } });
    expect(backend.callsTo('GET', forecastPath)).toHaveLength(2);
    expect(backend.calls.filter(call => call.method !== 'GET' && !call.path.startsWith('/api/v1/auth'))).toEqual([]);
  });

  it('builds both coupons from one bounded POS read and shares the recommended quiet slot', async () => {
    const todayRecommendation = { slotId: 'slot-2026-11-23-19', date: '2026-11-23', startHour: 19, endHour: 21 };
    const { store, backend } = await harness(backend => {
      backend.on('GET', '/pos/bills', ({ query }) => ({ ...page([]), nextCursor: String(Number(query.cursor ?? 0) + 1) }));
      backend.on('GET', '/pos/coupon-sales', () => ({
        businessDate: day,
        hours: [
          { businessDate: '2026-11-02', hour: 19, count: 4 }, { businessDate: '2026-11-09', hour: 19, count: 4 },
          { businessDate: '2026-11-03', hour: 19, count: 54 }, { businessDate: '2026-11-10', hour: 19, count: 58 },
          { businessDate: '2026-11-02', hour: 20, count: 4 }, { businessDate: '2026-11-09', hour: 20, count: 4 },
          { businessDate: '2026-11-03', hour: 20, count: 60 }, { businessDate: '2026-11-10', hour: 20, count: 55 },
        ],
        visits: ['2026-11-02', '2026-11-09'].map(businessDate => ({ businessDate, hour: 19, memberId: 'member-1' })),
        menuFrequency: [{ menuId: 'menu-1', count: 120 }], soldToday: [{ menuId: 'menu-1', quantity: 4 }],
      }));
      backend.on('GET', '/customers', () => page([{ memberId: 'member-1', customerId: 'customer-1', name: '김단골', recentVisitCount: 2,
        consent: { marketingAllowed: true, contactAllowed: true } }]));
      backend.on('GET', `/inventory/forecasts/${day}/weekday-4w-v1`, () => ({ targetDate: day,
        status: 'ready', results: [{ scope: 'menu', targetId: 'menu-1', expected: '5' }] }));
      backend.on('GET', '/marketing/recommendations', () => ({ asOf, businessDate: day, state: 'ready', missing: [],
        cells: [{ slot: 'now', kind: 'quiet-hours', sourceFeatureId: 'slot-coupon', params: { regulars: 1 },
          quietSlot: { ...todayRecommendation, weekday: 1 }, ref: { featureId: 'slot-coupon', view: 'send', itemId: todayRecommendation.slotId } }],
        folded: ['today', 'week'], tapTarget: { featureId: 'slot-coupon', view: 'send' },
      }));
    }, true);
    const tables = store.getSnapshot().tables;
    expect(selectWidget(store.getSnapshot(), 'marketing-today', { kind: 'default' }, 'normal')).toMatchObject({
      status: 'ready', model: { cells: [{ kind: 'quiet-hours', ref: { itemId: todayRecommendation.slotId }, params: { regulars: 1 } }] },
    });
    expect(selectWidget(store.getSnapshot(), 'slot-coupon', { kind: 'default' }, 'normal')).toMatchObject({
      status: 'ready', model: { openSlots: [expect.objectContaining({ ...todayRecommendation, regularIds: ['customer-1'] })], canSend: true },
    });
    expect(selectWidget(store.getSnapshot(), 'expiry-coupon', { kind: 'default' }, 'normal')).toMatchObject({
      status: 'ready', model: { target: { lotId: 'batch-1', qty: 2 }, canCreate: true },
    });
    expect(tables.realCoupons?.missing).toEqual([]);
    expect(backend.callsTo('GET', '/pos/coupon-sales').map(call => call.query)).toEqual([{ businessDate: day }]);
    expect(backend.callsTo('GET', '/inventory/stock-batches').map(call => call.query)).toEqual([{ expiresOn: day, limit: '200' }]);
    expect(backend.callsTo('GET', '/pos/bills')).toHaveLength(0);

    const host: WidgetHost = { layer: 'marketing', openClosing: vi.fn(() => true), resetPreview: vi.fn(), openLinked: vi.fn(),
      openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
    const condition = { kind: 'default' } as const;
    renderWithKit(createElement(SlotCouponDetail, { host, condition, featureId: 'slot-coupon',
      detailRef: { featureId: 'slot-coupon', view: 'send', itemId: todayRecommendation.slotId } }), { store });
    renderWithKit(createElement(ExpiryCouponDetail, { host, condition, featureId: 'expiry-coupon',
      detailRef: { featureId: 'expiry-coupon', itemId: 'batch-1' } }), { store });
    expect(screen.getByRole('heading', { name: /보내기 전 요약/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '쿠폰 만들기' })).toBeTruthy();
    expect(screen.queryByText('일부 자료만 보여드려요')).toBeNull();
    expect(backend.calls.filter(call => call.method !== 'GET' && !call.path.startsWith('/api/v1/auth'))).toEqual([]);
  });
});

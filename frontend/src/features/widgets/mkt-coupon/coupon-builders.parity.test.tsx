/**
 * FIX-RV3 (RV-REALVERIFY-3): the quiet-slot and expiry coupon windows open their original builder in HTTP mode whenever the service data holds a slot or an item,
 * also when the read is partial (the note shows above it). Only a missing slot or item shows the empty sentence, as the sample window does.
 */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/widget-data';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { couponsAdapter } from '../../../data/reality/14/adapter';
import { renderWithKit } from '../../../ui/test-utils';
import { ExpiryCouponDetail } from './expiry-coupon';
import { SlotCouponDetail } from './slot-coupon';

afterEach(cleanup);
const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify() {}, acknowledgeBriefing() {} };
const day = '2026-11-22';
const page = (items: readonly unknown[]) => ({ items, nextCursor: null, asOf: `${day}T06:45:00Z`, businessDate: day, sourceRevision: 1 });

function open(which: 'slot-coupon' | 'expiry-coupon') {
  const store = createWidgetDataStore();
  const condition = { kind: 'default' } as const;
  const backend = fakeBackend();
  backend.on('GET', '/marketing/coupons', () => page([]));
  backend.on('GET', '/customers', () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
  backend.on('GET', '/inventory/items', () => page([{ itemId: 'tart', name: '레몬 타르트', unit: 'pcs' }]));
  backend.on('GET', '/inventory/stock-batches', () => page([{ batchId: 'tart-lot', itemId: 'tart', remainingQuantityBase: '3', expiresOn: day, discardedAt: null }]));
  backend.on('GET', '/inventory/menu', () => page([{ menuId: 'tart-menu', name: '레몬 타르트', price: 4000, unitCost: 1500,
    groups: [], saleStatus: 'selling', recipeLines: [{ itemId: 'tart', quantity: 1 }] }]));
  backend.on('GET', '/pos/coupon-sales', () => ({ businessDate: day, visits: [], soldToday: [], menuFrequency: [{ menuId: 'tart-menu', count: 10 }],
    hours: [['2026-11-02', 4], ['2026-11-09', 4], ['2026-11-03', 54], ['2026-11-10', 58]]
      .map(([businessDate, count]) => ({ businessDate, hour: 19, count })) }));
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [couponsAdapter] });
  store.bindReal(port);
  const Detail = which === 'slot-coupon' ? SlotCouponDetail : ExpiryCouponDetail;
  return { ...renderWithKit(<Detail featureId={which} condition={condition} detailRef={{ featureId: which }} host={host} />, { store }), backend };
}

it('renders the POS quiet-slot builder during a customer read failure and disables sending', async () => {
  const { container, backend } = open('slot-coupon');
  expect(await screen.findByRole('heading', { name: /빈 시간/ })).toBeInTheDocument();
  for (const step of ['보낼 손님', '혜택', '문구']) expect(screen.getByRole('heading', { name: new RegExp(step) })).toBeInTheDocument();
  expect(container.querySelector('.mkt-columns')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: '월 19~20시' })).toBeInTheDocument();
  expect(screen.getByText(/일부 자료만/)).toBeInTheDocument();
  expect(container.querySelector('.mkt-detail-state')).toBeNull();
  expect(screen.getByRole('button', { name: '쿠폰 보내기' })).toBeDisabled();
  const preview = screen.getByRole('group', { name: '문구 미리보기' });
  expect((within(preview).getByRole('textbox') as HTMLTextAreaElement).value).toMatch(/\(월\) 19~20시/);
  expect(preview).not.toHaveTextContent('번호를 먼저 등록');
  expect(backend.callsTo('POST', '/marketing/coupons/slot')).toHaveLength(0);
});

it('renders the real expiring lot in the original builder during a forecast read failure', async () => {
  const { container, backend } = open('expiry-coupon');
  expect(await screen.findByRole('heading', { name: /품목/ })).toBeInTheDocument();
  for (const step of ['혜택', '보낼 곳']) expect(screen.getByRole('heading', { name: new RegExp(step) })).toBeInTheDocument();
  expect(container.querySelector('.mkt-columns')).toBeInTheDocument();
  expect(container.querySelector('[data-slot="expiry-coupon.items"]')).toHaveTextContent('레몬 타르트 3개');
  expect(screen.getByText('62%까지 할인하면 원가 이상으로 팔아요')).toBeInTheDocument();
  expect(screen.queryByText(/2차 할인을 제안/)).not.toBeInTheDocument();
  expect(screen.getByText(/일부 자료만/)).toBeInTheDocument();
  expect(container.querySelector('.mkt-detail-state')).toBeNull();
  expect(backend.callsTo('POST', '/marketing/coupons/expiry')).toHaveLength(0);
});

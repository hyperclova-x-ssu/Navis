/** FIX-RV3 (RV-REALVERIFY-3): the active-coupons window keeps its original table in HTTP mode; the NAVER ledger follows it in the same table family. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend } from '../../../data/reality/00/testing';
import { couponsAdapter } from '../../../data/reality/14/adapter';
import type { CouponDto } from '../../../data/reality/14/dto';
import { renderWithKit } from '../../../ui/test-utils';
import { CouponStatusDetail } from './coupon-status';

afterEach(cleanup);

const campaign: CouponDto = {
  couponId: 'coupon-1', origin: 'slot', name: '평일 단골 쿠폰', benefitType: 'percent', benefitValue: 10,
  targetRef: null, validHours: null, startsOn: '2026-11-16', endsOn: '2026-11-24',
  status: 'active', daysLeft: 2, endingSoon: false, originRef: {}, basis: null,
  futureIssueCount: null, businessDate: '2026-11-16', createdAt: '2026-11-16T09:00:00Z',
  issued: 10, used: 4, discountSum: 0, reminderTargets: 1,
  canPause: true, canResume: false, canExtend: true, canEnd: true, canNotify: false, codes: [], revision: 1,
};

function open() {
  const backend = fakeBackend(), store = createWidgetDataStore();
  backend.on('GET', '/marketing/coupons', () => ({ items: [campaign], nextCursor: null, sourceRevision: 1, asOf: '2026-11-22T13:00:00Z', businessDate: '2026-11-22' }));
  backend.on('GET', '/marketing/naver-coupons', () => ({
    sourceRevision: 9, approvalsEnabled: true,
    placeCoupons: { items: [{ ref: 'place-1', name: '플레이스 첫 방문', to: '2026-12-31' }], nextCursor: null },
    orderPromotions: { items: [{ ref: 'order-1', name: '주문 스탬프' }], nextCursor: null },
    membership: { benefits: [{ ref: 'member-1', name: '회원 스탬프' }] },
  }));
  const port = createRealPort({ store, source: () => 'http', adapters: [couponsAdapter], fetch: backend.fetch });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: vi.fn(() => true), resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
  return renderWithKit(<CouponStatusDetail featureId="coupon-status" condition={{ kind: 'default' }} detailRef={{ featureId: 'coupon-status' }} host={host} />, { store });
}

it('shows the original coupon table first, with no source heading above it, and the NAVER ledger after it as tables of the same family', async () => {
  const { container } = open();
  await screen.findByText('평일 단골 쿠폰');
  const original = container.querySelector('[data-slot="coupon-status.detail"]') as HTMLElement;
  expect(original.querySelector('.mkt-status-head')).toBeInTheDocument();
  expect(original.querySelector('table.mkt-table')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Navis 코드 쿠폰' })).toBeNull();
  // The ledger comes after the original block and keeps one heading per kind, each with a table of the same class (no bare lists).
  const ledger = screen.getByRole('region', { name: '네이버 쿠폰' });
  expect(original.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(ledger).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['네이버 쿠폰', '주문 프로모션', '멤버십 쿠폰']);
  for (const name of ['네이버 쿠폰 목록', '주문 프로모션 목록', '멤버십 쿠폰 목록']) expect(within(ledger).getByRole('table', { name })).toHaveClass('mkt-table');
  expect(within(ledger).getByRole('button', { name: '발급 목록' })).toBeInTheDocument();
});

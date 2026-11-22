/** FIX-RV3 (RV-REALVERIFY-3): the active-coupons window keeps its original table in HTTP mode; the NAVER ledger follows it in the same table family. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend } from '../../../data/reality/00/testing';
import { couponsAdapter } from '../../../data/reality/14/adapter';
import type { CouponDto } from '../../../data/reality/14/dto';
import { renderWithKit } from '../../../ui/test-utils';
import { CouponStatusDetail, CouponStatusPanel } from './coupon-status';

afterEach(cleanup);

const campaign: CouponDto = {
  couponId: 'coupon-1', origin: 'slot', name: '평일 단골 쿠폰', benefitType: 'percent', benefitValue: 10,
  targetRef: null, validHours: null, startsOn: '2026-11-16', endsOn: '2026-11-24',
  status: 'active', daysLeft: 2, endingSoon: false, originRef: {}, basis: null,
  futureIssueCount: null, businessDate: '2026-11-16', createdAt: '2026-11-16T09:00:00Z',
  issued: 10, used: 4, discountSum: 0, reminderTargets: 1,
  canPause: true, canResume: false, canExtend: true, canEnd: true, canNotify: false, revision: 1,
  codes: [{ codeId: 'code-1', code: 'CAFE10', route: 'place_news', issueCount: 10, activated: true, activatedAt: '2026-11-16T09:00:00Z',
    unpublishedAt: null, issuedTerms: { benefitType: 'percent', benefitValue: 10, targetRef: null, endsOn: '2026-11-24' },
    used: 4, discountSum: 0, eligible: true, revision: 1 }],
};

function open(http = true) {
  const backend = fakeBackend(), store = createWidgetDataStore();
  backend.on('GET', '/marketing/coupons', () => ({ items: [campaign], nextCursor: null, sourceRevision: 1, asOf: '2026-11-22T13:00:00Z', businessDate: '2026-11-22' }));
  backend.on('GET', '/marketing/naver-coupons', () => ({
    sourceRevision: 9, approvalsEnabled: true,
    placeCoupons: { items: [{ ref: 'place-1', name: '플레이스 첫 방문', to: '2026-12-31' }], nextCursor: null },
    orderPromotions: { items: [{ ref: 'order-1', name: '주문 스탬프' }], nextCursor: null },
    membership: { benefits: [{ ref: 'member-1', name: '회원 스탬프' }] },
  }));
  const port = createRealPort({ store, source: () => 'http', adapters: [couponsAdapter], fetch: backend.fetch });
  if (http) store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: vi.fn(() => true), resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
  return renderWithKit(<>
    <CouponStatusPanel featureId="coupon-status" condition={{ kind: 'default' }} width={3} height={3} shape="S" presetId="A" editing={false} host={host} />
    <CouponStatusDetail featureId="coupon-status" condition={{ kind: 'default' }} detailRef={{ featureId: 'coupon-status' }} host={host} />
  </>, { store });
}

it('keeps the running and ended views and NAVER ledger controls in both modes', async () => {
  async function structure(http: boolean) {
    const { container } = open(http);
    if (http) await screen.findAllByText('평일 단골 쿠폰');
    const ledger = screen.queryByRole('region', { name: '네이버 쿠폰' });
    const ended = container.querySelector<HTMLDetailsElement>('.mkt-ended')!;
    fireEvent.click(ended.querySelector('summary')!);
    const result = { panel: !!container.querySelector('.mkt-panel[data-widget="coupon-status"]'),
      details: container.querySelector('.mkt-status-head') !== null,
      terms: !!container.querySelector('.mkt-table details > summary'),
      ended: ended.open,
      headings: ledger && within(ledger).getAllByRole('heading').map(el => el.textContent),
      columns: screen.getAllByRole('columnheader').map(el => el.textContent),
      actions: ledger && within(ledger).getAllByRole('button').map(el => el.textContent) };
    cleanup();
    return result;
  }
  expect(await structure(false)).toEqual(await structure(true));
});

it('expands the code terms in a full-width row and leaves unchanged issuance terms out', async () => {
  open();
  const toggle = await screen.findByRole('button', { name: '코드와 발급 조건' });
  fireEvent.click(toggle);
  const terms = toggle.closest('tr')?.nextElementSibling;
  expect(terms?.firstElementChild).toHaveAttribute('colspan', '4');
  expect(terms).toHaveTextContent('CAFE10 · 4/10');
  expect(terms).not.toHaveTextContent(/발급 혜택|원래 종료일/u);
  expect(terms).toHaveTextContent(/11\/16.*~.*11\/24/u);
  fireEvent.click(within(terms as HTMLElement).getByRole('button', { name: '일찍 끝내기' }));
  expect(within(terms as HTMLElement).getByText('오늘로 쿠폰을 끝낼까요?')).toBeInTheDocument();
  expect(within(terms as HTMLElement).getByRole('button', { name: '오늘 끝내기' })).toBeEnabled();
});

it('changes the example NAVER ledger only after the delete confirmation', () => {
  open(false);
  const ledger = screen.getByRole('region', { name: '네이버 쿠폰' });
  const table = within(ledger).getByRole('table', { name: '네이버 쿠폰 목록' });
  const source = within(table).getByRole('row', { name: /플레이스 첫 방문 쿠폰/ });
  fireEvent.click(within(source).getByRole('button', { name: '쿠폰 지우기' }));
  const confirmation = source.nextElementSibling as HTMLElement;
  expect(within(confirmation).getByRole('heading', { name: '플레이스 첫 방문 쿠폰을 지울까요?' })).toBeInTheDocument();
  fireEvent.click(within(confirmation).getByRole('button', { name: '지울 쿠폰 확인하기' }));
  expect(within(table).getByText('플레이스 첫 방문 쿠폰')).toBeInTheDocument();
  fireEvent.click(within(confirmation).getByRole('button', { name: '쿠폰 지우기' }));
  expect(within(ledger).queryByText('플레이스 첫 방문 쿠폰')).toBeNull();
  expect(within(ledger).getByRole('status')).toHaveTextContent('쿠폰을 지웠어요');
});

it('identifies the code coupon count and keeps NAVER forms within their table section', async () => {
  const { container } = open();
  await screen.findByText('평일 단골 쿠폰');
  const original = container.querySelector('[data-slot="coupon-status.detail"]') as HTMLElement;
  expect(original.querySelector('.mkt-status-head')).toBeInTheDocument();
  expect(original.querySelector('table.mkt-table')).toBeInTheDocument();
  expect(within(original).getByRole('heading', { name: 'Navis 코드 쿠폰' })).toBeInTheDocument();
  // The ledger comes after the original block and keeps one heading per kind, each with a table of the same class (no bare lists).
  const ledger = screen.getByRole('region', { name: '네이버 쿠폰' });
  expect(original.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(ledger).getAllByRole('heading').map(heading => heading.textContent)).toEqual(['네이버 쿠폰', '주문 프로모션', '멤버십 쿠폰']);
  for (const name of ['네이버 쿠폰 목록', '주문 프로모션 목록', '멤버십 쿠폰 목록']) expect(within(ledger).getByRole('table', { name })).toHaveClass('mkt-table');
  expect(within(ledger).getByRole('button', { name: '발급 목록 보기' })).toBeInTheDocument();
  fireEvent.click(within(ledger).getByRole('button', { name: '네이버 쿠폰 만들기' }));
  const form = within(ledger).getByLabelText('쿠폰 이름');
  expect(within(ledger).getByRole('table', { name: '네이버 쿠폰 목록' }).compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(form.compareDocumentPosition(within(ledger).getByRole('heading', { name: '주문 프로모션' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(ledger).getByText('받을 손님', { exact: true })).toBeVisible();
});

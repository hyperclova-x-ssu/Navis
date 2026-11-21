import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { MembersDetail } from './members';
import { MemberMoneyProvider } from '../i7-credit/provider';
import { binding } from '../i7-credit/test-fixtures';

const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
afterEach(cleanup);

it('requires menu context for membership use instead of recording an unpriced service in the member panel', () => {
  renderWithKit(<MembersDetail featureId="members" condition={{ kind: 'default' }} detailRef={{ featureId: 'members', itemId: 'M-0001' }} host={host} />);
  const side = screen.getByRole('region');
  expect(within(side).queryByRole('button', { name: '1회 사용 기록하기' })).not.toBeInTheDocument();
});

it('keeps the existing masked member information', async () => {
  renderWithKit(<MembersDetail featureId="members" condition={{ kind: 'default' }} detailRef={{ featureId: 'members', itemId: 'M-0001' }} host={host} />);
  const side = screen.getByRole('region');
  expect(side.textContent).toContain('****');
  await userEvent.click(within(side).getByRole('button', { name: '회원권 판매하기' }));
  expect(within(side).getByText('충전금·외상 내역을 불러오지 못했어요')).toBeInTheDocument();
});

it('shows linked balances and sells a selected pass through the shared checkout only', async () => {
  const b = binding();
  renderWithKit(<MemberMoneyProvider binding={b}><MembersDetail featureId="members" condition={{ kind: 'default' }} detailRef={{ featureId: 'members', itemId: 'M-0001' }} host={host} /></MemberMoneyProvider>, { locale: 'en' });
  const side = screen.getByRole('region');
  await userEvent.click(within(side).getByRole('button', { name: '충전금 잔액 40,000원' }));
  expect(b.port.openAccounts).toHaveBeenCalledWith('M-0001', expect.objectContaining({ selectedId: 'M-0001', detailRef: { featureId: 'members', itemId: 'M-0001' } }));
  await userEvent.click(within(side).getByRole('button', { name: '회원권 판매하기' }));
  expect(within(side).getByRole('button', { name: '결제 받기' })).toBeDisabled();
  await userEvent.click(within(side).getByRole('radio', { name: '아메리카노 10잔권 · 40,000원' }));
  expect(within(side).getByText(/1회 값 4,000원/)).toBeInTheDocument();
  await userEvent.click(within(side).getByRole('button', { name: '결제 받기' }));
  expect(b.port.openSettlement).toHaveBeenCalledWith({ purpose: 'membership_sale', memberId: 'M-0001', productId: 'P-COUNT' }, expect.objectContaining({ selectedId: 'M-0001', returnFocusRef: expect.any(Object) }));
  expect(b.memberships).toHaveLength(0);
  await userEvent.click(within(side).getByRole('radio', { name: '월 구독 · 55,000원' }));
  expect(within(side).getByText(/하루 1,833원 · 30일째 1,843원/)).toBeInTheDocument();
});

it('reads service and refund status from the source and preserves original use navigation', async () => {
  const b = binding();
  const membership = { membershipId: 'PASS', memberId: 'M-0001', productLabel: '아메리카노 10잔권', kind: 'count' as const, soldPrice: 40000, totalUses: 10, validDays: 90, startsOn: '2026-07-28', endsOn: '2026-10-26', usesRemaining: 2, recognizedValue: 40000, unrecognizedValue: 0, refundedValue: 0, status: 'expired' as const, saleSettlementId: 'SALE', uses: [] };
  const result = renderWithKit(<MemberMoneyProvider binding={{ ...b, memberships: [membership] }}><MembersDetail featureId="members" condition={{ kind: 'default' }} detailRef={{ featureId: 'members', itemId: 'M-0001' }} host={host} /></MemberMoneyProvider>);
  const side = screen.getByRole('region');
  expect(within(side).getByText('기한 만료 매출')).toBeInTheDocument();
  expect(within(side).getByRole('button', { name: '주문/결제에서 사용하기' })).toBeDisabled();
  await userEvent.click(within(side).getByRole('button', { name: '원거래 보기' }));
  expect(b.port.openOriginalTransaction).toHaveBeenCalledWith({ settlementId: 'SALE', membershipId: 'PASS' }, expect.any(Object));
  result.rerender(<MemberMoneyProvider binding={{ ...b, memberships: [{ ...membership, status: 'refunded', recognizedValue: 28000, refundedValue: 12000 }] }}><MembersDetail featureId="members" condition={{ kind: 'default' }} detailRef={{ featureId: 'members', itemId: 'M-0001' }} host={host} /></MemberMoneyProvider>);
  expect(within(screen.getByRole('region')).getByText(/중도 환불 12,000원/)).toBeInTheDocument();
});

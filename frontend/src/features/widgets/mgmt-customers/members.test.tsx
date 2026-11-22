import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectMembers } from '../../../data/widget-data';
import { MembersDetail, MembersPanel } from './members';

const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const common = { featureId: 'members' as const, condition: { kind: 'default' as const }, host };
const gridStyles = ['src/ui/mastermanage.css', 'src/features/widgets/mgmt-customers/widgets.css']
  .map(path => readFileSync(path, 'utf8')).join('\n');
afterEach(cleanup);
// The café sample (D-313): the counts are read from the selector the panel uses.
const seed = selectMembers(createWidgetDataStore().getSnapshot(), {});
it('shows every member and the active memberships at 125% with reduced motion', () => {
  renderWithKit(<MembersPanel {...common} width={1} height={1} shape="Q" presetId="A" editing={false} />, { textScale: 125, reducedMotion: true });
  expect(screen.getByText(String(seed.total))).toBeInTheDocument();
  expect(screen.getByText(new RegExp(`${seed.membershipCount}개`))).toBeInTheDocument();
});
it('switches to the membership table', async () => {
  renderWithKit(<MembersDetail {...common} detailRef={{ featureId: 'members' }} />);
  await userEvent.click(screen.getByRole('tab', { name: '회원권' }));
  expect(screen.getByRole('grid', { name: '회원권' })).toBeInTheDocument();
});
it('finds a member by their compact display number and uses the canonical row ID', async () => {
  const store = createWidgetDataStore();
  const { memberProfile } = store.getSnapshot().tables;
  const original = memberProfile.find(row => row.memberId === 'M-0008')!;
  const memberId = 'e79a88b6-e6a5-4d5b-b23a-78c7f72e2dcc';
  store.hydrate({ memberProfile: memberProfile.map(row => row === original ? { ...row, memberCode: 'M-0008', memberId } : row) });
  renderWithKit(<MembersDetail {...common} detailRef={{ featureId: 'members' }} />, { store });
  const grid = screen.getByRole('grid', { name: '회원목록' });
  await userEvent.type(screen.getByRole('searchbox'), 'M-0008');
  const compact = within(grid).getByText('M-0008');
  expect(compact.closest('tr')).toHaveAttribute('data-grid-row', memberId);
  expect(grid).not.toHaveTextContent(memberId);
  await userEvent.click(compact);
  expect(screen.getByRole('region', { name: /M-0008/ })).toBeInTheDocument();
});
it('right-aligns the membership counts with their unit and their header in the member list', () => {
  renderWithKit(<><style>{gridStyles}</style><MembersDetail {...common} detailRef={{ featureId: 'members' }} /></>);
  const grid = screen.getByRole('grid', { name: '회원목록' });
  const header = within(grid).getByRole('columnheader', { name: '회원권' });
  expect(getComputedStyle(within(header).getByText('회원권')).justifyContent).toBe('flex-end');
  const counts = Array.from(grid.querySelectorAll('[data-grid-column-id="membership"]'));
  expect(counts.map(cell => cell.textContent)).toEqual(expect.arrayContaining(['0개', '1개']));
  for (const cell of counts) {
    expect(cell.textContent).toMatch(/^\d+개$/); // DS 12.1: the unit follows the number (A2)
    expect(getComputedStyle(cell).textAlign).toBe('right');
  }
});
it('adds an 8 px inset before the start date without changing right alignment at 125% text size', () => {
  renderWithKit(<><style>{gridStyles}</style><MembersDetail {...common} detailRef={{ featureId: 'members', view: 'memberships' }} /></>, { textScale: 125 });
  const grid = screen.getByRole('grid', { name: '회원권' });
  const header = within(grid).getByRole('columnheader', { name: '남은 횟수' });
  expect(getComputedStyle(header).paddingInlineEnd).toBe('calc(var(--table-cell-padding-x) + var(--space-2))');

  const remaining = Array.from(grid.querySelectorAll('[data-grid-column-id="remaining"]'));
  expect(remaining.map(cell => cell.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^\d+ 회$/)]));
  for (const cell of remaining) {
    expect(cell.textContent).toMatch(/^(\d+ 회|구독권)$/); // a count carries its unit; a period pass says 구독권
    const style = getComputedStyle(cell);
    expect(style.paddingInlineEnd).toBe('calc(var(--table-cell-padding-x) + var(--space-2))');
    expect(style.textAlign).toBe('right');
  }
});
it('opens POS for a priced membership use and the original transaction for cancellation', async () => {
  const { createWidgetDataStore } = await import('../../../data/widget-data');
  const { MemberMoneyProvider } = await import('../i7-credit');
  const { binding } = await import('../i7-credit/test-fixtures');
  const store = createWidgetDataStore();
  const member = selectMembers(store.getSnapshot(), {}).rows.find(r => r.memberships.some(m => m.active && (m.usesLeft ?? 0) > 0))!;
  const membership = member.memberships.find(m => m.active && (m.usesLeft ?? 0) > 0)!;
  const b = binding();
  const pass = { membershipId: membership.membershipId, memberId: member.memberId, productLabel: '아메리카노 10잔권', kind: 'count' as const, soldPrice: 40000, totalUses: 10, validDays: 90, startsOn: membership.startsOn, endsOn: membership.endsOn, usesRemaining: membership.usesLeft, recognizedValue: 36000, unrecognizedValue: 4000, refundedValue: 0, status: 'active' as const, saleSettlementId: 'pass-sale', uses: [{ useId: 'last-use', usedAt: '2026-10-26T14:00', settlementId: 'last-sale' }] };
  renderWithKit(<MemberMoneyProvider binding={{ ...b, memberships: [pass] }}><MembersDetail {...common} detailRef={{ featureId: 'members', itemId: member.memberId }} /></MemberMoneyProvider>, { store });
  expect(screen.queryByRole('button', { name: '1회 사용 기록하기' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '사용 취소하기' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '주문/결제에서 사용하기' }));
  expect(b.port.openMembershipUse).toHaveBeenCalledWith(member.memberId, membership.membershipId, expect.objectContaining({ selectedId: member.memberId }));
  await userEvent.click(screen.getAllByRole('button', { name: '원거래 보기' }).at(-1)!);
  expect(b.port.openOriginalTransaction).toHaveBeenCalledWith(expect.objectContaining({ useId: 'last-use', settlementId: 'last-sale' }), expect.any(Object));
  expect(selectMembers(store.getSnapshot(), {}).membershipCount).toBe(seed.membershipCount);
});

it('shows the grade as one status chip per cell (positive 단골 · warning 오랜 기간 미방문), with a caption for a hand-set grade (A9)', () => {
  renderWithKit(<MembersDetail {...common} detailRef={{ featureId: 'members' }} />);
  const grid = screen.getByRole('grid', { name: '회원목록' });
  const chips = (grade: string) => seed.rows.filter(r => r.grade === grade).slice(0, 3).map(r => grid.querySelector(`[data-grid-row="${r.memberId}"] [data-grid-column-id="grade"]`)!.querySelectorAll('.ui-status-chip'));
  for (const found of chips('regular')) { expect(found).toHaveLength(1); expect(found[0]).toHaveAttribute('data-semantic', 'positive'); expect(found[0]).toHaveTextContent('단골'); }
  for (const found of chips('inactive')) { expect(found).toHaveLength(1); expect(found[0]).toHaveAttribute('data-semantic', 'warning'); expect(found[0]).toHaveTextContent('오랜 기간 미방문'); }
  for (const found of [...chips('frequent'), ...chips('occasional')]) { expect(found).toHaveLength(1); expect(found[0]).toHaveAttribute('data-semantic', 'none'); }
});
it('lists the membership tab by 회원 and marks only the passes that end this week with a 곧 끝나요 chip, units after the numbers (A2, I1)', () => {
  renderWithKit(<MembersDetail {...common} detailRef={{ featureId: 'members', view: 'memberships' }} />);
  const grid = screen.getByRole('grid', { name: '회원권' });
  expect(within(grid).getByRole('columnheader', { name: '회원' })).toBeInTheDocument();
  const ending = seed.rows.flatMap(r => r.memberships.filter(m => m.active && m.endingThisWeek));
  expect(grid.querySelectorAll('[data-grid-column-id="end"] .ui-status-chip')).toHaveLength(ending.length);
  for (const chip of grid.querySelectorAll('[data-grid-column-id="end"] .ui-status-chip')) expect(chip).toHaveTextContent('곧 끝나요');
});
it('keeps one primary button in the member panel and ends the body with the delete action (DS 12.2, C3)', async () => {
  const member = seed.rows.find(r => r.memberId === 'M-0008')!;
  renderWithKit(<MembersDetail {...common} detailRef={{ featureId: 'members', itemId: member.memberId }} />, { reducedMotion: true });
  const side = screen.getByRole('region');
  // `ui-button--default` is both the primary variant and the default size: a primary is a button with no other variant class
  const primaries = within(side).getAllByRole('button').filter(button => !['secondary', 'outline', 'ghost', 'destructive', 'link'].some(variant => button.classList.contains(`ui-button--${variant}`)) && !button.classList.contains('ui-button--icon'));
  expect(primaries.map(button => button.textContent)).toEqual(['기본 정보 저장하기']);
  const remove = within(side).getByRole('button', { name: '회원 지우기' });
  const danger = remove.closest('[data-panel-slot="danger"]')!;
  expect(danger.parentElement!.lastElementChild).toBe(danger);
  expect(danger.querySelector('.ui-button--ghost')).toBe(remove);
});

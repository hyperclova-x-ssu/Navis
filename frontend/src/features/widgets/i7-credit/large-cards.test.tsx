// D-333 (LARGE-CARDS-1): the large 충전금·외상 card also lists the recent transactions the account holds; it never invents them.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { panelShape } from '../../../ui';
import { CreditPanel } from './index';
import { binding, transaction } from './test-fixtures';
import type { CellSpan } from '../../../contracts';

const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const detail = { featureId: 'members' as const, condition: { kind: 'default' as const }, detailRef: { featureId: 'members' as const }, host };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const mount = (width: CellSpan, height: CellSpan, source = binding()) =>
  renderWithKit(<CreditPanel {...detail} {...source} width={width} height={height} shape={panelShape(width, height)} presetId="A" editing={false} />);
const history = () => screen.queryByRole('list', { name: '최근 거래 내역' });

describe('충전금·외상 4×4 (D-333)', () => {
  it('lists the recent transactions below the member table, each with its date', () => {
    const source = binding();
    mount(4, 4, source);
    expect(screen.getByRole('table', { name: '회원별 현황' })).toBeInTheDocument();
    const rows = within(history()!).getAllByRole('listitem');
    expect(rows).toHaveLength(source.view.status === 'ready' ? source.view.model.transactions.length : -1);
    // the money is the transaction's own, the date is its `at`
    expect(rows[0]).toHaveTextContent('+50,000원');
    expect(rows[0]).toHaveTextContent('10/26(월) 10:15');
  });
  it('keeps the 4×2 card to the table only', () => {
    mount(4, 2);
    expect(screen.getByRole('table', { name: '회원별 현황' })).toBeInTheDocument();
    expect(history()).toBeNull();
  });
  it('shows no history block when the account has no transactions', () => {
    const source = binding();
    if (source.view.status !== 'ready') throw new Error('fixture');
    mount(4, 4, { ...source, view: { status: 'ready', model: { ...source.view.model, transactions: [] } } });
    expect(screen.getByRole('table', { name: '회원별 현황' })).toBeInTheDocument();
    expect(history()).toBeNull();
    expect(screen.queryByText('최근 거래 내역')).toBeNull();
  });
  it('lists no more than the transactions it has (one fixture transaction → one line)', () => {
    const source = binding();
    if (source.view.status !== 'ready') throw new Error('fixture');
    const one = { ...source, view: { status: 'ready' as const, model: { ...source.view.model, transactions: [transaction] } } };
    mount(4, 4, one);
    expect(within(history()!).getAllByRole('listitem')).toHaveLength(1);
  });
});

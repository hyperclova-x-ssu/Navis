// D-333 (LARGE-CARDS-1): the large 주문제작 card shows the stage counts and the order number column the model has.
import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomOrderSeed, selectCustomOrders, type CustomOrderRead } from '../../../data/iteration7/custom-orders';
import { renderWithKit } from '../../../ui/test-utils';
import type { CellSpan } from '../../../contracts';
import { orderNumber } from './copy';
import { CustomOrderProvider, type CustomOrderPort } from './port';
import { CustomOrderPanel } from './widget';
import { panelShape } from '../../../ui';

afterEach(cleanup);
const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
const read = (): CustomOrderRead => ({ revision: 0, ...createCustomOrderSeed(), businessDate: '2026-11-17', now: '2026-11-17T15:45:00' });
function mount(width: CellSpan, height: CellSpan, state: 'ready' | 'empty' = 'ready', source: CustomOrderRead = read()) {
  const port = { read: () => source, subscribe: () => () => {}, dispatch: vi.fn(() => ({ ok: true as const, changed: true })), openSettlement: vi.fn(), openReversal: vi.fn() } satisfies CustomOrderPort;
  return renderWithKit(<CustomOrderProvider port={port} state={state}><CustomOrderPanel featureId="custom-order" condition={{ kind: 'default' }} width={width} height={height} shape={panelShape(width, height)} presetId="A" editing={false} host={host} /></CustomOrderProvider>);
}
const counts = () => [...document.querySelectorAll('.custom-stage-counts > div')].map((d) => [d.querySelector('p')!.textContent, d.querySelector('strong')!.textContent]);

describe('주문제작 4×4 (D-333)', () => {
  it('includes received and awaiting quote in the stage counts above the table', () => {
    const rows = selectCustomOrders(read()).orders;
    mount(4, 4);
    const by = (stage: string) => String(rows.filter((r) => r.stage === stage).length);
    expect(counts()).toEqual([['접수', String(Number(by('received')) + Number(by('quote_pending')))], ['승인 대기', String(selectCustomOrders(read()).summary.approvalPending)], ['결제 대기', by('payment_pending')], ['제작 중', by('in_production')], ['제작 완료', by('production_complete')]]);
  });
  it('adds an order-number column with each order\'s own number', () => {
    const rows = selectCustomOrders(read()).orders;
    mount(4, 4);
    const table = document.querySelector('.custom-panel-table table') as HTMLElement;
    expect(within(table).getByRole('columnheader', { name: '주문 번호' })).toBeInTheDocument();
    const shown = [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('.custom-number-column')!.textContent);
    expect(shown).toEqual(rows.slice(0, shown.length).map((r) => orderNumber(r.customOrderId)));
    expect(shown.length).toBe(rows.length);
  });
  it('writes the customer\'s request under the product only for orders that have one', () => {
    const rows = selectCustomOrders(read()).orders;
    mount(4, 4);
    const trs = [...document.querySelectorAll('.custom-panel-table tbody tr')];
    trs.forEach((tr, i) => {
      const request = rows[i]!.request?.trim();
      const note = tr.querySelector('.custom-request');
      if (request) expect(note).toHaveTextContent(request); else expect(note).toBeNull();
    });
  });
  it('shows a request that an order really holds (trimmed), only on the large card', () => {
    const base = read();
    const source: CustomOrderRead = { ...base, tables: { ...base.tables, customOrder: base.tables.customOrder.map((o, i) => (i === 0 ? { ...o, request: '  문구는 감사합니다로 부탁드려요  ' } : o)) } };
    const shownFirst = selectCustomOrders(source).orders[0]!;
    mount(4, 4, 'ready', source);
    const notes = [...document.querySelectorAll('.custom-request')];
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent('문구는 감사합니다로 부탁드려요');
    expect(notes[0]!.closest('tr')!.querySelector('.custom-number-column')).toHaveTextContent(orderNumber(shownFirst.customOrderId));
    cleanup();
    mount(4, 2, 'ready', source);
    expect(document.querySelector('.custom-request')).toBeNull();
  });
  it('keeps the 4×2 card as before (no counts, no number column) and has nothing to add when there are no orders', () => {
    mount(4, 2);
    expect(document.querySelector('.custom-stage-counts')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: '주문 번호' })).toBeNull();
    cleanup();
    mount(4, 4, 'empty');
    expect(document.querySelector('.custom-stage-counts')).toBeNull();
    expect(document.querySelector('.custom-panel-table')).toBeNull();
  });
});

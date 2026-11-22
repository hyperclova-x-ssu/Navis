import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomOrderSeed, selectCustomOrders, type CustomOrderRead } from '../../../data/iteration7/custom-orders';
import { createLegacyCustomOrderSeed } from '../../../data/iteration7/custom-orders/seed';
import { renderWithKit } from '../../../ui/test-utils';
import type { WidgetDetailProps } from '../../../contracts';
import { orderNumber, stageLabels } from './copy';
import { pickDateTime } from './test-pickers';
import { CustomOrderProvider, type CustomOrderPort } from './port';
import { CustomOrderDetail, CustomOrderPanel } from './widget';

afterEach(cleanup);
const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
const props = { featureId: 'voice-booking', condition: { kind: 'default' }, detailRef: { featureId: 'voice-booking' }, host } as WidgetDetailProps;
/** The store seed the app opens with, on the demo clock (11/17 Tue 15:45). */
export function exampleRead(): CustomOrderRead {
  const seed = createCustomOrderSeed();
  return { revision: 0, ...seed, businessDate: '2026-11-17', now: '2026-11-17T15:45:00' };
}
/** AC-1471 fixture: CO-001 (paid, finished) and CO-002 (60,000 waiting for the customer), on the clock the fixture was written for. */
export function acceptanceRead(): CustomOrderRead {
  const seed = createLegacyCustomOrderSeed();
  return { revision: 0, ...seed, businessDate: '2026-10-26', now: '2026-10-26T15:45:00' };
}
function mount(state: 'ready' | 'empty' | 'error' = 'ready', styles?: string, read: CustomOrderRead = exampleRead()) {
  const dispatch = vi.fn(() => ({ ok: true as const, changed: true }));
  const port = { read: () => read, subscribe: () => () => {}, dispatch, openSettlement: vi.fn(), openReversal: vi.fn() } satisfies CustomOrderPort;
  renderWithKit(<>{styles && <style>{styles}</style>}<CustomOrderProvider port={port} state={state}><CustomOrderDetail {...props} /></CustomOrderProvider></>);
  return { port, read };
}
const listStyles = ['src/ui/tokens.css', 'src/ui/mastermanage.css', 'src/features/widgets/i7-custom/custom.css']
  .map(path => readFileSync(path, 'utf8')).join('\n');
const seedOrders = (read: CustomOrderRead) => selectCustomOrders(read).orders;

describe('custom-order management boundaries', () => {
  it('aligns the searchable order field and receipt action in the same tool row', () => {
    const { read } = mount('ready', listStyles);
    const [first, second] = seedOrders(read);
    const search = screen.getByRole('searchbox', { name: '검색' });
    const add = screen.getByRole('button', { name: '주문 접수하기' });
    const toolbar = search.closest('.ui-data-grid__toolbar')!;
    expect(search).toHaveAttribute('placeholder', '주문번호나 손님 이름으로 찾아보세요');
    expect(search.closest('.ui-search-field__control')!.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    expect(add.parentElement).toBe(toolbar);
    expect(toolbar.closest('.ui-data-grid')).toContainElement(screen.getByRole('grid', { name: '주문제작 목록' }));
    expect(getComputedStyle(toolbar).alignItems).toBe('center');
    expect(getComputedStyle(add).minHeight).toBe('var(--target-default)');

    fireEvent.change(search, { target: { value: orderNumber(second!.customOrderId).toLowerCase() } });
    expect(screen.queryByRole('button', { name: new RegExp(orderNumber(first!.customOrderId)) })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(orderNumber(second!.customOrderId)) })).toBeInTheDocument();
    fireEvent.click(add);
    expect(screen.getByLabelText('희망 픽업 일시')).toBeInTheDocument();
  });
  it('leaves the reserved height below short order lists unframed', () => {
    mount('ready', listStyles);
    const grid = screen.getByRole('grid', { name: '주문제작 목록' });
    const scroller = grid.parentElement!;
    expect(within(grid).getAllByRole('row')).toHaveLength(1 + seedOrders(exampleRead()).length);
    expect(getComputedStyle(scroller).minHeight).toContain('3 * var(--table-row-min)');
    expect(getComputedStyle(scroller).borderBottomColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(grid).borderRadius).toBe('var(--radius-lg)');
  });
  it('lists the order numbers people read, a short pickup date and stage chips, never the store ids', () => {
    const { read } = mount();
    const grid = screen.getByRole('grid', { name: '주문제작 목록' });
    const [first, second] = seedOrders(read);
    // DATA-FIX item 20 (877f99a): the seed adapter emits CO-001 and CO-002 as runtime identifiers without copying the internal sample ids.
    expect(first!.customOrderId).toBe('CO-001');
    expect(second!.customOrderId).toBe('CO-002');
    expect(grid.textContent).not.toMatch(/sample-custom|\d{4}-\d{2}-\d{2}/);
    const rows = within(grid).getAllByRole('row').slice(1);
    // 11/18 is tomorrow on the demo clock, 11/20 a short date with its weekday.
    expect(rows[0]).toHaveTextContent('CO-001');
    expect(rows[0]).toHaveTextContent('내일 10:30');
    expect(rows[1]).toHaveTextContent('CO-002');
    expect(rows[1]).toHaveTextContent('11/20(금) 15:30');
    for (const [row, order] of [[rows[0]!, first!], [rows[1]!, second!]] as const) {
      const chip = within(row).getByText(stageLabels[order.stage]).closest('.ui-status-chip')!;
      expect(chip).toHaveAttribute('data-semantic');
    }
  });
  it('shows the stage as a chip with its meaning: waiting ◷ on the warning face, done ✓, plain words for the first stages', () => {
    mount('ready', undefined, acceptanceRead());
    const grid = screen.getByRole('grid', { name: '주문제작 목록' });
    const chipOf = (label: string) => within(grid).getByText(label).closest('.ui-status-chip')!;
    expect(chipOf('제작 완료')).toHaveAttribute('data-semantic', 'done');
    expect(chipOf('제작 완료').querySelector('svg')).not.toBeNull();
    expect(chipOf('손님 승인 대기')).toHaveAttribute('data-semantic', 'waiting');
    expect(chipOf('손님 승인 대기')).toHaveAttribute('data-tone', 'warning');
    expect(chipOf('손님 승인 대기')).not.toHaveAttribute('data-compact');
    expect(chipOf('결제 완료')).toHaveAttribute('data-semantic', 'done');
    expect(chipOf('결제 전')).toHaveAttribute('data-semantic', 'waiting');
  });
  it('gives a search with no result its own sentence and a [검색어 지우기] that brings the list back', () => {
    mount();
    fireEvent.change(screen.getByRole('searchbox', { name: '검색' }), { target: { value: '없는 주문' } });
    expect(screen.getByText('검색 결과가 없어요')).toBeInTheDocument();
    expect(screen.queryByText('아직 등록한 주문제작이 없어요')).not.toBeInTheDocument();
    const noResults = screen.getByText('검색 결과가 없어요').closest('.ui-data-grid__noresults') as HTMLElement;
    fireEvent.click(within(noResults).getByRole('button', { name: '검색어 지우기' }));
    expect(screen.getByRole('searchbox', { name: '검색' })).toHaveValue('');
    expect(screen.getByRole('button', { name: /CO-001/ })).toBeInTheDocument();
  });
  it('keeps compact metrics to two lines and places narrow order chips beside the pickup time', () => {
    const read = exampleRead();
    const port = { read: () => read, subscribe: () => () => {}, dispatch: vi.fn(() => ({ ok: true as const, changed: true })), openSettlement: vi.fn(), openReversal: vi.fn() } satisfies CustomOrderPort;
    const panel = { ...props, width: 1 as const, height: 1 as const, shape: 'Q' as const, presetId: 'A' as const, editing: false };
    const { container, rerender } = renderWithKit(<CustomOrderProvider port={port}><CustomOrderPanel {...panel} /></CustomOrderProvider>);
    expect(screen.queryByText(/^승인 대기 \d+건$/)).not.toBeInTheDocument();
    expect(container.querySelector('.custom-order-row')).toBeNull();
    rerender(<CustomOrderProvider port={port}><CustomOrderPanel {...panel} height={2} shape="T" /></CustomOrderProvider>);
    const row = container.querySelector('.custom-order-row')!;
    const [first] = seedOrders(read);
    expect(row.querySelector('.custom-order-meta .ui-status-chip')).toHaveTextContent(stageLabels[first!.stage]);
    expect(row.querySelector('.custom-order-meta .ui-status-chip')).not.toHaveAttribute('data-compact');
    expect(row.querySelector('.custom-order-name')).toHaveTextContent(first!.productLabel);
    expect(row.querySelector('.custom-order-meta span')).toHaveTextContent('내일 10:30');
  });
  it('asks for an order with a sentence and one action when the panel has none', () => {
    const read = exampleRead();
    const port = { read: () => read, subscribe: () => () => {}, dispatch: vi.fn(() => ({ ok: true as const, changed: true })), openSettlement: vi.fn(), openReversal: vi.fn() } satisfies CustomOrderPort;
    const panel = { ...props, featureId: 'custom-order', width: 1, height: 1, shape: 'Q', presetId: 'A', editing: false } as unknown as Parameters<typeof CustomOrderPanel>[0];
    renderWithKit(<CustomOrderProvider port={port} state="empty"><CustomOrderPanel {...panel} /></CustomOrderProvider>);
    expect(screen.getByText('아직 등록한 주문제작이 없어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^주문 접수하기/ }));
    expect(host.openDetail).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'custom-order', view: 'register' }));
  });
  it('shows production and paid status separately and opens the shared host only after approval', () => {
    const { port } = mount('ready', undefined, acceptanceRead());
    fireEvent.click(screen.getByRole('button', { name: /CO-002/ }));
    expect(screen.getByText('손님 승인을 먼저 기록해 주세요')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '결제 받기' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /CO-001/ }));
    const detail = screen.getByRole('region', { name: /CO-001/ });
    expect(within(detail).getByText('제작 완료')).toBeInTheDocument();
    expect(within(detail).getByText('결제 완료')).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: '주문 취소하기' }));
    expect(port.openReversal).toHaveBeenCalledWith(expect.objectContaining({ customOrderId: 'CO-001', cancelOrder: true }), expect.anything());
    expect(port.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'customOrder.cancel' }));
  });
  it('rejects a zero quote locally and records revision requests against the shown revision', () => {
    const { port, read } = mount('ready', undefined, acceptanceRead());
    fireEvent.click(screen.getByRole('button', { name: /CO-002/ }));
    fireEvent.change(screen.getByLabelText('견적 금액'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '견적 저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('견적 금액을 1원 이상 넣어 주세요');
    fireEvent.click(screen.getByRole('button', { name: '수정 요청으로 바꾸기' }));
    const revision = selectCustomOrders(read).orders.find(row => row.customOrderId === 'CO-002')!.quoteRevision;
    expect(port.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: revision, decision: 'revision_requested' }));
  });
  it('provides empty creation and error retry states without leaking an English message key', () => {
    mount('empty');
    expect(screen.getByText('아직 등록한 주문제작이 없어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '주문 접수하기' }));
    expect(screen.getByLabelText('희망 픽업 일시')).toBeInTheDocument();
    cleanup(); mount('error');
    expect(screen.getByText('주문제작 내역을 불러오지 못했어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기, 주문제작' }));
    expect(host.resetPreview).toHaveBeenCalled();
  });
});

describe('custom-order side panel (DS 12.2)', () => {
  it('puts the cancel action in the kit danger slot, after the history, and nothing after it', () => {
    mount('ready', undefined, acceptanceRead());
    fireEvent.click(screen.getByRole('button', { name: /CO-002/ }));
    const panel = screen.getByRole('region', { name: /CO-002/ });
    const body = panel.querySelector('.ui-detail-side-panel__body')!;
    const danger = body.querySelector('[data-panel-slot="danger"]')!;
    expect(body.lastElementChild).toBe(danger);
    expect(within(danger as HTMLElement).getByRole('button', { name: '주문 취소하기' })).toBeInTheDocument();
    expect(within(body as HTMLElement).getAllByRole('button', { name: '주문 취소하기' })).toHaveLength(1);
    const history = within(panel).getByRole('region', { name: '변경 이력' });
    expect(history.compareDocumentPosition(danger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.closest('.custom-workspace')!.querySelector(':scope > .ui-data-grid')).not.toBeNull();
    expect(panel.parentElement).toBe(screen.getByRole('grid', { name: '주문제작 목록' }).closest('.ui-data-grid')!.parentElement);
  });
  it('writes history money with its comma and unit and turns data codes into sentences', () => {
    mount('ready', undefined, acceptanceRead());
    fireEvent.click(screen.getByRole('button', { name: /CO-002/ }));
    const history = within(screen.getByRole('region', { name: /CO-002/ })).getByRole('region', { name: '변경 이력' });
    expect(history).toHaveTextContent('견적 60,000원');
    expect(history.textContent).not.toMatch(/60000|approved|production_complete|receipt|\d{4}-\d{2}-\d{2}/);
    expect(history).toHaveTextContent('오늘 10:00');
    cleanup();
    mount('ready', undefined, acceptanceRead());
    fireEvent.click(screen.getByRole('button', { name: /CO-001/ }));
    const done = within(screen.getByRole('region', { name: /CO-001/ })).getByRole('region', { name: '변경 이력' });
    expect(done).toHaveTextContent('손님이 승인했어요');
    expect(done).toHaveTextContent('결제 45,000원');
    expect(done).toHaveTextContent('진행 상태 제작 완료');
  });
  it('writes the quantity alone when an order has no options', () => {
    const { read } = mount();
    const [first] = seedOrders(read);
    fireEvent.click(screen.getByRole('button', { name: /CO-001/ }));
    expect(within(screen.getByRole('region', { name: /CO-001/ })).getByText(`${first!.quantity}개`)).toBeInTheDocument();
  });
  it('edits dates and times with the kit pickers, never a browser date control', () => {
    mount('ready', undefined, acceptanceRead());
    fireEvent.click(screen.getByRole('button', { name: /CO-002/ }));
    const panel = screen.getByRole('region', { name: /CO-002/ });
    expect(panel.querySelectorAll('input[type="date"], input[type="time"], input[type="datetime-local"]')).toHaveLength(0);
    expect(within(panel).getByRole('button', { name: /^확정 픽업 날짜 10월 27일 화요일$/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /^확정 픽업 시각 14:00$/ })).toBeInTheDocument();
  });
  it('refuses a pickup time that already passed with the same sentence as a booking, only when the time was changed', async () => {
    const { port } = mount('ready', undefined, acceptanceRead());
    fireEvent.click(screen.getByRole('button', { name: /CO-002/ }));
    // Unchanged (and still in the future): the quote saves.
    fireEvent.change(screen.getByLabelText('견적 금액'), { target: { value: '65000' } });
    // Today at 09:00 is before the clock (15:45): refused, nothing is sent.
    await pickDateTime(/^확정 픽업 날짜 /, /^확정 픽업 시각 /, '2026-10-26', '09:00');
    fireEvent.click(screen.getByRole('button', { name: '견적 저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('지난 시간에는 새 예약을 넣을 수 없어요');
    expect(port.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'customOrder.quote' }));
    // A time later today is accepted.
    await pickDateTime(/^확정 픽업 날짜 /, /^확정 픽업 시각 /, '2026-10-26', '18:00');
    fireEvent.click(screen.getByRole('button', { name: '견적 저장하기' }));
    expect(port.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'customOrder.quote', proposedPickupAt: '2026-10-26T18:00', quoteAmount: 65000 }));
  });
  it('refuses a past pickup in the receipt form too, naming the date field', async () => {
    const { port } = mount();
    fireEvent.click(screen.getByRole('button', { name: '주문 접수하기' }));
    const form = screen.getByRole('form', { name: '주문 접수' });
    fireEvent.change(within(form).getByLabelText('손님 이름'), { target: { value: '박하늘' } });
    fireEvent.change(within(form).getByLabelText('연락처'), { target: { value: '01012345678' } });
    fireEvent.change(within(form).getByLabelText('상품'), { target: { value: '꽃 케이크' } });
    const template = exampleRead().tables.customTemplate[0]!;
    for (const field of template.fields.filter(field => field.required && field.input === 'text')) fireEvent.change(within(form).getByLabelText(`${field.label} (필수 입력)`), { target: { value: '생일 축하해요' } });
    for (const field of template.fields.filter(field => field.required && field.input === 'single')) fireEvent.change(within(form).getByLabelText(`${field.label} (필수 입력)`), { target: { value: field.options[0]!.optionId } });
    await pickDateTime(/^희망 픽업 날짜 /, /^희망 픽업 시각 /, '2026-11-17', '09:00');
    fireEvent.click(within(form).getByRole('button', { name: '주문 접수하기' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('지난 시간에는 새 예약을 넣을 수 없어요');
    expect(port.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'customOrder.create' }));
  });
});

describe('custom-order templates tab', () => {
  it('hints what to type in the two fields and names the missing one on its own field', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: '템플릿 관리' }));
    const kind = screen.getByLabelText('상품 종류');
    expect(kind).toHaveAccessibleDescription('템플릿 이름이 ‘상품 종류 + 주문서’로 만들어져요');
    expect(screen.getByLabelText('키워드')).toHaveAccessibleDescription('템플릿 이름 뒤에 붙어요(선택)');
    fireEvent.click(screen.getByRole('button', { name: '양식 견본 만들기' }));
    expect(screen.getByLabelText('상품 종류')).toHaveAccessibleDescription(/상품 종류를 넣어 주세요/);
    expect(screen.queryByText('필수 항목을 모두 넣어 주세요')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '템플릿 만들기' }));
    fireEvent.click(screen.getByRole('button', { name: '템플릿 저장하기' }));
    expect(within(screen.getByRole('form', { name: '템플릿 만들기' })).getByRole('alert')).toHaveTextContent('필수 항목을 모두 넣어 주세요');
  });
  it('uses the kit checkbox for 필수 입력 and for the multiple-choice answers', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: '템플릿 관리' }));
    fireEvent.click(screen.getByRole('button', { name: '템플릿 만들기' }));
    const form = screen.getByRole('form', { name: '템플릿 만들기' });
    const required = within(form).getByRole('checkbox', { name: '필수 입력' });
    expect(required.closest('.ui-check')).not.toBeNull();
    fireEvent.click(required);
    expect(required).toBeChecked();
  });
});

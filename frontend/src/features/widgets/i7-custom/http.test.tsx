import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetDetailProps } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { selectCustomOrderRead } from '../../../data/pos/projection';
import { WidgetDataProvider } from '../../../data/react';
import { createRealPort, type PortFiles } from '../../../data/reality/00';
import { reply } from '../../../data/reality/00/testing';
import { customAdapter } from '../../../data/reality/08/adapter';
import { customService, textField } from '../../../data/reality/08/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { CustomOrderProvider, type CustomOrderPort } from './port';
import { ReferencePhotoPicker } from './reference-photos';
import { CustomOrderDetail } from './widget';
import { useState } from 'react';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
const props = { featureId: 'custom-order', condition: { kind: 'default' }, detailRef: { featureId: 'custom-order' }, host } as WidgetDetailProps;

function session(backend: ReturnType<typeof customService>['backend']) {
  const store = createWidgetDataStore(undefined, { runId: 'custom-ui' });
  const port = createRealPort({ store, source: domain => domain === 'custom' ? 'http' : 'fixture', adapters: [customAdapter], fetch: backend.fetch, sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  return { store, port };
}

/** The owner has already taken an order and the customer approved a 45,000 won quote paid in advance (made through the same commands, in another session). */
async function approvedOrder(memberId: string | null = null) {
  const svc = customService();
  if (memberId) svc.setMember(memberId, { charge: 30000 });
  const seeding = session(svc.backend);
  await seeding.port.load('custom');
  await seeding.store.execute({ type: 'customTemplate.save', name: '케이크 주문서', fields: [textField], idempotencyKey: 't' });
  const created = await seeding.store.execute({ type: 'customOrder.create', templateId: 'tpl-1', answers: { note: '축하해요' }, channel: 'phone', memberId, guest: memberId ? null : { name: '가나다', phone: '010-1234-5678' },
    productLabel: '45,000원 케이크', options: [], quantity: 1, request: '', referencePhotoKeys: [], desiredPickupAt: '2026-11-21T17:00', idempotencyKey: 'o' });
  const customOrderId = (created as { value: { customOrderId: string } }).value.customOrderId;
  await seeding.store.execute({ type: 'customOrder.quote', customOrderId, quoteAmount: 45000, proposedPickupAt: '2026-11-21T17:00', idempotencyKey: 'q' });
  await seeding.store.execute({ type: 'customOrder.recordDecision', customOrderId, quoteRevision: 1, decision: 'approved', paymentTiming: 'advance', idempotencyKey: 'd' });
  return { ...svc, customOrderId };
}

async function open(svc: Awaited<ReturnType<typeof approvedOrder>>) {
  const { store, port } = session(svc.backend);
  await port.load('custom');
  const base: CustomOrderPort = { read: () => selectCustomOrderRead(store.getSnapshot()), subscribe: store.subscribe, dispatch: vi.fn(() => ({ ok: false, reason: 'FIXTURE_ONLY' })),
    openSettlement: vi.fn(), openReversal: vi.fn() };
  renderWithKit(<WidgetDataProvider store={store}><CustomOrderProvider port={base}><CustomOrderDetail {...props} /></CustomOrderProvider></WidgetDataProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /CO-001/ }));
  return { store, base };
}

describe('custom orders in the browser on an HTTP build', () => {
  it('shows loading until the first read settles and retries a failed read from the detail', async () => {
    const svc = customService();
    const { store } = session(svc.backend);
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    svc.backend.on('GET', '/pos/custom-orders', async () => { await gate; return reply(503, {}); });
    const base: CustomOrderPort = { read: () => selectCustomOrderRead(store.getSnapshot()), subscribe: store.subscribe,
      dispatch: vi.fn(() => ({ ok: false })), openSettlement: vi.fn(), openReversal: vi.fn() };
    renderWithKit(<CustomOrderProvider port={base}><CustomOrderDetail {...props} /></CustomOrderProvider>, { store });
    expect(screen.getByText('주문제작을 불러오는 중이에요')).toBeVisible();
    expect(screen.queryByText('주문 접수하기')).not.toBeInTheDocument();
    release();
    const retry = await screen.findByRole('button', { name: /다시 시도하기/ });
    svc.backend.on('GET', '/pos/custom-orders', () => ({ items: [], nextCursor: null, asOf: '2026-11-21T08:00:00Z', sourceRevision: 1 }));
    fireEvent.click(retry);
    expect(await screen.findByText('아직 등록한 주문제작이 없어요')).toBeVisible();
    expect(svc.backend.callsTo('GET', '/pos/custom-orders')).toHaveLength(2);
  });
  it('records a cash deposit through the service, never through the simulated terminal, and the new session shows it paid', async () => {
    const svc = await approvedOrder();
    const { base } = await open(svc);
    expect(screen.getAllByText('결제 전').length).toBeGreaterThan(0);
    await userEvent.click(await screen.findByRole('button', { name: '결제 받기' }));
    const dialog = await screen.findByRole('dialog', { name: '주문제작 결제' });
    expect(dialog.querySelector('.shared-settlement')).toBeInTheDocument();
    expect(svc.backend.callsTo('POST', /\/payments$/)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: '현금' }));
    expect(await within(dialog).findByText('단말 결제를 기록했어요')).toBeInTheDocument();
    expect(base.openSettlement).not.toHaveBeenCalled();
    const quote = svc.backend.callsTo('POST', /settlement-quote$/);
    expect(quote).toHaveLength(1);
    expect(quote[0].body).toEqual({ allocations: [{ kind: 'method', method: 'cash', amount: 45000 }] });
    const payments = svc.backend.callsTo('POST', /\/payments$/);
    expect(payments).toHaveLength(1);
    expect(payments[0].body).toEqual({ quoteId: expect.any(String), allocations: [{ kind: 'method', method: 'cash', amount: 45000 }], expectedRevision: 3 });
    expect(host.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.custom.notice.paymentRecorded' }));
    await userEvent.click(within(dialog).getByText('닫기'));
    await waitFor(() => expect(screen.getAllByText('결제 완료').length).toBeGreaterThan(0));
    cleanup();

    const next = session(svc.backend);
    await next.port.load('custom');
    expect(selectCustomOrderRead(next.store.getSnapshot()).payments).toMatchObject({ [svc.customOrderId]: { status: 'paid', amountSettled: 45000 } });
  });

  it('asks for the terminal slip of a card deposit and refuses to send without it', async () => {
    const svc = await approvedOrder();
    await open(svc);
    await userEvent.click(await screen.findByRole('button', { name: '결제 받기' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: '주문제작 결제' })).getByRole('button', { name: '카드' }));
    const dialog = await screen.findByRole('dialog', { name: '단말 결제 기록' });
    expect(within(dialog).getByRole('button', { name: '이 내용으로 기록하기' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('단말기 승인 번호'), { target: { value: 'APR-7001' } });
    expect(within(dialog).getByRole('button', { name: '이 내용으로 기록하기' })).toBeDisabled();
    expect(svc.backend.callsTo('POST', /\/payments$/)).toHaveLength(0);
  });

  it('cancels a paid order only after the second confirmation and records the return once', async () => {
    const svc = await approvedOrder();
    const { store } = await open(svc);
    const paidQuote = await store.real!.transport.request<{ quoteId: string; quoteRevision: number }>({ method: 'POST', path: `/pos/custom-orders/${svc.customOrderId}/settlement-quote`, body: { allocations: [{ kind: 'method', method: 'cash', amount: 45000 }] } });
    await store.execute({ type: 'customOrder.recordPayment', customOrderId: svc.customOrderId, quoteId: paidQuote.quoteId, allocations: [{ kind: 'method', method: 'cash', amount: 45000 }], expectedRevision: paidQuote.quoteRevision, idempotencyKey: 'pay' });
    await userEvent.click(await screen.findByRole('button', { name: '주문 취소하기' }));
    const dialog = await screen.findByRole('alertdialog', { name: '결제 취소' });
    await within(dialog).findByText('현금');
    expect(within(dialog).getByText('연결된 주문제작과 픽업 예약도 함께 취소해요')).toBeInTheDocument();
    expect(svc.backend.callsTo('POST', /\/corrections$/)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: '취소 확정하기' }));
    // The order row changes (canceled) under the dialog; the owner still reads the confirmation.
    expect(await screen.findByText('취소했어요')).toBeInTheDocument();
    const corrections = svc.backend.callsTo('POST', /\/corrections$/);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].body).toEqual({ quoteId: expect.any(String), kind: 'cancellation', confirmed: true, expectedRevision: 4 });
    expect(svc.orders[0].stage).toBe('canceled');
  });

  it('turns a second press on the same order action into one request while it is pending', async () => {
    const svc = await approvedOrder();
    const { store } = await open(svc);
    const quote = await store.real!.transport.request<{ quoteId: string; quoteRevision: number }>({ method: 'POST', path: `/pos/custom-orders/${svc.customOrderId}/settlement-quote`, body: { allocations: [{ kind: 'method', method: 'cash', amount: 45000 }] } });
    await store.execute({ type: 'customOrder.recordPayment', customOrderId: svc.customOrderId, quoteId: quote.quoteId, allocations: [{ kind: 'method', method: 'cash', amount: 45000 }], expectedRevision: quote.quoteRevision, idempotencyKey: 'pay' });
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const before = svc.backend.callsTo('POST', /\/transitions$/).length;
    svc.backend.on('POST', /\/transitions$/, async () => { await gate; return { resourceId: 'x', revision: 9, receiptId: 'r', affectedSources: ['custom-order'], changed: true, customOrderId: svc.customOrderId }; });
    const button = await screen.findByRole('button', { name: '제작 완료로 바꾸기' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(svc.backend.callsTo('POST', /\/transitions$/).length).toBe(before + 1));
    // Pending: nothing is shown as recorded yet, and the second press added no request.
    expect(screen.queryByText('기록했어요')).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.getByText('기록했어요')).toBeInTheDocument());
    expect(svc.backend.callsTo('POST', /\/transitions$/).length).toBe(before + 1);
  });
});

describe('member value on a custom order (B08-2)', () => {
  const memberId = 'member-1';
  const payWithValue = async (svc: Awaited<ReturnType<typeof approvedOrder>>) => {
    await userEvent.click(await screen.findByRole('button', { name: '결제 받기' }));
    const dialog = await screen.findByRole('dialog', { name: '주문제작 결제' });
    fireEvent.change(await within(dialog).findByRole('spinbutton', { name: '충전금 사용' }), { target: { value: '30000' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: '외상 정산' }), { target: { value: '15000' } });
    expect(svc.backend.callsTo('POST', /\/payments$/)).toHaveLength(0);
    return dialog;
  };

  it('shows what the member account will do before recording, then records once and the receipt undo restores both balances', async () => {
    const svc = await approvedOrder(memberId);
    const { store } = await open(svc);
    const dialog = await payWithValue(svc);
    await userEvent.click(within(dialog).getByRole('button', { name: '결제하기' }));
    // The quote names each effect on the member's account; nothing is recorded yet.
    expect(await within(dialog).findByText('충전금 30,000원 쓰기')).toBeInTheDocument();
    expect(within(dialog).getByText('외상 15,000원 생김')).toBeInTheDocument();
    expect(svc.backend.callsTo('POST', /\/payments$/)).toHaveLength(0);
    expect(svc.member(memberId)).toMatchObject({ charge: 30000, receivable: 0 });
    await userEvent.click(within(dialog).getByRole('button', { name: '이 내용으로 기록하기' }));
    expect(await within(dialog).findByText('단말 결제를 기록했어요')).toBeInTheDocument();
    const payments = svc.backend.callsTo('POST', /\/payments$/);
    expect(payments).toHaveLength(1);
    expect(payments[0].body).toEqual({ quoteId: expect.any(String), allocations: [{ kind: 'charge', amount: 30000 }, { kind: 'receivable', amount: 15000 }], expectedRevision: 3 });
    expect(svc.member(memberId)).toMatchObject({ charge: 0, receivable: 15000 });
    // A payment of member value alone has no tender: the receipt is the settlement and it carries the undo.
    const notice = host.notify.mock.calls.map(call => call[0]).find(call => call.messageKey === 'data.custom.notice.paymentRecorded');
    expect(notice).toMatchObject({ undoToken: expect.stringMatching(/^real-undo:/), undoUntil: '2999-01-01T00:00:00Z' });
    expect((await store.real!.undo(notice!.undoToken!))).toMatchObject({ ok: true });
    expect(svc.member(memberId)).toMatchObject({ charge: 30000, receivable: 0 });
    expect(svc.orders[0].payment).toMatchObject({ status: 'unpaid', chargeApplied: 0, receivableAmount: 0 });
    expect(svc.backend.callsTo('GET', `/pos/member-accounts/${memberId}`).length).toBeGreaterThan(0);
  });

  it('does not offer member value, and refuses an oversized charge, for an order without a linked member', async () => {
    const svc = await approvedOrder();
    await open(svc);
    await userEvent.click(await screen.findByRole('button', { name: '결제 받기' }));
    const dialog = await screen.findByRole('dialog', { name: '주문제작 결제' });
    expect(within(dialog).queryByRole('spinbutton', { name: '충전금 사용' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('spinbutton', { name: '외상 정산' })).not.toBeInTheDocument();
    expect(svc.backend.callsTo('GET', /member-accounts/)).toHaveLength(0);
  });

  it('keeps the charge choice from spending more than the balance', async () => {
    const svc = await approvedOrder(memberId);
    await open(svc);
    await userEvent.click(await screen.findByRole('button', { name: '결제 받기' }));
    const dialog = await screen.findByRole('dialog', { name: '주문제작 결제' });
    fireEvent.change(await within(dialog).findByRole('spinbutton', { name: '충전금 사용' }), { target: { value: '45000' } });
    expect(await within(dialog).findByText('충전금 잔액 30,000원까지 쓸 수 있어요')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '결제하기' })).toBeDisabled();
  });

  it('shows the reversal on the member account, and stops a cancellation whose debt was already collected', async () => {
    const svc = await approvedOrder(memberId);
    const { store } = await open(svc);
    const quote = await store.real!.transport.request<{ quoteId: string; quoteRevision: number }>({ method: 'POST', path: `/pos/custom-orders/${svc.customOrderId}/settlement-quote`,
      body: { allocations: [{ kind: 'charge', amount: 30000 }, { kind: 'receivable', amount: 15000 }] } });
    await store.execute({ type: 'customOrder.recordPayment', customOrderId: svc.customOrderId, quoteId: quote.quoteId, allocations: [{ kind: 'charge', amount: 30000 }, { kind: 'receivable', amount: 15000 }],
      expectedRevision: quote.quoteRevision, idempotencyKey: 'pay' });
    await userEvent.click(await screen.findByRole('button', { name: '주문 취소하기' }));
    let dialog = await screen.findByRole('alertdialog', { name: '결제 취소' });
    expect(await within(dialog).findByText('충전금 잔액 30,000원이 돌아가요')).toBeInTheDocument();
    expect(within(dialog).getByText('미수금 15,000원이 줄어들어요')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '닫기' }));

    // The debt was paid back meanwhile: the service refuses the return until that collection is reversed.
    svc.setMember(memberId, { charge: 0, receivable: 15000, collected: true });
    await userEvent.click(await screen.findByRole('button', { name: '주문 취소하기' }));
    dialog = await screen.findByRole('alertdialog', { name: '결제 취소' });
    expect(await within(dialog).findByText(/이미 수금했어요/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '취소 확정하기' })).toBeDisabled();
    expect(svc.backend.callsTo('POST', /\/corrections$/)).toHaveLength(0);
  });
});

describe('reference photos', () => {
  it('picks, shrinks and lists photos as data URLs and lets the owner take one out', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2000, height: 1000, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');
    const files = { readUrl: vi.fn(), upload: vi.fn(), uploadDataUrl: vi.fn(), revoke: vi.fn() } as unknown as PortFiles;
    let latest: readonly string[] = [];
    function Host() {
      const [values, setValues] = useState<readonly string[]>([]);
      latest = values;
      return <ReferencePhotoPicker files={files} values={values} onChange={setValues} />;
    }
    renderWithKit(<Host />);
    const input = screen.getByLabelText('참고 사진 올리기', { selector: 'input' });
    fireEvent.change(input, { target: { files: [new File(['x'], 'cake.png', { type: 'image/png' })] } });
    await waitFor(() => expect(latest).toEqual(['data:image/jpeg;base64,AAAA']));
    expect(screen.getByRole('img', { name: '참고 사진 1' })).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
    expect(files.uploadDataUrl).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File(['x'], 'note.txt', { type: 'text/plain' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('PNG, JPEG, WebP 사진만 넣을 수 있어요');
    await userEvent.click(screen.getByRole('button', { name: '참고 사진 1 빼기' }));
    expect(latest).toEqual([]);
  });
});

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { beginDashboard } from '../../../app/test-session';
import { getRegistry } from '../../../catalog';
import { WidgetDataProvider } from '../../../data/react';
import { createWidgetDataStore } from '../../../data/widget-data';
import { screenPresets } from '../../../layout';
import { createRunStore, selectCommonNoticePresentation } from '../../../state';
import { timePolicy, UiProvider } from '../../../ui';
import { AiConversation } from '../conversation';
import { session as moneySession } from '../../../data/reality/09/testing';
import type { ExpenseDto } from '../../../data/reality/09/dto';

const photo = new File(['receipt'], 'receipt.png', { type: 'image/png' });
const response = () => Response.json({
  requestId: 'receipt-fixture',
  merchant: { value: '인식된 거래처', needsReview: true },
  date: { value: '2026-11-17', needsReview: true },
  totalWon: { value: 12_000, needsReview: true },
  items: [{ name: { value: '원두', needsReview: false }, quantity: null, amountWon: null }],
});

function setup() {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  const { runId, pos } = run.getState();
  const store = createWidgetDataStore(undefined, { runId, pos });
  const submit = vi.fn();
  const close = vi.fn();
  const conversation = (surfaceVisible = true) => <WidgetDataProvider store={store}>
    <UiProvider screenPreset={screenPresets.A} reducedMotion>
      <AiConversation messages={[]} draft="응" phase="idle" onDraftChange={vi.fn()} onSubmit={submit}
        onCancel={vi.fn()} onClose={close} surfaceVisible={surfaceVisible} receiptContext={{ run, store }} />
    </UiProvider>
  </WidgetDataProvider>;
  const view = render(conversation());
  return { ...view, close, conversation, run, store, submit };
}

function attach(view: ReturnType<typeof setup>, file = photo) {
  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]:not([capture])');
  expect(input).toBeInTheDocument();
  fireEvent.change(input!, { target: { files: [file] } });
}
const button = (name: string) => screen.getByRole('button', { name });
const save = () => button('지출 기록하기');
const chooseCategory = () => fireEvent.click(screen.getByRole('radio', { name: '원재료' }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('maps the receipt through the OCR route and writes one expense using the edited fields on the card press', async () => {
  const fetcher = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetcher);
  const view = setup();
  const before = view.store.getSnapshot();
  const dispatch = vi.spyOn(view.store, 'dispatch');
  expect(button('영수증 사진 올리기')).toBeEnabled();
  attach(view);
  expect(screen.getByText('영수증을 읽고 있어요')).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/navis/media/receipt-ocr', expect.objectContaining({
    body: photo, method: 'POST', signal: expect.any(AbortSignal),
  }));
  const merchant = await screen.findByRole('textbox', { name: '거래처' });
  expect(merchant).toHaveValue('인식된 거래처');
  expect(merchant).toHaveAccessibleDescription('확인해 주세요');
  expect(screen.getByRole('textbox', { name: '메모' })).toHaveValue('원두');
  expect(screen.getByRole('spinbutton', { name: '금액' })).toHaveValue(12_000);
  expect(save()).toBeDisabled();
  chooseCategory();
  expect(save()).toBeEnabled();
  fireEvent.change(merchant, { target: { value: '확인한 거래처' } });
  expect(merchant).not.toHaveAccessibleDescription();
  fireEvent.change(screen.getByRole('textbox', { name: '메모' }), { target: { value: '확인한 품목' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: '금액' }), { target: { value: '13000' } });
  fireEvent.click(button('요청 보내기'));
  expect(view.submit).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
  expect(view.store.getSnapshot()).toBe(before);
  const approval = save();
  fireEvent.click(approval);
  fireEvent.click(approval);
  expect(dispatch).toHaveBeenCalledOnce();
  const after = view.store.getSnapshot();
  expect(after.tables.expense).toHaveLength(before.tables.expense.length + 1);
  expect(after.tables.expense.at(-1)).toMatchObject({
    businessDate: '2026-11-17', amount: 13_000, category: 'ingredients',
    memo: { raw: '확인한 거래처 · 확인한 품목' },
  });
  expect(screen.getByText(/지출을 기록했어요.*13,000원.*확인한 거래처.*확인한 품목/u)).toBeInTheDocument();
  expect(screen.queryByText(/인식된 거래처|12,000원/u)).not.toBeInTheDocument();
  expect(selectCommonNoticePresentation(view.run.getState())).toBeNull();
  fireEvent.click(button('되돌리기'));
  expect(view.store.getSnapshot().tables.expense).toEqual(before.tables.expense);
});

it('keeps a future date invalid even when OCR marks it confident', async () => {
  const future = { ...await response().json(), date: { value: '2026-11-18', needsReview: false } };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(future)));
  const view = setup();
  const before = view.store.getSnapshot();
  attach(view);
  await screen.findByRole('spinbutton', { name: '금액' });
  chooseCategory();
  expect(save()).toBeDisabled();
  expect(view.store.getSnapshot()).toBe(before);
});

it.each([['0', 'zero'], ['3.5', 'fractional']])('rejects amount %s (%s)', async value => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
  const view = setup();
  attach(view);
  fireEvent.change(await screen.findByRole('spinbutton', { name: '금액' }), { target: { value } });
  chooseCategory();
  expect(save()).toBeDisabled();
});

it('offers both photo retries and opens a blank manual card if OCR fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 422 })));
  const view = setup();
  const before = view.store.getSnapshot();
  attach(view);
  await screen.findByText('영수증을 읽지 못했어요. 직접 입력해 주세요');
  expect(button('다시 찍기')).toBeEnabled();
  expect(button('사진 고르기')).toBeEnabled();
  expect(screen.queryByText('영수증을 읽고 있어요')).not.toBeInTheDocument();
  fireEvent.click(button('직접 입력하기'));
  expect(screen.getByRole('textbox', { name: '거래처' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: '메모' })).toHaveValue('');
  expect(screen.getByRole('spinbutton', { name: '금액' })).toHaveValue(null);
  expect(screen.getAllByRole('radio').every(radio => radio.getAttribute('aria-checked') === 'false')).toBe(true);
  expect(save()).toBeDisabled();
  expect(view.store.getSnapshot()).toBe(before);
});

it('leaves unread optional fields blank on a partial receipt', async () => {
  const partial = { ...await response().json(), merchant: null, items: [] };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(partial)));
  const view = setup();
  attach(view);
  expect(await screen.findByRole('textbox', { name: '거래처' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: '메모' })).toHaveValue('');
  chooseCategory();
  expect(save()).toBeEnabled();
});

it('revokes the local thumbnail after removal and sends the photo only to OCR', async () => {
  const fetcher = vi.fn().mockResolvedValue(response());
  const revoke = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = () => 'blob:receipt-preview';
    static revokeObjectURL = revoke;
  });
  const view = setup();
  attach(view);
  await screen.findByRole('textbox', { name: '거래처' });
  expect(view.container.querySelector('.ai-photo__thumb img')).toHaveAttribute('src', 'blob:receipt-preview');
  fireEvent.click(button('사진 빼기'));
  expect(view.container.querySelector('.ai-photo__thumb img')).toBeNull();
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:receipt-preview');
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/navis/media/receipt-ocr', expect.objectContaining({ body: photo }));
});

it.each(['stop', 'send', 'hide', 'close', 'layer change'] as const)('discards a late OCR result after %s', async action => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(
    () => new Promise<Response>(accept => { resolve = accept; }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = setup();
  const before = view.store.getSnapshot();
  attach(view);
  if (action === 'stop') fireEvent.keyDown(view.container.querySelector('textarea')!, { key: 'Escape' });
  else if (action === 'send') fireEvent.click(button('요청 보내기'));
  else if (action === 'hide') view.rerender(view.conversation(false));
  else if (action === 'layer change') act(() => { view.run.actions.switchLayer('marketing'); });
  else view.unmount();
  expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  await act(async () => resolve(response()));
  expect(screen.queryByText('영수증을 읽고 있어요')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: '거래처' })).not.toBeInTheDocument();
  expect(view.store.getSnapshot()).toBe(before);
});

it('keeps the card pending until the finance service answers, sends one request, then shows the saved receipt with its server undo', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => 0, reducedMotion: true });
  beginDashboard(run, 'cafe');
  const { runId, pos } = run.getState();
  const { store, backend, state } = await moneySession({ runId, pos });
  let answer!: () => void;
  const gate = new Promise<void>(resolve => { answer = resolve; });
  backend.on('POST', '/pos/expenses', async call => {
    const body = call.body as { date: string; category: ExpenseDto['category']; amount: number; evidence: ExpenseDto['evidence'] };
    await gate;
    state.expenses.push({ expenseId: 'expense-chat', businessDate: body.date, category: body.category, amount: body.amount, evidence: body.evidence, memo: null, supplierId: null, receiptId: null, status: 'confirmed', revision: 1 });
    return { resourceId: 'expense-chat', revision: 1, receiptId: 'receipt-chat', undoUntil: '2999-01-01T00:00:00Z', affectedSources: ['pos.expenses', 'pos.ledger', 'pos.finance'] };
  });
  const submit = vi.fn();
  render(<WidgetDataProvider store={store}><UiProvider screenPreset={screenPresets.A} reducedMotion>
    <AiConversation messages={[]} draft="응" phase="idle" onDraftChange={vi.fn()} onSubmit={submit} onCancel={vi.fn()} onClose={vi.fn()} surfaceVisible receiptContext={{ run, store }} />
  </UiProvider></WidgetDataProvider>);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]:not([capture])')!;
  fireEvent.change(input, { target: { files: [photo] } });
  await screen.findByRole('textbox', { name: '거래처' });
  chooseCategory();
  fireEvent.click(save());
  // Pending: no request has finished, nothing is reported as saved, and the card cannot be pressed twice.
  await vi.waitFor(() => expect(backend.callsTo('POST', '/pos/expenses')).toHaveLength(1));
  expect(save()).toBeDisabled();
  expect(screen.queryByText(/기록했어요/)).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => { answer(); await gate; });
  await vi.waitFor(() => expect(screen.queryByRole('spinbutton', { name: '금액' })).not.toBeInTheDocument());
  expect(backend.callsTo('POST', '/pos/expenses')).toHaveLength(1);
  expect(store.getSnapshot().tables.expense.some(row => row.expenseId === 'expense-chat')).toBe(true);
});

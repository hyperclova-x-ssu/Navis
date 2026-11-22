import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { addIsoDays } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import { LedgerDetail } from './ledger';
import { openReceipt } from './test-values';

const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const proposal = {
  requestId: 'scan-1',
  merchant: { value: '시험 거래처', needsReview: true },
  date: { value: TODAY, needsReview: false },
  totalWon: { value: 39_700, needsReview: false },
  items: [{ name: { value: '원두', needsReview: false }, quantity: null, amountWon: { value: 39_700, needsReview: false } }],
};
const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'synthetic.jpg', { type: 'image/jpeg' });
const upload = () => fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [photo] } });
const amount = () => screen.getByRole('spinbutton', { name: /금액/ });
const save = () => screen.getByRole('button', { name: '저장하기' });
const open = (store = createWidgetDataStore()) => {
  renderWithKit(<LedgerDetail featureId="ledger" condition={{ kind: 'default' }} detailRef={{ featureId: 'ledger', view: 'expenses', focus: 'action' }} host={host} />, { store, reducedMotion: true });
  expect(screen.getByRole('button', { name: '영수증 찍기' })).toBeEnabled();
  return store;
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('fills editable suggestions without touching the inventory candidate and saves one expense on repeated presses', async () => {
  const store = createWidgetDataStore();
  expect(store.dispatch({ type: 'suppliers.recordReceipt', ...openReceipt(store), idempotencyKey: 'ocr-inventory-test' }).ok).toBe(true);
  const before = store.getSnapshot().tables.expense;
  const candidate = before.find(row => row.status === 'candidate')!;
  expect(candidate.receiptId).toBeTruthy();
  open(store);
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  upload();
  expect(screen.getByText('영수증을 읽고 있어요')).toHaveAttribute('role', 'status');
  expect(screen.getByRole('button', { name: '영수증 찍기' })).toBeDisabled();
  expect(amount()).toBeEnabled();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/navis/media/receipt-ocr', expect.objectContaining({ method: 'POST', body: photo, headers: { 'Content-Type': 'image/jpeg' }, signal: expect.any(AbortSignal) }));
  await act(async () => { finish(Response.json(proposal)); });
  expect(screen.queryByText('영수증을 읽고 있어요')).not.toBeInTheDocument();
  expect(screen.getByText('읽은 내용이에요. 확인하고 저장해 주세요')).toBeInTheDocument();
  const merchant = screen.getByRole('textbox', { name: '거래처' });
  expect(merchant).toHaveValue('시험 거래처');
  expect(merchant).toHaveAccessibleDescription('확인해 주세요');
  expect(amount()).toHaveValue(39_700);
  expect((screen.getByRole('textbox', { name: /메모/ }) as HTMLInputElement).value).toContain('원두');
  expect(store.getSnapshot().tables.expense).toEqual(before);
  fireEvent.change(merchant, { target: { value: '고친 거래처' } });
  expect(merchant).not.toHaveAccessibleDescription();
  const submit = save();
  act(() => { submit.click(); submit.click(); submit.click(); });
  const after = store.getSnapshot().tables.expense;
  expect(after).toHaveLength(before.length + 1);
  expect(after.find(row => row.expenseId === candidate.expenseId)).toEqual(candidate);
  expect(after.at(-1)).toMatchObject({ businessDate: TODAY, amount: 39_700, evidence: 'receipt', receiptId: null, supplierId: null, memo: { raw: expect.stringContaining('고친 거래처') } });
});

it('leaves unreadable fields blank and marks them for review', async () => {
  const store = open();
  const before = store.getSnapshot().tables.expense;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...proposal, date: null, totalWon: null, items: [] })));
  upload();
  await screen.findByText('읽은 내용이에요. 확인하고 저장해 주세요');
  const form = screen.getByRole('form', { name: '지출 기록하기' });
  const date = within(form).getByRole('button', { name: '날짜 날짜 고르기' });
  expect(date).toHaveAccessibleDescription('확인해 주세요');
  expect(date.querySelector('[data-empty]')).toHaveAttribute('data-empty', 'true');
  expect(amount()).toHaveValue(null);
  expect(amount()).toHaveAccessibleDescription('확인해 주세요');
  expect(screen.getByRole('textbox', { name: /메모/ })).toHaveValue('');
  expect(store.getSnapshot().tables.expense).toEqual(before);
});

it('preserves fields edited during a scan and marks them for review', async () => {
  open();
  const expense = screen.getByRole('form', { name: '지출 기록하기' });
  const form = within(expense);
  const memo = form.getByRole('textbox', { name: /메모/ });
  const merchant = form.getByRole('textbox', { name: '거래처' });
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  upload();
  fireEvent.click(form.getByRole('button', { name: '이전 날짜' }));
  fireEvent.change(amount(), { target: { value: '22500' } });
  fireEvent.change(amount(), { target: { value: '' } });
  fireEvent.change(memo, { target: { value: '직접 입력한 메모' } });
  fireEvent.click(form.getByRole('radio', { name: '증빙 없음' }));
  await act(async () => { finish(Response.json({ ...proposal, merchant: { value: '시험 거래처', needsReview: false } })); });

  expect(expense).toHaveFormValues({ 'expense-date': addIsoDays(TODAY, -1) });
  const date = form.getByRole('button', { name: /^날짜 / });
  expect(date).toHaveAccessibleDescription('확인해 주세요');
  expect(amount()).toHaveValue(null);
  expect(amount()).toHaveAccessibleDescription('확인해 주세요');
  expect(memo).toHaveValue('직접 입력한 메모');
  expect(memo).toHaveAccessibleDescription('확인해 주세요');
  expect(form.getByRole('radio', { name: '증빙 없음' })).toBeChecked();
  expect(form.getByRole('group', { name: '증빙' })).toHaveAccessibleDescription('확인해 주세요');
  expect(merchant).toHaveValue('시험 거래처');
  expect(merchant).not.toHaveAccessibleDescription();

  upload();
  await act(async () => { finish(Response.json(proposal)); });
  expect(amount()).toHaveValue(39_700);
  expect(amount()).not.toHaveAccessibleDescription();
});

it('falls back to manual entry after unreadable media', async () => {
  const store = open();
  const before = store.getSnapshot().tables.expense.length;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'MEDIA_UNREADABLE', requestId: 'bad' }, { status: 422 })));
  upload();
  expect(await screen.findByText('영수증을 읽지 못했어요. 직접 입력해 주세요')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '다시 시도하기' })).toBeEnabled();
  expect(screen.queryByText('영수증을 읽고 있어요')).not.toBeInTheDocument();
  expect(store.getSnapshot().tables.expense).toHaveLength(before);
  fireEvent.change(amount(), { target: { value: '39700' } });
  fireEvent.click(save());
  expect(store.getSnapshot().tables.expense).toHaveLength(before + 1);
});

it('aborts a closed scan and ignores its late result after reopening', async () => {
  open();
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  upload();
  const signal = fetcher.mock.calls[0]![1].signal;
  fireEvent.click(within(screen.getByRole('form', { name: '지출 기록하기' })).getByRole('button', { name: '닫기' }));
  expect(signal?.aborted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '지출 기록하기' }));
  await act(async () => { finish(Response.json(proposal)); });
  expect(amount()).toHaveValue(null);
  expect(screen.queryByText('읽은 내용이에요. 확인하고 저장해 주세요')).not.toBeInTheDocument();
});

// T-52 (D-381/D-382, W05-F5): the entry says the original photo is not kept after it is read (WIDGET_FUNCTIONS: "원본 사진은 읽은 뒤 남지 않습니다").
it('says before a photo is chosen that the original photo is not kept after reading', () => {
  open();
  expect(screen.getByText('원본 사진은 읽은 뒤 남지 않아요')).toBeInTheDocument();
});

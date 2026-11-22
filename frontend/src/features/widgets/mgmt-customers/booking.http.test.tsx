import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { bookingService, candidate, naver, undoUntil, visit, type BookingSeed } from '../../../data/reality/06/testing';
import { addIsoDays } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import { NAVER_BOOKING_EXPORT_URL, VoiceBookingDetail } from './voice-booking';

afterEach(cleanup);

const day = { date: TODAY };
const future = { ...day, time: '19:00' };
const TABLE_UUID = '3f6c0a52-5b0e-4f5c-9c5b-0d6b8a1a2b3c';
const naverMeta = (bookingNumber: string, product: string, npayLinked: boolean, paymentAmount?: number) => ({ kind: 'naver' as const, bookingNumber, product, npayLinked, ...(paymentAmount === undefined ? {} : { paymentAmount }) });
const seed = (): BookingSeed => ({
  reservations: [
    visit({ reservationId: 'rv-local', ...future, guestName: '김하나', phone: '01099990000', partySize: 2, tableId: TABLE_UUID, revision: 3 }),
    naver('1001', { ...future, time: '18:30', revision: 4 }),
    // confirmed + Npay without a payment amount: refund terms are due, but only full or a rate can be offered (no amount to bound an amount by)
    naver('1002', { ...future, time: '20:00', status: 'confirmed', partySize: 2, guestName: '이○○', phone: '010-****-1111', revision: 2, sourceMetadata: naverMeta('1002', '런치 세트', true) }),
    // confirmed + Npay with the payment amount the provider shows: all three terms, an amount bounded by it
    naver('1003', { ...future, time: '21:00', status: 'confirmed', partySize: 2, guestName: '최○○', phone: '010-****-3333', revision: 6, sourceMetadata: naverMeta('1003', '런치 세트', true, 30000) }),
    // requested + Npay: not confirmed, so nothing was paid through it yet and the cancel takes the reason alone
    naver('1005', { ...future, time: '22:00', partySize: 2, guestName: '한○○', phone: '010-****-5555', revision: 3, sourceMetadata: naverMeta('1005', '런치 세트', true) }),
    naver('1004', { ...future, time: '17:00', status: 'completed', partySize: 2, guestName: '정○○', phone: '010-****-4444', revision: 2 }),
    // completed + Npay with the payment amount: the service still lists it as cancellable, with refund terms (B06-3); a finished booking has no name or number from NAVER
    naver('1006', { ...future, time: '16:00', status: 'completed', guestName: null, phone: null, revision: 8, sourceMetadata: naverMeta('1006', '런치 세트', true, 4500) }),
    // an already cancelled one: nothing more to do
    naver('1009', { ...future, time: '15:00', status: 'canceled', guestName: null, phone: null, revision: 9 }),
  ],
  suggestions: [candidate('sg-1', { ...day, time: '19:30', partySize: 4, revision: 5 })],
  // SmartCall: daily aggregates only
  calls: [
    { date: TODAY, totalCalls: 5, connectedCalls: 3, arsCalls: 1, missedCalls: 1, busyCalls: 0, averageDurationSeconds: 80, callsAtLeastTenSeconds: 2 },
    { date: addIsoDays(TODAY, -1), totalCalls: 3, connectedCalls: 1, arsCalls: 0, missedCalls: 1, busyCalls: 1, averageDurationSeconds: null, callsAtLeastTenSeconds: 0 },
  ],
  products: [{ name: '저녁 코스' }, { name: '런치 세트' }],
  tables: [{ tableId: TABLE_UUID, label: '창가 1', seats: 4, layoutTableId: 'T2' }],
});

function setup(data: BookingSeed = seed(), itemId?: string, locale?: 'ko' | 'en' | 'zh-Hans' | 'zh-Hant') {
  const service = bookingService(data);
  const mount = () => {
    const store = createWidgetDataStore();
    // the store's table map (the account domain's profile in the app): the booking widget shows its table column and selects only with one
    const transaction = { transactionId: 'enable-tables', runId: store.getSnapshot().runId!, expectedDataRevision: store.getSnapshot().revision, expectedRunRevision: 0, transitionToken: 'enable-tables' };
    const prepared = store.session.prepare(transaction, { type: 'shop.updateSettings', businessType: 'restaurant', paymentStyle: 'postpaid',
      tableLayout: { layoutId: 'tables', columns: 9, rows: 6, revision: 0, tables: [{ tableId: 'T2', number: 2, seats: 4, column: 0, row: 0 }] } });
    if (!prepared.ok) throw new Error(prepared.reason);
    store.session.publish(prepared.change);
    store.session.flush(transaction.transactionId);
    const port = createRealPort({ store, fetch: service.backend.fetch, source: domain => domain === 'booking' ? 'http' : 'fixture',
      adapters: autoloadedAdapters().filter(adapter => adapter.domain === 'booking'), sleep: async () => {}, reconcileDelaysMs: [0] });
    store.bindReal(port);
    const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
    const view = renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{ kind: 'default' }}
      detailRef={itemId ? { featureId: 'voice-booking', itemId } : { featureId: 'voice-booking' }} host={host} />, { store, ...(locale ? { locale } : {}) });
    return { store, host, ...view };
  };
  return { service, ...mount(), mount };
}
const row = (id: string) => document.querySelector(`[data-grid-row="${id}"]`) as HTMLElement;
const cell = (id: string, column: string) => document.querySelector(`[data-grid-row="${id}"] [data-grid-column-id="${column}"]`) as HTMLElement;
const panelOf = async (title: RegExp | string) => within(await screen.findByRole('region', { name: title }));
const transitions = (service: ReturnType<typeof bookingService>, id: string) => service.backend.callsTo('POST', `/reservations/${encodeURIComponent(id)}/transitions`);

it('finds the selected date and the displayed reservation status without writing', async () => {
  const { service } = setup();
  await waitFor(() => expect(row('naver-1004')).not.toBeNull());
  const search = screen.getByRole('searchbox', { name: '예약 찾기' });
  fireEvent.change(search, { target: { value: TODAY } });
  expect(row('rv-local')).toBeInTheDocument();
  fireEvent.change(search, { target: { value: '방문 완료' } });
  expect(row('naver-1004')).toBeInTheDocument();
  expect(row('naver-1006')).toBeInTheDocument();
  expect(row('rv-local')).toBeNull();
  expect(service.backend.callsTo('POST', /./u)).toHaveLength(0);
});

it('shows NAVER bookings with their number, product and Npay lock, no party that NAVER did not give, and only the official Excel export link', async () => {
  const { service } = setup();
  const grid = await screen.findByRole('grid', { name: '예약 목록' });
  await waitFor(() => expect(row('naver-1001')).not.toBeNull());
  expect(cell('naver-1001', 'number')).toHaveTextContent('1001');
  expect(cell('naver-1001', 'product')).toHaveTextContent('저녁 코스');
  expect(cell('naver-1001', 'party')).toHaveTextContent('—');
  expect(cell('naver-1001', 'path')).toHaveTextContent('네이버 예약');
  expect(cell('naver-1002', 'npay')).toHaveTextContent('Npay 결제');
  expect(cell('naver-1001', 'npay')).not.toHaveTextContent('Npay');
  expect(cell('sg-1', 'path')).toHaveTextContent('전화 예약 요청');
  expect(cell('rv-local', 'path')).toHaveTextContent('직접 추가함');
  // the POS table label is what the owner reads, never the service's table UUID
  expect(cell('rv-local', 'table')).toHaveTextContent('창가 1');
  expect(document.body.textContent).not.toContain(TABLE_UUID);
  // SmartCall is daily aggregates of the period only: totals, one row per day, and no call content of any kind
  const calls = screen.getByRole('region', { name: '스마트콜 통화' });
  expect(calls).toHaveTextContent('통화 8건 · 부재중 2건');
  expect(calls).toHaveTextContent('네이버 검색');
  expect(within(calls).getAllByRole('row')).toHaveLength(1 + 2);
  expect(within(calls).getByRole('columnheader', { name: '10초 이상' })).toBeInTheDocument();
  expect(within(calls).getByText('80초')).toBeInTheDocument();
  expect(calls).toHaveTextContent('통화 내용은 없어요');
  expect(screen.queryByText(/통화 요약|전화 연결됨|녹음|원음/u)).toBeNull();
  // the booking products show their names and nothing else the provider does not give
  const products = screen.getByText(/^예약 상품/u).closest('details')!;
  expect(within(products).getByText('저녁 코스')).toBeInTheDocument();
  expect(products).not.toHaveTextContent(/분|예약금|선결제|메뉴|옵션|결제 요청/u);
  expect(screen.queryByText(/결제 요청|이용 후 결제/u)).toBeNull();
  // the Excel stays the owner's official export: a link with masking and the row limit, no import of any kind
  const link = screen.getByRole('link', { name: '네이버 예약 엑셀 내보내기' });
  expect(link).toHaveAttribute('href', NAVER_BOOKING_EXPORT_URL);
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText(/연락처는 가려지고 최대 5,000행/u)).toBeInTheDocument();
  expect(document.querySelector('input[type="file"]')).toBeNull();
  expect(screen.queryByText(/가져오기|불러오기|업로드/u)).toBeNull();
  // none of the fixture phone-AI wording survives over HTTP
  expect(screen.queryByText('전화 연결됨(예시)')).toBeNull();
  expect(screen.queryByRole('region', { name: '통화 요약' })).toBeNull();
  expect(grid).toBeInTheDocument();
  expect(service.backend.callsTo('POST', /./u)).toHaveLength(0);
});

it('filters by booking number, name and the last digits of the masked contact', async () => {
  setup();
  await screen.findByRole('grid', { name: '예약 목록' });
  await waitFor(() => expect(row('naver-1001')).not.toBeNull());
  const search = screen.getByRole('searchbox', { name: '예약 찾기' });
  fireEvent.change(search, { target: { value: '1002' } });
  await waitFor(() => expect(row('naver-1001')).toBeNull());
  expect(row('naver-1002')).not.toBeNull();
  fireEvent.change(search, { target: { value: '김하나' } });
  await waitFor(() => expect(row('rv-local')).not.toBeNull());
  expect(row('naver-1002')).toBeNull();
  fireEvent.change(search, { target: { value: '5678' } });
  await waitFor(() => expect(row('naver-1001')).not.toBeNull());
  expect(row('rv-local')).toBeNull();
});

it('confirms a NAVER booking only on the card press, once for a double press, and offers no undo for a provider action', async () => {
  const { service, host } = setup(seed(), 'naver-1001');
  const panel = await panelOf(/18:30 · 박○○/u);
  expect(transitions(service, 'naver-1001')).toHaveLength(0);
  const confirm = panel.getByRole('button', { name: /예약 확정|확정/u });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(transitions(service, 'naver-1001')).toHaveLength(1));
  expect(transitions(service, 'naver-1001')[0].body).toEqual({ type: 'booking.confirm', expectedRevision: 4 });
  await waitFor(() => expect(host.notify).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.management.notice.bookingConfirmed' }));
  await waitFor(() => expect(within(cell('naver-1001', 'status')).getByText('예약 확정')).toBeInTheDocument());
  // a NAVER booking has no party: nothing was made up and nothing is editable beyond the usage time
  expect(panel.queryByLabelText('예약자 이름')).toBeNull();
  expect(panel.getByLabelText('예약 날짜')).toBeInTheDocument();
});

it('locks an Npay-linked booking and never sends a change', async () => {
  const { service } = setup(seed(), 'naver-1002');
  const panel = await panelOf(/20:00 · 이○○/u);
  expect(panel.getByText('Npay로 결제한 예약은 앱에서 바꿀 수 없어요')).toBeInTheDocument();
  const save = panel.getByRole('button', { name: '예약 저장하기' });
  expect(save).toBeDisabled();
  expect(save).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(save);
  expect(service.backend.callsTo('PATCH', /./u)).toHaveLength(0);
});

/** The cancel input step: the form the [예약 취소하기] button opens in the side panel (SCR-225 step 1). */
const openCancel = async (panel: Awaited<ReturnType<typeof panelOf>>, name = '예약 취소하기') => {
  fireEvent.click(panel.getByRole('button', { name }));
  return within(await panel.findByRole('form', { name: '예약 취소' }));
};
/** The extra confirmation (SCR-225 step 2, AC-1618). */
const secondStep = async (panel: Awaited<ReturnType<typeof panelOf>>) => within(await panel.findByRole('group', { name: '한 번 더 확인' }));

it('cancels a NAVER booking that is not Npay-linked with the owner-entered reason alone, only after the second confirmation, and offers no undo', async () => {
  const { service, host } = setup(seed(), 'naver-1001');
  const panel = await panelOf(/18:30 · 박○○/u);
  const form = await openCancel(panel);
  expect(transitions(service, 'naver-1001')).toHaveLength(0);
  expect(form.getByLabelText('취소 사유')).toBeInTheDocument();
  expect(form.getByText('손님에게 보여요')).toBeInTheDocument();
  expect(form.queryByRole('radiogroup')).toBeNull();
  expect(form.queryByText(/환불 조건/u)).toBeNull();
  // no reason, no review step
  const review = form.getByRole('button', { name: '취소 내용 확인하기' });
  expect(review).toBeDisabled();
  expect(form.getByText('취소 사유를 적어 주세요')).toBeInTheDocument();
  fireEvent.click(review);
  expect(panel.queryByRole('group', { name: '한 번 더 확인' })).toBeNull();
  expect(transitions(service, 'naver-1001')).toHaveLength(0);
  fireEvent.change(form.getByLabelText('취소 사유'), { target: { value: '  휴무일이에요 ' } });
  expect(review).toBeEnabled();
  fireEvent.click(review);
  // the second step says it cannot be undone first, then what will be sent; nothing is sent yet
  const second = await secondStep(panel);
  expect(second.getByText('취소하면 되돌릴 수 없어요')).toBeInTheDocument();
  expect(second.getByText('1001')).toBeInTheDocument();
  expect(second.getByText('저녁 코스')).toBeInTheDocument();
  expect(second.getByText('휴무일이에요')).toBeInTheDocument();
  expect(second.queryByText('환불 조건')).toBeNull();
  expect(transitions(service, 'naver-1001')).toHaveLength(0);
  // Esc goes back to the input with what was typed; the booking is untouched
  fireEvent.keyDown(panel.getByRole('group', { name: '한 번 더 확인' }), { key: 'Escape' });
  const back = within(await panel.findByRole('form', { name: '예약 취소' }));
  expect(back.getByLabelText('취소 사유')).toHaveValue('  휴무일이에요 ');
  expect(transitions(service, 'naver-1001')).toHaveLength(0);
  fireEvent.click(back.getByRole('button', { name: '취소 내용 확인하기' }));
  const confirm = (await secondStep(panel)).getByRole('button', { name: '1001 예약 취소하기' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(transitions(service, 'naver-1001')).toHaveLength(1));
  expect(transitions(service, 'naver-1001')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '휴무일이에요', expectedRevision: 4 });
  // the result: a plain cancel notice with no undo token or deadline, and the panel says a NAVER cancel cannot be undone
  await waitFor(() => expect(host.notify).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.real.booking.canceled' }));
  await waitFor(() => expect(within(cell('naver-1001', 'status')).getByText('취소')).toBeInTheDocument());
  expect(panel.queryByText('예약을 취소했어요')).toBeNull();
  expect(panel.getByText('네이버 예약 취소는 되돌릴 수 없어요')).toBeInTheDocument();
  expect(panel.queryByRole('button', { name: /되돌리기/u })).toBeNull();
  expect(panel.queryByRole('button', { name: '예약 취소하기' })).toBeNull();
  expect(service.reservations.get('naver-1001')).toMatchObject({ status: 'canceled' });
});

it('never offers an undo after a NAVER cancel, even when a receipt carries an undo deadline the service said does not exist', async () => {
  const { service, host } = setup(seed(), 'naver-1001');
  service.control.contradictoryUndo = true;
  const panel = await panelOf(/18:30 · 박○○/u);
  const form = await openCancel(panel);
  fireEvent.change(form.getByLabelText('취소 사유'), { target: { value: '휴무일이에요' } });
  fireEvent.click(form.getByRole('button', { name: '취소 내용 확인하기' }));
  fireEvent.click((await secondStep(panel)).getByRole('button', { name: '1001 예약 취소하기' }));
  await waitFor(() => expect(host.notify).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.real.booking.canceled' }));
  expect(host.notify).not.toHaveBeenCalledWith(expect.objectContaining({ undoToken: expect.anything() }));
  expect(host.notify).not.toHaveBeenCalledWith(expect.objectContaining({ undoUntil: expect.anything() }));
});

it('steps back with Esc inside the cancel (confirmation, then the form) and keeps the side panel and the booking', async () => {
  const { service } = setup(seed(), 'naver-1001');
  const panel = await panelOf(/18:30 · 박○○/u);
  const form = await openCancel(panel);
  fireEvent.change(form.getByLabelText('취소 사유'), { target: { value: '휴무일이에요' } });
  fireEvent.click(form.getByRole('button', { name: '취소 내용 확인하기' }));
  await secondStep(panel);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await panel.findByRole('form', { name: '예약 취소' });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  await waitFor(() => expect(panel.queryByRole('form', { name: '예약 취소' })).toBeNull());
  // the panel is still on this booking, which can be cancelled again, and nothing was sent
  expect(panel.getByRole('button', { name: '예약 취소하기' })).toBeInTheDocument();
  expect(transitions(service, 'naver-1001')).toHaveLength(0);
});

it('asks no refund terms for an Npay booking that is not confirmed yet', async () => {
  const { service } = setup(seed(), 'naver-1005');
  const panel = await panelOf(/22:00 · 한○○/u);
  const form = await openCancel(panel);
  expect(form.queryByRole('radiogroup')).toBeNull();
  fireEvent.change(form.getByLabelText('취소 사유'), { target: { value: '사정이 생겼어요' } });
  fireEvent.click(form.getByRole('button', { name: '취소 내용 확인하기' }));
  fireEvent.click((await secondStep(panel)).getByRole('button', { name: '1005 예약 취소하기' }));
  await waitFor(() => expect(transitions(service, 'naver-1005')).toHaveLength(1));
  expect(transitions(service, 'naver-1005')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '사정이 생겼어요', expectedRevision: 3 });
});

it('asks for refund terms for a confirmed Npay booking, picks none for the owner, and sends them with the reason only after the second confirmation; without a payment amount only full and a rate are offered', async () => {
  const errors = vi.spyOn(console, 'error');
  const { service, host } = setup(seed(), 'naver-1002');
  const panel = await panelOf(/20:00 · 이○○/u);
  const form = await openCancel(panel);
  expect(form.getByText('Npay로 결제된 예약이에요. 취소하려면 환불 조건을 정해 주세요')).toBeInTheDocument();
  expect(form.getAllByRole('radio')).toHaveLength(2);
  expect(form.queryByRole('radio', { name: '금액' })).toBeNull();
  expect(form.queryByText(/^결제 금액/u)).toBeNull();
  // money is on the line, so no option is pre-selected
  expect(form.getAllByRole('radio').every(radio => radio.getAttribute('aria-checked') !== 'true')).toBe(true);
  const review = form.getByRole('button', { name: '취소 내용 확인하기' });
  expect(review).toBeDisabled();
  fireEvent.change(form.getByLabelText('취소 사유'), { target: { value: '재료가 떨어졌어요' } });
  expect(review).toBeDisabled();
  expect(form.getByText('환불 조건을 골라 주세요')).toBeInTheDocument();
  // a rate needs a value between 0 and 100
  fireEvent.click(form.getByRole('radio', { name: '비율' }));
  expect(review).toBeDisabled();
  fireEvent.change(form.getByLabelText('환불 비율'), { target: { value: '120' } });
  expect(form.getByText('0에서 100 사이로 넣어 주세요')).toBeInTheDocument();
  expect(review).toBeDisabled();
  fireEvent.change(form.getByLabelText('환불 비율'), { target: { value: '50' } });
  expect(review).toBeEnabled();
  fireEvent.click(review);
  const second = await secondStep(panel);
  expect(second.getByText('취소하면 되돌릴 수 없어요')).toBeInTheDocument();
  expect(second.getByText('결제 금액의 50%')).toBeInTheDocument();
  expect(second.getByText('재료가 떨어졌어요')).toBeInTheDocument();
  expect(transitions(service, 'naver-1002')).toHaveLength(0);
  const confirm = second.getByRole('button', { name: '1002 예약 취소하기' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(transitions(service, 'naver-1002')).toHaveLength(1));
  expect(transitions(service, 'naver-1002')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '재료가 떨어졌어요', refund: { type: 'rate', value: 50 }, expectedRevision: 2 });
  await waitFor(() => expect(within(cell('naver-1002', 'status')).getByText('취소')).toBeInTheDocument());
  // the receipt never says the refund was paid: NAVER processes it, and nothing can be undone
  expect(host.notify).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.real.booking.canceledRefund' });
  expect(panel.queryByText('예약을 취소했어요 · 환불은 네이버에서 처리해요')).toBeNull();
  expect(panel.getByText('네이버 예약 취소는 되돌릴 수 없어요')).toBeInTheDocument();
  expect(panel.queryByText(/환불했어요|환불 완료/u)).toBeNull();
  // no option is pre-selected, and the radio group stays controlled from the first render (Base UI says so on the console otherwise)
  expect(errors.mock.calls.flat().join(' ')).not.toMatch(/uncontrolled|controlled/iu);
  errors.mockRestore();
});

it('bounds an amount refund by the payment amount the provider shows', async () => {
  const { service } = setup(seed(), 'naver-1003');
  const panel = await panelOf(/21:00 · 최○○/u);
  const form = await openCancel(panel);
  expect(form.getByText('결제 금액 30,000원')).toBeInTheDocument();
  fireEvent.change(form.getByLabelText('취소 사유'), { target: { value: '사정이 생겼어요' } });
  fireEvent.click(form.getByRole('radio', { name: '금액' }));
  const review = form.getByRole('button', { name: '취소 내용 확인하기' });
  fireEvent.change(form.getByLabelText('환불 금액'), { target: { value: '12000.5' } });
  expect(form.getByText('0 이상의 정수로 넣어 주세요')).toBeInTheDocument();
  expect(review).toBeDisabled();
  fireEvent.change(form.getByLabelText('환불 금액'), { target: { value: '30001' } });
  expect(form.getAllByText('결제 금액 30,000원까지 돌려줄 수 있어요').length).toBeGreaterThan(0);
  expect(review).toBeDisabled();
  fireEvent.change(form.getByLabelText('환불 금액'), { target: { value: '12000' } });
  expect(form.getByText('결제 금액 30,000원까지 돌려줄 수 있어요')).toBeInTheDocument();
  fireEvent.click(review);
  const second = await secondStep(panel);
  expect(second.getByText('12,000원')).toBeInTheDocument();
  fireEvent.click(second.getByRole('button', { name: '1003 예약 취소하기' }));
  await waitFor(() => expect(transitions(service, 'naver-1003')).toHaveLength(1));
  expect(transitions(service, 'naver-1003')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '사정이 생겼어요', refund: { type: 'amount', value: 12000 }, expectedRevision: 6 });
});

it('cancels a completed Npay booking with refund terms, says the used booking can still be cancelled, and leaves nothing to undo (B06-3)', async () => {
  const { service, host } = setup(seed(), 'naver-1006');
  const panel = await panelOf(/16:00/u);
  // a finished Npay booking cannot be changed, so no edit and no lock note: only the cancel and why it exists
  expect(panel.queryByRole('button', { name: '예약 저장하기' })).toBeNull();
  expect(panel.queryByText('Npay로 결제한 예약은 앱에서 바꿀 수 없어요')).toBeNull();
  expect(panel.getByText('이용이 끝난 예약도 취소할 수 있어요 · 실제 환불은 정산 상태에 따라 네이버에서 정해요')).toBeInTheDocument();
  const form = await openCancel(panel, '네이버 예약 취소');
  expect(form.getByText('결제 금액 4,500원')).toBeInTheDocument();
  fireEvent.change(form.getByLabelText('취소 사유'), { target: { value: '정산 오류예요' } });
  fireEvent.click(form.getByRole('radio', { name: '전액' }));
  fireEvent.click(form.getByRole('button', { name: '취소 내용 확인하기' }));
  const second = await secondStep(panel);
  expect(second.getByText('취소하면 되돌릴 수 없어요')).toBeInTheDocument();
  expect(within(second.getByText('환불 조건').closest('div')!).getByText('전액')).toBeInTheDocument();
  expect(transitions(service, 'naver-1006')).toHaveLength(0);
  fireEvent.click(second.getByRole('button', { name: '1006 예약 취소하기' }));
  await waitFor(() => expect(transitions(service, 'naver-1006')).toHaveLength(1));
  expect(transitions(service, 'naver-1006')[0].body).toEqual({ type: 'booking.cancel', confirmed: true, cancelReason: '정산 오류예요', refund: { type: 'full' }, expectedRevision: 8 });
  await waitFor(() => expect(host.notify).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.real.booking.canceledRefund' }));
  expect(host.notify).not.toHaveBeenCalledWith(expect.objectContaining({ undoToken: expect.anything() }));
  await waitFor(() => expect(within(cell('naver-1006', 'status')).getByText('취소')).toBeInTheDocument());
  expect(panel.getByText('네이버 예약 취소는 되돌릴 수 없어요')).toBeInTheDocument();
  expect(panel.queryByRole('button', { name: '네이버 예약 취소' })).toBeNull();
  expect(service.reservations.get('naver-1006')).toMatchObject({ status: 'canceled' });
  // a new session reads the same cancelled booking
  expect(service.backend.callsTo('GET', '/reservations').length).toBeGreaterThan(1);
});

it('says what happened when the provider refuses the cancel, keeps what was typed and reads the bookings again', async () => {
  const { service } = setup(seed(), 'naver-1001');
  const panel = await panelOf(/18:30 · 박○○/u);
  const form = await openCancel(panel);
  fireEvent.change(form.getByLabelText('취소 사유'), { target: { value: '휴무일이에요' } });
  fireEvent.click(form.getByRole('button', { name: '취소 내용 확인하기' }));
  service.control.refuseCancel = true;
  const reads = service.backend.callsTo('GET', '/reservations').length;
  fireEvent.click((await secondStep(panel)).getByRole('button', { name: '1001 예약 취소하기' }));
  expect(await panel.findByText(/네이버가 이 취소를 받지 않았어요/u)).toBeInTheDocument();
  await waitFor(() => expect(service.backend.callsTo('GET', '/reservations').length).toBeGreaterThan(reads));
  expect(within(cell('naver-1001', 'status')).queryByText('취소')).toBeNull();
  // back on the input step with the reason still there
  expect(within(panel.getByRole('form', { name: '예약 취소' })).getByLabelText('취소 사유')).toHaveValue('휴무일이에요');
});

it('offers no cancel, no edit and no lock note for a NAVER booking the service does not list as cancellable', async () => {
  const done = setup(seed(), 'naver-1004');
  const finished = await panelOf(/17:00 · 정○○/u);
  expect(finished.queryByRole('button', { name: '예약 취소하기' })).toBeNull();
  expect(finished.queryByRole('button', { name: '예약 저장하기' })).toBeNull();
  expect(finished.queryByText(/이용이 끝난 예약도/u)).toBeNull();
  done.unmount();
  setup(seed(), 'naver-1009');
  const cancelled = await panelOf(/15:00/u);
  expect(cancelled.queryByRole('button', { name: '예약 취소하기' })).toBeNull();
  expect(cancelled.queryByRole('button', { name: '예약 저장하기' })).toBeNull();
});

it('follows the service for what can be cancelled: a row the service marks cancellable shows the cancel even when its status alone would not', async () => {
  const data = seed();
  const odd = naver('1010', { ...future, time: '14:00', status: 'completed', guestName: null, phone: null, revision: 3,
    actions: { change: false, confirm: false, cancel: true, cancelRequiresRefund: false, cancelUndoable: false } });
  setup({ ...data, reservations: [...data.reservations!, odd] }, 'naver-1010');
  const panel = await panelOf(/14:00/u);
  expect(panel.getByRole('button', { name: '예약 취소하기' })).toBeInTheDocument();
});

it('cancels a local booking after the extra question and keeps the receipt deadline on the undo toast', async () => {
  const { service, host } = setup(seed(), 'rv-local');
  const panel = await panelOf(/19:00 · 김하나/u);
  fireEvent.click(panel.getByRole('button', { name: '예약 취소하기' }));
  expect(service.backend.callsTo('POST', /transitions/u)).toHaveLength(0);
  fireEvent.click(panel.getByRole('button', { name: '네, 취소할게요' }));
  await waitFor(() => expect(host.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.management.notice.bookingCanceled', undoUntil, undoToken: expect.stringContaining('real-undo:') })));
  await waitFor(() => expect(within(cell('rv-local', 'status')).getByText('취소')).toBeInTheDocument());
});

const cancelWords = {
  en: { open: 'Cancel NAVER booking', form: 'Cancel booking', reason: 'Cancellation reason', hint: 'The customer will see this', refund: 'Refund', full: 'Full', review: 'Review cancellation', again: 'Confirm once more',
    once: "Once canceled, this can't be undone", confirm: 'Cancel booking 1006', done: 'Booking canceled · NAVER will process the refund', noUndo: "A canceled NAVER booking can't be restored" },
  'zh-Hans': { open: '取消 NAVER 预约', form: '取消预约', reason: '取消原因', hint: '顾客可以看到', refund: '退款条件', full: '全额', review: '确认取消内容', again: '再次确认',
    once: '取消后无法恢复', confirm: '取消预约 1006', done: '已取消预约 · 退款由 NAVER 处理', noUndo: 'NAVER 预约取消后无法恢复' },
  'zh-Hant': { open: '取消 NAVER 預約', form: '取消預約', reason: '取消原因', hint: '顧客可以看到', refund: '退款條件', full: '全額', review: '確認取消內容', again: '再次確認',
    once: '取消後無法復原', confirm: '取消預約 1006', done: '已取消預約 · 退款由 NAVER 處理', noUndo: 'NAVER 預約取消後無法復原' },
} as const;

it.each(Object.entries(cancelWords))('says the NAVER cancel, its refund terms and that it cannot be undone in %s', async (locale, words) => {
  const { service, host } = setup(seed(), 'naver-1006', locale as keyof typeof cancelWords);
  const panel = await panelOf(/16:00/u);
  fireEvent.click(panel.getByRole('button', { name: words.open }));
  const form = within(await panel.findByRole('form', { name: words.form }));
  expect(form.getByText(words.hint)).toBeInTheDocument();
  expect(form.getByRole('radiogroup', { name: words.refund })).toBeInTheDocument();
  fireEvent.change(form.getByLabelText(words.reason), { target: { value: 'Out of stock' } });
  fireEvent.click(form.getByRole('radio', { name: words.full }));
  fireEvent.click(form.getByRole('button', { name: words.review }));
  const second = within(await panel.findByRole('group', { name: words.again }));
  expect(second.getByText(words.once)).toBeInTheDocument();
  expect(transitions(service, 'naver-1006')).toHaveLength(0);
  fireEvent.click(second.getByRole('button', { name: words.confirm }));
  await waitFor(() => expect(transitions(service, 'naver-1006')).toHaveLength(1));
  expect(transitions(service, 'naver-1006')[0].body).toMatchObject({ confirmed: true, cancelReason: 'Out of stock', refund: { type: 'full' } });
  await waitFor(() => expect(panel.getByText(words.noUndo)).toBeVisible());
  expect(panel.queryByText(words.done)).toBeNull();
  expect(panel.getByText(words.noUndo)).toBeInTheDocument();
  expect(host.notify).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.real.booking.canceledRefund' });
});

it('shows a phone request as a waiting request, confirms it only on the card press and decides the table on the server', async () => {
  const { service } = setup(seed(), 'sg-1');
  const panel = await panelOf(/19:30/u);
  const card = panel.getByRole('region', { name: '전화로 받은 예약 요청' });
  expect(card).toHaveTextContent('010-****-4321');
  expect(card).toHaveTextContent('4명');
  expect(card).toHaveTextContent('확정하기를 눌러야 예약이 돼요');
  expect(panel.queryByRole('region', { name: '통화 요약' })).toBeNull();
  expect(panel.queryByText(/녹음|원음/u)).toBeNull();
  expect(transitions(service, 'sg-1')).toHaveLength(0);
  fireEvent.click(panel.getByRole('button', { name: /확정/u }));
  await waitFor(() => expect(transitions(service, 'sg-1')).toHaveLength(1));
  expect(transitions(service, 'sg-1')[0].body).toEqual({ type: 'booking.confirm', expectedRevision: 5 });
  await waitFor(() => expect(row('sg-1')).toBeNull());
  const made = [...service.reservations.values()].find(booking => booking.source === 'phone_ai')!;
  await waitFor(() => expect(row(made.reservationId)).not.toBeNull());
  expect(cell(made.reservationId, 'status')).toHaveTextContent('예약 확정');
});

it('declines a phone request only after the extra question', async () => {
  const { service } = setup(seed(), 'sg-1');
  const panel = await panelOf(/19:30/u);
  fireEvent.click(panel.getByRole('button', { name: '요청 거절하기' }));
  expect(transitions(service, 'sg-1')).toHaveLength(0);
  expect(panel.getByText('이 전화 예약 요청을 거절할까요?')).toBeInTheDocument();
  fireEvent.click(panel.getByRole('button', { name: '네, 거절할게요' }));
  await waitFor(() => expect(transitions(service, 'sg-1')).toHaveLength(1));
  expect(transitions(service, 'sg-1')[0].body).toEqual({ type: 'booking.declineSuggestion', confirmed: true, expectedRevision: 5 });
  await waitFor(() => expect(row('sg-1')).toBeNull());
});

it('adds a booking, asks before a similar one, and a new session reads the same booking', async () => {
  const { service, mount, unmount } = setup({ reservations: [visit({ reservationId: 'rv-seed', ...future, guestName: '새 손님' })] });
  await screen.findByRole('grid', { name: '예약 목록' });
  await waitFor(() => expect(row('rv-seed')).not.toBeNull());
  fireEvent.click(screen.getAllByRole('button', { name: '예약 추가하기' })[0]);
  fireEvent.change(screen.getByLabelText('예약자 이름'), { target: { value: '새 손님' } });
  fireEvent.change(screen.getByLabelText('예약 인원'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: /^예약 시각 /u }));
  fireEvent.click(await screen.findByRole('option', { name: '19:00' }));
  fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
  const alert = await screen.findByRole('button', { name: '그래도 예약하기' });
  expect(service.backend.callsTo('POST', '/reservations')[0].headers.get('idempotency-key')).toMatch(/^booking-create-/u);
  fireEvent.click(alert);
  await waitFor(() => expect(service.backend.callsTo('POST', '/reservations')).toHaveLength(2));
  expect(service.backend.callsTo('POST', '/reservations')[1].body).toMatchObject({ confirmDuplicate: true, partySize: 3 });
  await waitFor(() => expect(service.reservations.size).toBe(2));
  unmount();
  const next = mount();
  await waitFor(() => expect(document.querySelectorAll('[data-grid-row]')).toHaveLength(2));
  next.unmount();
});

it('says the list could not be read and retries for real', async () => {
  const { service } = setup(seed());
  await waitFor(() => expect(row('naver-1001')).not.toBeNull());
  cleanup();
  const failing = bookingService(seed());
  failing.control.failList = true;
  const store = createWidgetDataStore();
  store.bindReal(createRealPort({ store, fetch: failing.backend.fetch, source: domain => domain === 'booking' ? 'http' : 'fixture',
    adapters: autoloadedAdapters().filter(adapter => adapter.domain === 'booking'), sleep: async () => {}, reconcileDelaysMs: [0] }));
  const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
  renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{ kind: 'default' }} detailRef={{ featureId: 'voice-booking' }} host={host} />, { store });
  const alert = await screen.findByRole('alert');
  expect(alert).toBeInTheDocument();
  failing.control.failList = false;
  fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  await waitFor(() => expect(row('naver-1001')).not.toBeNull());
  expect(service).toBeDefined();
});

it('suggests another time for a phone request as a record only, and says so when the NAVER side was only partly read', async () => {
  const data = seed();
  const { service, host } = setup(data, 'sg-1');
  service.control.naver = 'partial';
  const panel = await panelOf(/19:30/u);
  fireEvent.click(panel.getByRole('button', { name: /다른 시간/u }));
  fireEvent.click(await panel.findByRole('radio', { name: '20:00' }));
  fireEvent.click(panel.getByRole('button', { name: '제안하기' }));
  await waitFor(() => expect(transitions(service, 'sg-1')).toHaveLength(1));
  expect(transitions(service, 'sg-1')[0].body).toEqual({ type: 'booking.propose', time: '20:00', expectedRevision: 5 });
  await waitFor(() => expect(host.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.management.notice.saved', undoUntil, undoToken: expect.stringContaining('real-undo:') })));
  await waitFor(() => expect(within(cell('sg-1', 'status')).getByText('제안함')).toBeInTheDocument());
  expect(screen.queryByText(/제안 문자|문자를 보냈/u)).toBeNull();
});

it('says the NAVER bookings were not fully read', async () => {
  const data = seed();
  const service = bookingService(data);
  service.control.naver = 'unavailable';
  const store = createWidgetDataStore();
  store.bindReal(createRealPort({ store, fetch: service.backend.fetch, source: domain => domain === 'booking' ? 'http' : 'fixture',
    adapters: autoloadedAdapters().filter(adapter => adapter.domain === 'booking'), sleep: async () => {}, reconcileDelaysMs: [0] }));
  const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
  renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{ kind: 'default' }} detailRef={{ featureId: 'voice-booking' }} host={host} />, { store });
  expect(await screen.findByText(/지금은 네이버 예약을 불러올 수 없어요/u)).toBeInTheDocument();
});

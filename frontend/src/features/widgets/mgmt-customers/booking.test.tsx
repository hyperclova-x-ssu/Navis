import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { formatMaskedCustomer } from '../../../data/customer-display';
import { createWidgetDataStore, selectReservations, TODAY } from '../../../data/widget-data';
import { VoiceBookingDetail, VoiceBookingPanel } from './voice-booking';
import { pastConfirmedBooking } from './booking-test-fixtures';
const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
afterEach(cleanup);

// The café sample (D-313): today's bookings are read from the selector the widget uses, never typed in.
const seedRows = () => selectReservations(createWidgetDataStore().getSnapshot(), { date: TODAY }).rows;
const byTime = (time: string) => seedRows().find(r => r.time === time)!;
const nameOf = (r: { name: unknown; memberId?: string | null }) => {
  const name = typeof r.name === 'string' ? r.name : (r.name as { raw: string }).raw;
  return r.memberId ? formatMaskedCustomer(name, r.memberId) : name;
};
const pastConfirmed = pastConfirmedBooking;

it('shows the next time totals and the selector seat availability',()=>{
  const rv = selectReservations(createWidgetDataStore().getSnapshot(), { date: TODAY });
  const next = rv.timeGroups.find(g => g.time === rv.availability.at)!;
  const {container}=renderWithKit(<VoiceBookingPanel featureId="voice-booking" condition={{kind:'default'}} host={host} width={2} height={2} shape="S" presetId="A" editing={false}/>);
  expect(container).toHaveTextContent(new RegExp(`${next.time}\\s*${next.count}건\\s*·\\s*${next.partyTotal}명`));
  expect(screen.getByText(`좌석 여유 ${rv.availability.value}석`)).toBeInTheDocument();
});
it('adds an over-capacity booking as waiting and allows manual confirmation',async()=>{
  const { userEvent } = await import('@testing-library/user-event');
  const store=createWidgetDataStore();
  const user = userEvent.setup();
  renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{kind:'default'}} detailRef={{featureId:'voice-booking'}} host={host}/>,{store});
  await user.click(screen.getByRole('button',{name:'예약 추가하기'}));
  await user.type(screen.getByLabelText('예약자 이름'),'새 손님');
  // DS 6.1 / G-17: the time is picked from the kit list (no typed HH:MM)
  await user.click(screen.getByRole('button',{name:/^예약 시각 /}));
  await user.click(await screen.findByRole('option',{name:'18:00'}));
  const seats = selectReservations(store.getSnapshot(),{date:TODAY}).totalSeats;
  await user.clear(screen.getByLabelText('예약 인원'));
  await user.type(screen.getByLabelText('예약 인원'),String(seats + 10));
  await user.click(screen.getByRole('button',{name:'예약 대기로 등록하기'}));
  const row=selectReservations(store.getSnapshot(),{date:TODAY}).rows.find(r=>r.partySize===seats + 10)!;
  expect(row.status).toBe('needs-check');
  expect(host.notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.management.notice.bookingAdded', undoToken: expect.any(String) }));
  await user.click(document.querySelector(`[data-grid-row="${row.reservationId}"] [data-grid-column-id="guest"]`) as HTMLElement);
  const panel = within(screen.getByRole('region', { name: '18:00 · 새○○님' }));
  await user.click(panel.getByRole('button', { name: /예약 확정/ }));
  const confirmed=selectReservations(store.getSnapshot(),{date:TODAY}).rows.find(r=>r.reservationId===row.reservationId)!;
  expect(confirmed.status).toBe('confirmed');
  expect(confirmed.tableId).toBeNull();
});
it('reports visit completion with a contextual notice and an undo token',async()=>{
 const { userEvent } = await import('@testing-library/user-event');
 const { store, id, row } = pastConfirmed(), localHost={...host,notify:vi.fn()};
 renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{kind:'default'}} detailRef={{featureId:'voice-booking',itemId:id}} host={localHost}/>,{store});
 const panel = within(screen.getByRole('region', { name: `${row.time} · ${nameOf(row)}` }));
 await userEvent.click(panel.getByRole('button',{name:'방문 완료로 바꾸기'}));
 const notice=localHost.notify.mock.calls.at(-1)![0];
 expect(notice).toMatchObject({messageKey:'data.management.notice.visitCompleted',undoToken:expect.any(String)});
 expect(selectReservations(store.getSnapshot(),{date:TODAY}).rows.find(r=>r.reservationId===id)?.status).toBe('completed');
 expect(store.undo(notice.undoToken!).ok).toBe(true);
 expect(selectReservations(store.getSnapshot(),{date:TODAY}).rows.find(r=>r.reservationId===id)?.status).toBe('confirmed');
});

it('cancels from the panel danger slot, says what was cancelled, and undo brings the booking back (D5, B3)',async()=>{
  const { userEvent } = await import('@testing-library/user-event');
  const store = createWidgetDataStore(), localHost = { ...host, notify: vi.fn() }, target = byTime('18:00');
  renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{kind:'default'}} detailRef={{featureId:'voice-booking',itemId:target.reservationId}} host={localHost}/>,{store});
  const panel = screen.getByRole('region', { name: `${target.time} · ${nameOf(target)}` });
  const cancel = within(panel).getByRole('button', { name: '예약 취소하기' });
  // DS 12.2: the destructive action is the last item of the body and nothing follows it
  const danger = cancel.closest('[data-panel-slot="danger"]')!;
  expect(danger).not.toBeNull();
  expect(danger.parentElement!.lastElementChild).toBe(danger);
  expect(danger.nextElementSibling).toBeNull();
  // no call summary exists (AC-1600): the panel holds the booking and its actions, and the cancel is still last
  expect(within(panel).queryByRole('region', { name: '통화 요약' })).toBeNull();
  const before = selectReservations(store.getSnapshot(), { date: TODAY }).count;
  await userEvent.click(cancel);
  expect(selectReservations(store.getSnapshot(), { date: TODAY }).count).toBe(before);
  await userEvent.click(within(panel).getByRole('button', { name: '예약 취소 확정하기' }));
  const notice = localHost.notify.mock.calls.at(-1)![0];
  expect(notice).toMatchObject({ kind: 'success', messageKey: 'data.management.notice.bookingCanceled', undoToken: expect.any(String) });
  expect(selectReservations(store.getSnapshot(), { date: TODAY }).count).toBe(before - 1);
  undoOk(store, notice.undoToken);
  expect(selectReservations(store.getSnapshot(), { date: TODAY }).count).toBe(before);
});
const undoOk = (store: ReturnType<typeof createWidgetDataStore>, token: string) => { expect(store.undo(token).ok).toBe(true); };

it('shows one status chip per cell with the icon meaning of its state, and no ◷ on kinds or cancelled rows (E2, A9)',()=>{
  renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{kind:'default'}} detailRef={{featureId:'voice-booking'}} host={host}/>);
  const grid = screen.getByRole('grid', { name: '예약 목록' });
  const waiting = byTime('19:30'), confirmed = byTime('17:30');
  const chip = (id: string, column: string) => document.querySelector(`[data-grid-row="${id}"] [data-grid-column-id="${column}"]`)!.querySelectorAll('.ui-status-chip');
  expect(chip(waiting.reservationId, 'status')).toHaveLength(1);
  expect(chip(waiting.reservationId, 'status')[0]).toHaveAttribute('data-semantic', 'waiting');
  expect(chip(waiting.reservationId, 'status')[0]).toHaveAttribute('data-tone', 'warning');
  expect(chip(confirmed.reservationId, 'status')).toHaveLength(1);
  expect(chip(confirmed.reservationId, 'status')[0]).toHaveAttribute('data-semantic', 'done');
  for (const row of grid.querySelectorAll('[data-grid-row]')) {
    const kind = row.querySelector('[data-grid-column-id="kind"] .ui-status-chip')!;
    expect(kind).toHaveAttribute('data-semantic', 'none');
    expect(kind.querySelector('svg')).toBeNull();
  }
});

it('steps the day with a date that does not drift, and an empty day says so and offers 예약 추가하기 (A10)',async()=>{
  const { userEvent } = await import('@testing-library/user-event');
  renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{kind:'default'}} detailRef={{featureId:'voice-booking'}} host={host}/>);
  expect(within(screen.getByRole('group', { name: '날짜' })).getByRole('status')).toHaveTextContent('11월 17일 화요일');
  await userEvent.click(screen.getByRole('button', { name: '다음 날짜' }));
  expect(within(screen.getByRole('group', { name: '날짜' })).getByRole('status')).toHaveTextContent('11월 18일 수요일');
  const grid = screen.getByRole('grid', { name: '예약 목록' });
  expect(within(grid).getByText('이 날은 예약이 없어요')).toBeInTheDocument();
  expect(within(grid).getByRole('button', { name: '예약 추가하기' })).toBeInTheDocument();
  expect(screen.queryByText('오늘 예약')).not.toBeInTheDocument();
  expect(screen.getByText('이 날 예약')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '이전 날짜' }));
  await userEvent.click(screen.getByRole('button', { name: '이전 날짜' }));
  expect(within(screen.getByRole('group', { name: '날짜' })).getByRole('status')).toHaveTextContent('11월 16일 월요일');
});

it('opens a reservation panel from the grid and returns focus on close and Escape', async () => {
  const { userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  const { store, row: past } = pastConfirmed(), guestName = nameOf(past);
  renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{ kind: 'default' }} detailRef={{ featureId: 'voice-booking' }} host={host} />, { reducedMotion: true, store });

  const title = `${past.time} · ${guestName}`;
  const cell = within(screen.getByRole('grid', { name: '예약 목록' })).getByRole('gridcell', { name: new RegExp(`${guestName}.*예약자 정보`) });
  const row = cell.closest('tr')!;
  expect(screen.queryByRole('form', { name: '예약 고치기' })).not.toBeInTheDocument();

  await user.click(cell);
  const panel = within(screen.getByRole('region', { name: title }));
  expect(panel.getByRole('heading', { name: title })).toHaveFocus();
  expect(row).toHaveAttribute('aria-selected', 'true');
  const form = within(panel.getByRole('form', { name: '예약 고치기' }));
  for (const label of ['예약자 이름', '연락처', '예약 인원', '요청사항']) {
    expect(form.getByLabelText(label)).toBeInTheDocument();
  }
  // the date and the time are kit pickers: the long date and the clock time, never an ISO string
  expect(form.getByRole('button', { name: /^예약 날짜 11월 17일 화요일$/ })).toBeInTheDocument();
  expect(form.getByRole('button', { name: new RegExp(`^예약 시각 ${past.time}$`) })).toBeInTheDocument();
  expect(form.getByRole('button', { name: '예약 저장하기' })).toBeEnabled();
  for (const name of ['방문 완료로 바꾸기', '예약 취소하기', /오지 않음으로 바꾸기/]) {
    expect(panel.getByRole('button', { name })).toBeEnabled();
  }
  expect(panel.queryByRole('region', { name: '통화 요약' })).toBeNull();
  await user.click(panel.getByRole('button', { name: '닫기' }));
  expect(screen.queryByRole('region', { name: title })).not.toBeInTheDocument();
  expect(row).not.toHaveAttribute('aria-selected', 'true');
  expect(cell).toHaveFocus();

  await user.keyboard('{Enter}');
  const guest = within(screen.getByRole('region', { name: title })).getByLabelText('예약자 이름');
  await user.clear(guest);
  await user.type(guest, '임시 이름');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('region', { name: title })).not.toBeInTheDocument();
  expect(cell).toHaveFocus();

  await user.keyboard(' ');
  expect(within(screen.getByRole('region', { name: title })).getByLabelText('예약자 이름')).toHaveValue(guestName);
});
it('keeps the booking panel, tools and original grid columns in HTTP and fixture mode', async () => {
  const { bookingService, naver } = await import('../../../data/reality/06/testing');
  const { bookingAdapter } = await import('../../../data/reality/06/adapter');
  const { createRealPort } = await import('../../../data/reality/00');
  const { backend } = bookingService({ reservations: [naver('P-17', { date: TODAY })] });
  const structures = [];
  for (const mode of ['http', 'fixture'] as const) {
    const store = createWidgetDataStore();
    if (mode === 'http') store.bindReal(createRealPort({ store, source: () => mode, adapters: [bookingAdapter], fetch: backend.fetch }));
    const props = { featureId: 'voice-booking' as const, condition: { kind: 'default' as const }, host };
    const { container } = renderWithKit(<><VoiceBookingPanel {...props} width={1} height={1} shape="Q" editing={false} presetId="A" /><VoiceBookingDetail {...props} detailRef={{ featureId: 'voice-booking' }} /></>, { store });
    await screen.findByRole('columnheader', { name: '종류' });
    structures.push({
      panel: Boolean(container.querySelector('[data-slot="voice-booking.metric.value"]')),
      columns: screen.getAllByRole('columnheader').map(node => node.getAttribute('data-grid-column-id') ?? node.textContent),
      search: Boolean(screen.queryByRole('searchbox')),
      export: Boolean(container.querySelector('[data-slot="voice-booking.export"]')),
      facts: Array.from(container.querySelectorAll('.mc-booking-content details summary'), node => node.textContent?.split(' · ')[0]),
    });
    if (mode === 'http') {
      expect(screen.getByText('박○○')).toBeInTheDocument();
      expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    }
    cleanup();
  }
  expect(structures[0]?.export).toBe(true);
  expect(structures[0]?.columns).not.toContain('예약번호');
  expect(structures[1]).toEqual(structures[0]);
});

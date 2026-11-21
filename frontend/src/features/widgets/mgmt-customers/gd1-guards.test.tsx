/** GD-1: member phone duplicates show the masked row, and the 예약 form shows the allocation warning before the owner confirms. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { addDays } from '../../../data/db/time';
import { createWidgetDataStore, selectMembers, selectReservations, TODAY } from '../../../data/widget-data';
import { MembersDetail } from './members';
import { VoiceBookingDetail } from './voice-booking';

const makeHost = () => ({ layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) });
const condition = { kind: 'default' as const };
const styles = readFileSync('src/features/widgets/mgmt-customers/widgets.css', 'utf8');
afterEach(cleanup);
/** Picks a day in the kit calendar of the 예약 날짜 field (the date is never typed: DS 6.1 G-25). */
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
async function pickDate(iso: string) {
  const [, m, d] = iso.split('-').map(Number), weekday = WEEKDAY[new Date(`${iso}T12:00:00Z`).getUTCDay()];
  await userEvent.click(screen.getByRole('button', { name: /^예약 날짜 / }));
  await userEvent.click(await screen.findByRole('button', { name: `${m}월 ${d}일 ${weekday}요일` }));
}

describe('member phone numbers', () => {
  // The café sample keeps members masked (no full number), so the number to collide with comes from a member created first.
  const takenNumber = (store: ReturnType<typeof createWidgetDataStore>) => {
    const phone = '01055550123', created = store.dispatch({ type: 'members.create', name: '기준손님', phone, idempotencyKey: 'gd1-taken' });
    if (!created.ok) throw new Error(created.messageKey);
    return { memberId: (created.value as { memberId: string }).memberId, phone };
  };
  it('adding a member with a number that is taken shows the message as an alert and the matching masked row, and opens that member', async () => {
    const store = createWidgetDataStore(), host = makeHost(), taken = takenNumber(store);
    renderWithKit(<><style>{styles}</style><MembersDetail featureId="members" condition={condition} detailRef={{ featureId: 'members', view: 'register' }} host={host} /></>, { store, reducedMotion: true });
    await userEvent.type(screen.getByRole('textbox', { name: '이름' }), '새손님');
    await userEvent.type(screen.getByRole('textbox', { name: '연락처' }), taken.phone);
    const before = selectMembers(store.getSnapshot(), {}).total;
    await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(before);
    expect(screen.getByRole('alert')).toHaveTextContent('같은 연락처로 등록된 회원이 있어요. 회원 목록에서 확인해 주세요');
    const row = document.querySelector('[data-slot="members.sameNumber"]') as HTMLElement;
    expect(row).toHaveTextContent('같은 번호의 회원:');
    expect(row).toHaveTextContent('****');
    expect(row.textContent).not.toContain(taken.phone);
    await userEvent.click(within(row).getByRole('button', { name: '그 회원 보기' }));
    expect(screen.getByRole('region')).toHaveTextContent(taken.memberId);
  });
  it('a refused name or number says which one to fix (AC-1073)', async () => {
    const store = createWidgetDataStore(), host = makeHost();
    renderWithKit(<><style>{styles}</style><MembersDetail featureId="members" condition={condition} detailRef={{ featureId: 'members', view: 'register' }} host={host} /></>, { store, reducedMotion: true });
    await userEvent.type(screen.getByRole('textbox', { name: '연락처' }), '01012345678');
    await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('이름을 넣어 주세요');
    await userEvent.type(screen.getByRole('textbox', { name: '이름' }), '새손님');
    await userEvent.clear(screen.getByRole('textbox', { name: '연락처' }));
    await userEvent.type(screen.getByRole('textbox', { name: '연락처' }), '0101');
    await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('연락처를 숫자 10~11자리로 넣어 주세요');
  });
});

describe('예약 form', () => {
  const open = () => {
    const store = createWidgetDataStore(), host = makeHost();
    renderWithKit(<><style>{styles}</style><VoiceBookingDetail featureId="voice-booking" condition={condition} detailRef={{ featureId: 'voice-booking', view: 'register' }} host={host} /></>, { store, reducedMotion: true });
    return { store, host };
  };
  it('shows the 예약 대기 warning before saving when the party is over the seat limit, and none for a small party', async () => {
    const { store } = open();
    expect(document.querySelector('[data-slot="voice-booking.allocationPreview"]')).toBeNull();
    const party = screen.getByRole('spinbutton', { name: /인원/ });
    const seats = selectReservations(store.getSnapshot(), { date: TODAY }).totalSeats;
    await userEvent.clear(party);
    await userEvent.type(party, String(seats + 10));
    const warning = document.querySelector('[data-slot="voice-booking.allocationPreview"]') as HTMLElement;
    expect(warning).toHaveTextContent('좌석 30석을 넘어요');
    expect(warning).toHaveTextContent('이대로 저장하면 예약 대기로 들어가요');
    await userEvent.clear(party);
    await userEvent.type(party, '2');
    expect(document.querySelector('[data-slot="voice-booking.allocationPreview"]')).toBeNull();
  });
  it('a slot before the business clock is refused with the plan message in the form, and nothing is saved', async () => {
    const { store } = open();
    await userEvent.type(screen.getByRole('textbox', { name: '예약자 이름' }), '김서연');
    await pickDate(addDays(TODAY, -1));
    const before = store.getSnapshot().tables.reservation.length;
    await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(store.getSnapshot().tables.reservation.length).toBe(before);
    expect(screen.getByRole('alert')).toHaveTextContent('지난 시간에는 새 예약을 넣을 수 없어요');
  });
  it('a look-alike booking asks first and is saved only after 그래도 예약하기', async () => {
    const { store } = open();
    const fill = async (name: string) => { await userEvent.clear(screen.getByRole('textbox', { name: '예약자 이름' })); await userEvent.type(screen.getByRole('textbox', { name: '예약자 이름' }), name); };
    await pickDate(addDays(TODAY, 1));
    await fill('김서연');
    await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
    const after1 = store.getSnapshot().tables.reservation.length;
    await userEvent.click(screen.getByRole('button', { name: '예약 추가하기' }));
    await fill('김서연');
    await pickDate(addDays(TODAY, 1));
    await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(store.getSnapshot().tables.reservation.length).toBe(after1);
    expect(screen.getByRole('alert')).toHaveTextContent('같은 시간에 비슷한 예약이 있어요');
    await userEvent.click(screen.getByRole('button', { name: '그래도 예약하기' }));
    expect(store.getSnapshot().tables.reservation.length).toBe(after1 + 1);
  });
  it('editing a booking into a look-alike is refused in the panel form and saved only after 그래도 저장하기', async () => {
    const store = createWidgetDataStore(), host = makeHost();
    const create = (time: string) => { const r = store.dispatch({ type: 'booking.create', guest: { name: '김서연' }, date: TODAY, time, partySize: 2, request: '', tableChoice: 'auto', idempotencyKey: `gd1-edit-${time}` }); if (!r.ok) throw new Error(r.messageKey); return (r.value as { reservationId: string }).reservationId; };
    create('19:00'); const second = create('19:30');
    renderWithKit(<><style>{styles}</style><VoiceBookingDetail featureId="voice-booking" condition={condition} detailRef={{ featureId: 'voice-booking', itemId: second }} host={host} /></>, { store, reducedMotion: true });
    const panel = within(screen.getByRole('region', { name: /19:30 · / }));
    await userEvent.click(panel.getByRole('button', { name: /^시각 19:30$/ }));
    await userEvent.click(await screen.findByRole('option', { name: '19:00' }));
    await userEvent.click(panel.getByRole('button', { name: '예약 저장하기' }));
    const rowOf = () => selectReservations(store.getSnapshot(), { date: TODAY }).rows.find(r => r.reservationId === second)!;
    expect(rowOf().time).toBe('19:30');
    expect(panel.getByRole('alert')).toHaveTextContent('같은 시간에 비슷한 예약이 있어요');
    expect(host.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' })); // the refusal is shown where the action happened, not as a second toast
    await userEvent.click(panel.getByRole('button', { name: '그래도 저장하기' }));
    expect(rowOf().time).toBe('19:00');
  });
});

import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { DetailStack } from './testing';
import { LATER_DAY, PAST_DAY, SAMPLE_EVENT, pickDate } from './testing-cafe';

afterEach(cleanup);
const PAST = '이미 지난 날짜예요. 지난 기록으로 남기려면 한 번 더 눌러 주세요';
const TWIN = '같은 날 같은 제목의 일정이 이미 있어요. 그래도 저장할까요?';
const open = () => {
  const store = createWidgetDataStore();
  renderWithKit(<DetailStack root={{ featureId: 'calendar' }} events={{}} />, { store });
  fireEvent.click(screen.getByRole('button', { name: '일정 추가하기' }));
  return store;
};
const events = (store: ReturnType<typeof createWidgetDataStore>) => store.getSnapshot().tables.calendarEvent;
/** The detail has its own day picker above the form, so the form's fields are looked up inside the form. */
const form = () => within(screen.getByRole('form'));
/** The form opens on today; the date is changed through the kit DateField calendar like on screen. */
const fill = async (title: string, date: string) => {
  fireEvent.change(form().getByLabelText('일정 제목'), { target: { value: title } });
  if (date !== TODAY) await pickDate(form(), '날짜', date);
};

describe('GD-2 calendar write guards (handler)', () => {
  it('refuses a past date and a same-title twin with the typed shape and writes nothing', () => {
    const store = createWidgetDataStore(), before = store.getSnapshot();
    expect(store.dispatch({ type: 'calendar.addEvent', title: '거래처 미팅', date: PAST_DAY })).toMatchObject({ ok: false, code: 'VALIDATION', reason: 'CALENDAR_PAST_DATE', field: 'date', messageKey: 'data.calendar.error.CALENDAR_PAST_DATE' });
    expect(store.dispatch({ type: 'calendar.addEvent', title: SAMPLE_EVENT.title, date: TODAY, time: SAMPLE_EVENT.time })).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'CALENDAR_DUPLICATE', field: 'title', details: { eventId: SAMPLE_EVENT.eventId } });
    expect(store.getSnapshot()).toBe(before);
  });
  it('takes the neighbours: today, a later day, a historical record, a confirmed twin, and keeps undo', () => {
    const store = createWidgetDataStore(), start = events(store).length;
    expect(store.dispatch({ type: 'calendar.addEvent', title: '거래처 미팅', date: TODAY }).ok).toBe(true);
    expect(store.dispatch({ type: 'calendar.addEvent', title: '거래처 미팅', date: LATER_DAY }).ok).toBe(true);
    expect(store.dispatch({ type: 'calendar.addEvent', title: '거래처 미팅', date: PAST_DAY, dateIntent: 'historical' }).ok).toBe(true);
    const twin = store.dispatch({ type: 'calendar.addEvent', title: '거래처 미팅', date: TODAY, confirmDuplicate: true });
    expect(twin.ok).toBe(true);
    expect(events(store)).toHaveLength(start + 4);
    // single undo slot: the most recent write is the one that comes back
    expect(twin.ok && store.undo(twin.undoToken!).ok).toBe(true);
    expect(events(store)).toHaveLength(start + 3);
  });
  it('guards editing too: no move into the past or onto a twin, but memo-only and same-day edits stay free', () => {
    const store = createWidgetDataStore();
    const { eventId } = SAMPLE_EVENT, back = '2026-11-03';
    expect(store.dispatch({ type: 'calendar.updateEvent', eventId, date: back })).toMatchObject({ ok: false, reason: 'CALENDAR_PAST_DATE' });
    expect(store.dispatch({ type: 'calendar.updateEvent', eventId, date: back, dateIntent: 'historical' }).ok).toBe(true);
    expect(store.dispatch({ type: 'calendar.updateEvent', eventId, memo: '메모만 고침' }).ok).toBe(true);
    expect(store.dispatch({ type: 'calendar.updateEvent', eventId, time: '13:30' }).ok).toBe(true);
  });
});

describe('GD-2 calendar form answers', () => {
  it('past date: message under the date field, nothing saved, then 지난 기록으로 남기기 saves it', async () => {
    const store = open(), start = events(store).length;
    await fill('거래처 미팅', PAST_DAY);
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(form().getByRole('alert')).toHaveTextContent(PAST);
    expect(form().getByLabelText('날짜')).toHaveAttribute('aria-invalid', 'true');
    expect(events(store)).toHaveLength(start);
    fireEvent.click(screen.getByRole('button', { name: '지난 기록으로 남기기' }));
    expect(events(store)).toHaveLength(start + 1);
    expect(events(store).at(-1)).toMatchObject({ date: PAST_DAY, title: { raw: '거래처 미팅' } });
  });
  it('changing the date clears the question; a date from today on saves without asking', async () => {
    const store = open(), start = events(store).length;
    await fill('거래처 미팅', PAST_DAY);
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(form().getByRole('alert')).toHaveTextContent(PAST);
    await pickDate(form(), '날짜', LATER_DAY);
    expect(screen.queryByRole('form') && form().queryByRole('alert')).toBeFalsy();
    expect(screen.queryByRole('button', { name: '지난 기록으로 남기기' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(events(store)).toHaveLength(start + 1);
    expect(events(store).at(-1)).toMatchObject({ date: LATER_DAY });
  });
  it('duplicate: asks at the title field with 그래도 저장하기 / 그대로 두기; leaving it keeps one event', async () => {
    const store = open(), start = events(store).length;
    await fill(SAMPLE_EVENT.title, TODAY);
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(form().getByRole('alert')).toHaveTextContent(TWIN);
    expect(form().getByLabelText('일정 제목')).toHaveAttribute('aria-invalid', 'true');
    expect(events(store)).toHaveLength(start);
    fireEvent.click(screen.getByRole('button', { name: '그대로 두기' }));
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(events(store)).toHaveLength(start);
  });
  it('duplicate: 그래도 저장하기 adds the second one on purpose', async () => {
    const store = open(), start = events(store).length;
    await fill(SAMPLE_EVENT.title, TODAY);
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    fireEvent.click(screen.getByRole('button', { name: '그래도 저장하기' }));
    expect(events(store)).toHaveLength(start + 1);
    expect(events(store).filter(e => 'raw' in e.title && e.title.raw === SAMPLE_EVENT.title)).toHaveLength(2);
  });
});

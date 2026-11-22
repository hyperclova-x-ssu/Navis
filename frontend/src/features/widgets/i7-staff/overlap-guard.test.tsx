import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { addDays, NOW_TIME } from '../../../data/db/time';
import { renderWithKit } from '../../../ui/test-utils';
import { StaffDetail } from './widget';
import type { WidgetDetailProps } from '../../../contracts';

afterEach(cleanup);
const notify = vi.fn();
const props = {
  featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' },
  host: { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify, acknowledgeBriefing: vi.fn() },
} satisfies WidgetDetailProps;
const OVERLAP = '같은 직원의 근무 시간이 겹쳐요';
/** The first person on the roster who works today (the editor opens on them with the same hours as their shift). */
const firstWorker = (store: ReturnType<typeof createWidgetDataStore>) => {
  const rows = store.getSnapshot().tables.staffSchedule.filter(r => r.date === TODAY);
  const first = store.getSnapshot().tables.staff[0]!;
  return { first, shift: rows.find(r => r.staffId === first.staffId && r.kind === 'work')! };
};
const rowsOf = (store: ReturnType<typeof createWidgetDataStore>, staffId: string) => store.getSnapshot().tables.staffSchedule.filter(r => r.staffId === staffId && r.date === TODAY);
const fill = (start: string, end: string) => {
  fireEvent.change(screen.getByLabelText('출근 시각'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('퇴근 시각'), { target: { value: end } });
};

describe('GD-2 staff editor overlap guard', () => {
  it.each([
    ['ko', '지난 근무'],
    ['en', 'Past shift'],
    ['zh-Hans', '已结束的班次'],
    ['zh-Hant', '已結束的班次'],
  ] as const)('marks completed work shifts in %s and leaves current work and days off alone', (locale, warning) => {
    const seed = createWidgetDataStore(), { first, shift } = firstWorker(seed);
    const base = { ...shift, staffId: first.staffId };
    const store = createWidgetDataStore({ staffSchedule: [
      { ...base, scheduleId: 'past', date: addDays(TODAY, -1) },
      { ...base, scheduleId: 'ended', end: NOW_TIME },
      { ...base, scheduleId: 'working', start: NOW_TIME, end: '23:00' },
      { ...base, scheduleId: 'off', date: addDays(TODAY, -1), kind: 'off', start: null, end: null, breakMinutes: 0 },
    ] });
    const { container } = renderWithKit(<StaffDetail {...props} />, { store, locale });
    const cell = (id: string) => container.querySelector(`.staff-grid [data-schedule-id="${id}"]`);
    expect(cell('past')).toHaveTextContent(warning);
    expect(cell('ended')).toHaveAccessibleDescription(warning);
    expect(cell('working')).not.toHaveTextContent(warning);
    expect(cell('off')).not.toHaveTextContent(warning);
  });

  it('shows the overlap message at the time fields, lists the clashing row and saves nothing', () => {
    const store = createWidgetDataStore(), before = store.getSnapshot(), { shift } = firstWorker(store);
    const supersedeSuccessNotice = vi.fn();
    renderWithKit(<StaffDetail {...props} host={{ ...props.host, supersedeSuccessNotice }} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    expect(supersedeSuccessNotice).not.toHaveBeenCalled();
    fill(shift.start!, shift.end!);
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(supersedeSuccessNotice).toHaveBeenCalledOnce();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(OVERLAP);
    expect(screen.getByLabelText('퇴근 시각')).toHaveAttribute('aria-invalid', 'true');
    expect(alert.closest('.ui-field')).toContainElement(screen.getByLabelText('퇴근 시각'));
    expect(screen.getByRole('list', { name: '겹치는 근무' })).toHaveTextContent(`${shift.start}~${shift.end} 근무`);
    expect(store.getSnapshot()).toBe(before);
    expect(screen.getByRole('form', { name: '근무 추가하기' })).toBeInTheDocument();
  });
  it('lets the user pick another interval: editing a time clears the message and a back-to-back shift saves', () => {
    const store = createWidgetDataStore(), { first, shift } = firstWorker(store);
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    fill(shift.start!, shift.end!);
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent(OVERLAP);
    fill(shift.end!, '23:00');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(rowsOf(store, first.staffId).filter(r => r.kind === 'work')).toHaveLength(2);
  });
  it('replaces the actual row on request instead of adding a second one', () => {
    const store = createWidgetDataStore(), { first, shift } = firstWorker(store);
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    fill('14:00', '18:00');
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent(OVERLAP);
    fireEvent.click(screen.getByRole('button', { name: '겹치는 근무를 이 시간으로 바꾸기' }));
    expect(rowsOf(store, first.staffId)).toEqual([expect.objectContaining({ scheduleId: shift.scheduleId, start: '14:00', end: '18:00' })]);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'success', undoToken: expect.any(String) }));
  });
  it('refuses a day off on a day the person works and shows the message without time fields', () => {
    const store = createWidgetDataStore(), before = store.getSnapshot();
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '휴무 등록하기' }));
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent(OVERLAP);
    expect(screen.getByRole('button', { name: '겹치는 근무를 휴무로 바꾸기' })).toBeInTheDocument();
    expect(store.getSnapshot()).toBe(before);
  });
});

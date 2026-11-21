import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore, selectStaffSchedule, TODAY } from '../../../data/widget-data';
import { createTranslator } from '../../../i18n';
import { renderWithKit } from '../../../ui/test-utils';
import { addIsoDays } from '../../../ui';
import { StaffDetail } from './widget';
import { periodFor } from './model';
import type { WidgetDetailProps } from '../../../contracts';

afterEach(cleanup);
const layoutProps = {
  featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' },
  host: { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() },
} satisfies WidgetDetailProps;
const format = createTranslator('ko').format;
const css = () => readFileSync('src/features/widgets/i7-staff/staff.css', 'utf8');
const week = periodFor(TODAY, 'week');
/** The roster and today's shifts exactly as the widget selects them (cafe seed). */
const seed = (store = createWidgetDataStore()) => {
  const model = selectStaffSchedule(store.getSnapshot(), { startDate: week.startDate, endDate: week.endDate });
  const today = model.rows.filter(row => row.date === TODAY && row.kind === 'work');
  return { store, model, today };
};

describe('staff detail layout', () => {
  it('scrolls the monthly grid to today on entry and when returning to the current month', () => {
    const { store, model } = seed();
    const nextMonth = addIsoDays(periodFor(TODAY, 'month').endDate, 1);
    expect(store.dispatch({ type: 'staff.saveSchedule', staffId: model.staff[0]!.staffId, date: nextMonth, kind: 'off', idempotencyKey: 'next-month' }).ok).toBe(true);
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return this.matches('.staff-grid thead th[aria-current="date"]') ? 3250 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(128);
    const { container } = renderWithKit(<><style>{css()}</style><StaffDetail {...layoutProps} /></>, { store, textScale: 125 });
    const scroll = container.querySelector<HTMLElement>('.staff-grid-scroll')!;
    const todayName = format.date(TODAY, 'short');
    expect(scroll.scrollLeft).toBe(0);

    fireEvent.click(screen.getByRole('tab', { name: '월간 근무표' }));
    expect(scroll.scrollLeft).toBe(3122);
    expect(screen.getByRole('columnheader', { name: todayName })).toHaveAttribute('aria-current', 'date');
    expect(getComputedStyle(scroll.querySelector('tbody th')!).verticalAlign).toBe('middle');
    scroll.scrollLeft = 123;
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    expect(scroll.scrollLeft).toBe(123);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));

    fireEvent.click(screen.getByRole('button', { name: '다음 날짜' }));
    expect(screen.queryByRole('columnheader', { name: todayName })).not.toBeInTheDocument();
    expect(scroll.scrollLeft).toBe(123);
    fireEvent.click(screen.getByRole('button', { name: '이전 날짜' }));
    expect(scroll.scrollLeft).toBe(3122);
  });

  it('steps back to a whole date column when the scroll limit stops short of today', () => {
    const limit = 1000;
    const lefts = new WeakMap<Element, number>();
    Object.defineProperty(HTMLElement.prototype, 'scrollLeft', { configurable: true, get(this: Element) { return lefts.get(this) ?? 0; }, set(this: Element, value: number) { lefts.set(this, Math.min(Math.max(0, value), limit)); } });
    try {
      // The name column and every date column are 128 wide; the scroll stops at 1000, which is inside a date column.
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(128);
      vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
        return this.matches('.staff-grid thead th') ? 128 * Array.from(this.parentElement!.children).indexOf(this) : 0;
      });
      const { container } = renderWithKit(<><style>{css()}</style><StaffDetail {...layoutProps} /></>);
      fireEvent.click(screen.getByRole('tab', { name: '월간 근무표' }));
      const scroll = container.querySelector<HTMLElement>('.staff-grid-scroll')!;
      // Today is far past the limit, so the scroll stops short. A date column starts at 128 * n, which is after the fixed column once scrolled 128 * (n - 1):
      // the widget steps back to the last whole column edge before the limit instead of leaving 1000 (a column cut in half).
      expect(scroll.scrollLeft).toBe(896);
      expect(scroll.scrollLeft % 128).toBe(0);
    } finally { delete (HTMLElement.prototype as { scrollLeft?: number }).scrollLeft; }
  });

  it('pins opaque monthly name cells flush with the scroll edge', () => {
    const { container } = renderWithKit(<><style>{css()}</style><StaffDetail {...layoutProps} /></>, { textScale: 125 });
    fireEvent.click(screen.getByRole('tab', { name: '월간 근무표' }));
    const table = screen.getByRole('table', { name: '월간 근무표' });
    const grid = within(table);
    const corner = grid.getByRole('columnheader', { name: '직원' });
    const nameCells = [corner, ...grid.getAllByRole('rowheader')];
    // jsdom exposes the background token in CSS rules but does not paint it.
    const rules = Array.from(container.querySelector('style')!.sheet!.cssRules);

    for (const cell of nameCells) {
      const style = getComputedStyle(cell);
      expect(style.position).toBe('sticky');
      expect(style.left).toBe('0px');
      // The corner is the kit Table header face (--muted); the name cells in the body are --secondary.
      const face = cell === corner ? 'var(--muted)' : 'var(--secondary)';
      expect(rules.some(rule => rule instanceof CSSStyleRule && cell.matches(rule.selectorText)
        && rule.style.getPropertyValue('background') === face)).toBe(true);
    }
    const tableStyle = getComputedStyle(table);
    expect(tableStyle.borderCollapse).toBe('separate');
    expect(tableStyle.borderSpacing).toBe('0px');
  });

  it('draws both grids on the kit Table, whose header is 48 and sticky, with no local header height', () => {
    const { container } = renderWithKit(<><style>{css()}</style><StaffDetail {...layoutProps} /></>);
    const rules = Array.from(container.querySelector('style')!.sheet!.cssRules).filter((r): r is CSSStyleRule => r instanceof CSSStyleRule);
    for (const name of ['주간 근무표', '월간 근무표']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      const table = screen.getByRole('table', { name });
      expect(table).toHaveClass('ui-table', 'staff-grid');
      // The old local 64/80 header height is gone: no staff rule sets a height on a header cell. Body cells keep theirs.
      const head = within(table).getAllByRole('columnheader')[1]!;
      expect(rules.filter(rule => head.matches(rule.selectorText) && rule.style.getPropertyValue('height'))).toEqual([]);
      const body = table.querySelector('tbody td')!;
      expect(rules.some(rule => body.matches(rule.selectorText) && rule.style.getPropertyValue('height') === 'var(--space-16)')).toBe(true);
    }
  });

  it.each([100, 125] as const)('keeps shift times and rest on separate lines at %i percent text size', textScale => {
    const store = createWidgetDataStore();
    const { today } = seed(store);
    const first = today[0]!;
    // The cafe seed has no breaks: add one right after the first shift, same person and day.
    expect(store.dispatch({ type: 'staff.saveSchedule', staffId: first.staffId, date: TODAY, kind: 'work', start: first.end!, end: '23:30', breakMinutes: 30, idempotencyKey: 'rest-shift' }).ok).toBe(true);
    const person = seed(store).model.staff.find(s => s.staffId === first.staffId)!;
    const todayName = format.date(TODAY, 'short');
    renderWithKit(<><style>{css()}</style><StaffDetail {...layoutProps} /></>, { store, textScale });

    for (const name of ['주간 근무표', '월간 근무표']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      const grid = within(screen.getByRole('table', { name }));
      const withRest = grid.getByRole('button', { name: `${person.name} ${todayName} ${first.end}~23:30 · 휴게 30분 고치기` });
      const time = within(withRest).getByText(`${first.end}~23:30`);
      const rest = within(withRest).getByText('휴게 30분');

      expect(getComputedStyle(time).whiteSpace).toBe('nowrap');
      expect(time.nextElementSibling).toBe(rest);
      expect(getComputedStyle(rest).display).toBe('block');
      expect(['', 'auto']).toContain(getComputedStyle(withRest).height);

      const plain = grid.getByRole('button', { name: `${person.name} ${todayName} ${first.start}~${first.end} 고치기` });
      expect(getComputedStyle(within(plain).getByText(`${first.start}~${first.end}`)).whiteSpace).toBe('nowrap');
      expect(plain).toHaveTextContent(new RegExp(`^${first.start}~${first.end}$`));
    }
  });

  it('shows the five cafe staff and their shifts exactly as seeded (F-276)', () => {
    const { model, today } = seed();
    expect(model.staff.map(s => s.name)).toEqual(['윤서진', '박도현', '한소은', '김주원', '정하린']);
    expect(today.map(row => `${row.start}~${row.end}`)).toEqual(['08:00~16:30', '08:00~12:00', '12:00~17:00', '17:00~22:00', '18:00~22:00']);
    expect(model.today).toMatchObject({ workingCount: 5, nextHandoffAt: '17:00' });
    renderWithKit(<StaffDetail {...layoutProps} />);
    const grid = within(screen.getByRole('table', { name: '주간 근무표' }));
    expect(grid.getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(model.staff.map(s => s.name));
    for (const row of today) expect(grid.getByRole('button', { name: `${model.staff.find(s => s.staffId === row.staffId)!.name} ${format.date(TODAY, 'short')} ${row.start}~${row.end} 고치기` })).toBeInTheDocument();
  });

  it('opens the staff editor from the name cell and leaves only a ghost trash action on the row', () => {
    const { store, model } = seed();
    const name = model.staff[0]!.name;
    renderWithKit(<StaffDetail {...layoutProps} />, { store });
    fireEvent.click(screen.getByRole('tab', { name: '직원 목록' }));
    const grid = within(screen.getByRole('grid', { name: '직원 목록' }));
    const cell = grid.getByRole('gridcell', { name: new RegExp(name) });
    const remove = within(cell.closest('tr')!).getByRole('button', { name: '직원 지우기' });
    expect(remove).toHaveClass('ui-button--icon', 'ui-button--ghost');
    expect(remove.textContent).toBe('');
    expect(remove.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    expect(grid.queryByRole('button', { name: '직원 고치기' })).not.toBeInTheDocument();

    fireEvent.click(cell);
    expect(screen.getByRole('form', { name: '직원 고치기' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '직원 이름' })).toHaveValue(name);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    cell.focus();
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(screen.getByRole('form', { name: '직원 고치기' })).toBeInTheDocument();
  });

  it('says 지우기 everywhere for the staff list (no 삭제 header) and keeps the trash muted, never red', () => {
    const { container } = renderWithKit(<><style>{css()}</style><StaffDetail {...layoutProps} /></>);
    fireEvent.click(screen.getByRole('tab', { name: '직원 목록' }));
    const grid = within(screen.getByRole('grid', { name: '직원 목록' }));
    expect(grid.getByRole('columnheader', { name: '지우기' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('삭제');
    const trash = Array.from(container.querySelector('style')!.sheet!.cssRules).filter(rule => rule instanceof CSSStyleRule && rule.selectorText.includes('staff-people__delete')) as CSSStyleRule[];
    expect(trash.some(rule => rule.style.getPropertyValue('color') === 'var(--muted-foreground)')).toBe(true);
    expect(trash.some(rule => /destructive|change-up/.test(rule.cssText))).toBe(false);
  });

  it('puts the add buttons together at the right end of the tool row on every tab that has one', () => {
    const { container } = renderWithKit(<><style>{css()}</style><StaffDetail {...layoutProps} /></>);
    const rule = Array.from(container.querySelector('style')!.sheet!.cssRules).find(r => r instanceof CSSStyleRule && r.selectorText === '.staff-toolbar__add') as CSSStyleRule;
    expect(rule.style.getPropertyValue('margin-inline-start')).toBe('auto');
    for (const name of ['주간 근무표', '월간 근무표', '직원 목록']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      const bar = container.querySelector<HTMLElement>('.staff-toolbar')!;
      const add = bar.querySelector<HTMLElement>('.staff-toolbar__add')!;
      expect(bar.lastElementChild).toBe(add);
      expect(within(add).getAllByRole('button').map(b => b.textContent)).toEqual(['직원 추가하기', '근무 추가하기', '휴무 등록하기', '교대 시각 고치기']);
    }
  });

  it('closes an open form when the tab changes (C5/H5)', () => {
    renderWithKit(<StaffDetail {...layoutProps} />);
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    expect(screen.getByRole('form', { name: '근무 추가하기' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '직원 목록' }));
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '주간 근무표' }));
    fireEvent.click(within(screen.getByRole('table', { name: '주간 근무표' })).getAllByRole('button', { name: /고치기$/ })[0]!);
    expect(screen.getByRole('form', { name: '근무 고치기' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '근무 변경 이력' }));
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('picks the date with the kit DateField and shows it as a long date, never a native input or an ISO string', () => {
    const { container } = renderWithKit(<StaffDetail {...layoutProps} />);
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    expect(container.querySelector('input[type="date"]')).toBeNull();
    const form = within(screen.getByRole('form', { name: '근무 추가하기' }));
    expect(form.getByRole('button', { name: new RegExp(format.date(TODAY, 'long')) })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{4}\.\s?\d{1,2}\.\s?\d{1,2}/);
  });

  it('shows the standard history empty state without the waiting icon and with no editing toolbar', () => {
    const { container } = renderWithKit(<StaffDetail {...layoutProps} />);
    fireEvent.click(screen.getByRole('tab', { name: '근무 변경 이력' }));
    for (const name of ['직원 추가하기', '근무 추가하기', '휴무 등록하기', '교대 시각 고치기']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    const empty = screen.getByRole('heading', { name: '아직 근무 변경 이력이 없어요' }).closest<HTMLElement>('.ui-inline-state')!;
    expect(within(empty).getByText('근무를 고치면 여기에 남아요')).toHaveClass('ui-inline-state__description');
    // ◷ is the waiting icon only (E2). The empty state carries exactly the kit InlineEmpty's own decorative ⓘ (DS 11.5, K-E 19), not a clock added by the widget.
    const icons = container.querySelectorAll('.staff-history-empty svg');
    expect(icons).toHaveLength(1);
    expect(icons[0]).toHaveClass('ui-inline-state__icon');
    expect(icons[0]).toHaveAttribute('aria-hidden', 'true');
    expect(within(empty).getByRole('heading', { name: '아직 근무 변경 이력이 없어요' }).previousElementSibling).toContainElement(icons[0] as unknown as HTMLElement);
  });

  it('writes the history time and the dates in the text as short dates, never as ISO', () => {
    const { store, today } = seed();
    const row = today[0]!;
    expect(store.dispatch({ type: 'staff.saveSchedule', scheduleId: row.scheduleId, staffId: row.staffId, date: TODAY, kind: 'work', start: row.start!, end: '16:45', breakMinutes: 0 }).ok).toBe(true);
    const change = selectStaffSchedule(store.getSnapshot(), { startDate: week.startDate, endDate: week.endDate }).changes.at(-1)!;
    renderWithKit(<StaffDetail {...layoutProps} />, { store });
    fireEvent.click(screen.getByRole('tab', { name: '근무 변경 이력' }));
    expect(screen.getByRole('columnheader', { name: '변경 시각' })).toBeInTheDocument();
    const cells = within(screen.getByRole('table')).getAllByRole('row')[1]!.querySelectorAll('td');
    expect(cells[0]!.textContent).toBe(format.dateTime(change.at));
    expect(cells[1]!.textContent).toContain(format.date(TODAY, 'short'));
    expect(cells[1]!.textContent).toContain(`${row.start}~16:45`);
    expect(`${cells[0]!.textContent}${cells[1]!.textContent}`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('staff source integration', () => {
  it('registers a person and saves a shift into the shared hourly source', () => {
    const { store } = seed();
    const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
    const props = { featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' }, host } as WidgetDetailProps;
    const before = selectStaffSchedule(store.getSnapshot(), { startDate: TODAY, endDate: TODAY });
    const at14 = before.hourly.find(r => r.hour === 14)!.staffCount;
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '직원 추가하기' }));
    fireEvent.change(screen.getByLabelText('직원 이름'), { target: { value: '한지민' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    const person = store.getSnapshot().tables.staff.find(s => s.name === '한지민')!;
    fireEvent.change(screen.getByLabelText('직원'), { target: { value: person.staffId } });
    fireEvent.change(screen.getByLabelText('출근 시각'), { target: { value: '14:00' } });
    fireEvent.change(screen.getByLabelText('퇴근 시각'), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    const model = selectStaffSchedule(store.getSnapshot(), { startDate: TODAY, endDate: TODAY });
    expect(model.today.workingCount).toBe(before.today.workingCount + 1);
    expect(model.hourly.find(r => r.hour === 14)?.staffCount).toBe(at14 + 1);
    expect(model.rows.find(r => r.staffId === person.staffId)).toMatchObject({ start: '14:00', end: '18:00' });
  });
  it('refuses an overnight shift in the add form and writes nothing', () => {
    const { store } = seed();
    const rows = store.getSnapshot().tables.staffSchedule.length;
    renderWithKit(<StaffDetail {...layoutProps} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    fireEvent.change(screen.getByLabelText('출근 시각'), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText('퇴근 시각'), { target: { value: '02:00' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('근무는 같은 날 안에서만 정할 수 있어요');
    expect(store.getSnapshot().tables.staffSchedule).toHaveLength(rows);
  });
  it('confirms cascading employee deletion and exposes an undo token', () => {
    const { store, model } = seed();
    const first = model.staff[0]!;
    const notify = vi.fn((_notice: { undoToken?: string }) => {});
    const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify, acknowledgeBriefing: vi.fn() } as const;
    const props = { featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' }, host } as WidgetDetailProps;
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('tab', { name: '직원 목록' }));
    fireEvent.click(screen.getAllByRole('button', { name: '직원 지우기' })[0]!);
    expect(screen.getByText(/근무 일정도 함께 지워요/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '지우기' }));
    expect(store.getSnapshot().tables.staff.some(s => s.name === first.name)).toBe(false);
    const token = notify.mock.calls.at(-1)?.[0]?.undoToken;
    expect(token).toEqual(expect.any(String));
    if (typeof token !== 'string') throw new Error('Missing undo token');
    expect(store.undo(token).ok).toBe(true);
    expect(store.getSnapshot().tables.staff.some(s => s.name === first.name)).toBe(true);
    expect(store.getSnapshot().tables.staffSchedule.some(s => s.staffId === first.staffId)).toBe(true);
  });

  it('moves all adjacent shifts through the shared handoff command', () => {
    const { store, today } = seed();
    const next = selectStaffSchedule(store.getSnapshot(), { startDate: TODAY, endDate: TODAY }).today.nextHandoffAt!;
    const ending = today.filter(r => r.end === next).length, starting = today.filter(r => r.start === next).length;
    expect(ending).toBeGreaterThan(0); expect(starting).toBeGreaterThan(0);
    // 19:00 is free in the seed, so only the rows that touch the handoff move.
    const to = '19:00';
    expect(today.some(r => r.start === to || r.end === to)).toBe(false);
    const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
    const props = { featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' }, host } as WidgetDetailProps;
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '교대 시각 고치기' }));
    expect(screen.getByLabelText('교대 시각')).toHaveValue(next);
    fireEvent.change(screen.getByLabelText('교대 시각'), { target: { value: to } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    const model = selectStaffSchedule(store.getSnapshot(), { startDate: TODAY, endDate: TODAY });
    expect(model.today.nextHandoffAt).toBe(to);
    expect(model.rows.filter(r => r.kind === 'work' && r.end === to)).toHaveLength(ending);
    expect(model.rows.filter(r => r.kind === 'work' && r.start === to)).toHaveLength(starting);
  });

});

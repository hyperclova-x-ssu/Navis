import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { createTranslator } from '../../../i18n';
import { renderWithKit } from '../../../ui/test-utils';
import { StaffDetail } from './widget';
import type { WidgetDetailProps } from '../../../contracts';

afterEach(cleanup);
const notify = vi.fn();
const props = {
  featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' },
  host: { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify, acknowledgeBriefing: vi.fn() },
} satisfies WidgetDetailProps;
const format = createTranslator('ko').format;
const css = () => readFileSync('src/features/widgets/i7-staff/staff.css', 'utf8');
const panelOf = (name: string) => screen.getByRole('region', { name });
const gone = (name: string) => waitFor(() => expect(screen.queryByRole('region', { name })).not.toBeInTheDocument());
/** First person who works today, with their shift button in the weekly table. */
const firstShift = (store: ReturnType<typeof createWidgetDataStore>) => {
  const snapshot = store.getSnapshot();
  const person = snapshot.tables.staff[0]!;
  const shift = snapshot.tables.staffSchedule.find(row => row.staffId === person.staffId && row.date === TODAY && row.kind === 'work')!;
  const label = `${person.name} ${format.date(TODAY, 'short')} ${shift.start}~${shift.end} 고치기`;
  return { person, shift, label };
};

describe('D-326 Q11: staff shifts open in the right DetailSidePanel', () => {
  it('opens 근무 추가하기 in the side panel, not as an inline form under the table, and saves from it', async () => {
    const store = createWidgetDataStore(), before = store.getSnapshot().tables.staffSchedule.length;
    const { container } = renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    const panel = panelOf('근무 추가하기');
    expect(panel).toHaveClass('ui-detail-side-panel');
    expect(within(panel).getByRole('form', { name: '근무 추가하기' })).toBeInTheDocument();
    expect(container.querySelector('.ui-inline-form')).toBeNull();
    fireEvent.change(within(panel).getByLabelText('출근 시각'), { target: { value: '23:00' } });
    fireEvent.change(within(panel).getByLabelText('퇴근 시각'), { target: { value: '23:30' } });
    fireEvent.click(within(panel).getByRole('button', { name: '저장하기' }));
    expect(store.getSnapshot().tables.staffSchedule).toHaveLength(before + 1);
    await gone('근무 추가하기');
  });

  it('keeps the four tool-row buttons and their order', () => {
    const { container } = renderWithKit(<StaffDetail {...props} />);
    const names = () => within(container.querySelector<HTMLElement>('.staff-toolbar__add')!).getAllByRole('button').map(button => button.textContent);
    expect(names()).toEqual(['직원 추가하기', '근무 추가하기', '휴무 등록하기', '교대 시각 고치기']);
    fireEvent.click(screen.getByRole('button', { name: '휴무 등록하기' }));
    expect(panelOf('근무 추가하기')).toBeInTheDocument();
    expect(names()).toEqual(['직원 추가하기', '근무 추가하기', '휴무 등록하기', '교대 시각 고치기']);
  });

  it('moves focus into the panel when a shift row is pressed, and Esc closes it and returns focus to that row', async () => {
    const store = createWidgetDataStore(), { label } = firstShift(store);
    renderWithKit(<StaffDetail {...props} />, { store });
    const row = within(screen.getByRole('table', { name: '주간 근무표' })).getByRole('button', { name: label });
    row.focus();
    fireEvent.click(row);
    const panel = panelOf('근무 고치기');
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    expect(within(panel).getByRole('form', { name: '근무 고치기' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await gone('근무 고치기');
    expect(row).toHaveFocus();
  });

  it('returns focus to the tool button that opened an add panel', async () => {
    renderWithKit(<StaffDetail {...props} />);
    const open = screen.getByRole('button', { name: '근무 추가하기' });
    open.focus();
    fireEvent.click(open);
    fireEvent.click(within(panelOf('근무 추가하기')).getByRole('button', { name: '닫기' }));
    await gone('근무 추가하기');
    expect(open).toHaveFocus();
  });

  it('keeps the same fields, validation and messages in the panel', () => {
    const store = createWidgetDataStore(), before = store.getSnapshot();
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    const panel = panelOf('근무 추가하기');
    for (const label of ['직원', '날짜', '출근 시각', '퇴근 시각', '휴게 시간']) expect(within(panel).getAllByText(label, { exact: false }).length).toBeGreaterThan(0);
    expect(within(panel).getByRole('radio', { name: '근무' })).toBeInTheDocument();
    expect(within(panel).getByRole('radio', { name: '직원 휴무' })).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText('출근 시각'), { target: { value: '22:00' } });
    fireEvent.change(within(panel).getByLabelText('퇴근 시각'), { target: { value: '02:00' } });
    fireEvent.click(within(panel).getByRole('button', { name: '저장하기' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('근무는 같은 날 안에서만 정할 수 있어요');
    expect(store.getSnapshot()).toBe(before);
  });

  it('puts 근무 지우기 in the danger slot, last in the panel body, and confirms in the same panel', async () => {
    const store = createWidgetDataStore(), { shift, label } = firstShift(store);
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(within(screen.getByRole('table', { name: '주간 근무표' })).getByRole('button', { name: label }));
    const panel = panelOf('근무 고치기');
    const body = panel.querySelector<HTMLElement>('.ui-detail-side-panel__body')!;
    const danger = body.querySelector<HTMLElement>('.ui-detail-side-panel__danger')!;
    expect(body.lastElementChild).toBe(danger);
    const deleteShift = within(danger).getByRole('button', { name: '근무 지우기' });
    deleteShift.focus();
    fireEvent.click(deleteShift);
    const confirm = panelOf('근무 지우기');
    expect(within(confirm).getByRole('form', { name: '근무 지우기' })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole('button', { name: '지우기' }));
    expect(store.getSnapshot().tables.staffSchedule.some(row => row.scheduleId === shift.scheduleId)).toBe(false);
    await gone('근무 지우기');
  });

  it('closes the shift panel on a second press of its selected shift', async () => {
    const store = createWidgetDataStore(), { label } = firstShift(store);
    renderWithKit(<StaffDetail {...props} />, { store });
    const shift = within(screen.getByRole('table', { name: '주간 근무표' })).getByRole('button', { name: label });
    fireEvent.click(shift);
    expect(panelOf('근무 고치기')).toBeInTheDocument();
    fireEvent.click(shift);
    await gone('근무 고치기');
    expect(shift).toHaveFocus();
  });

  it('opens 직원 고치기 in the panel from a staff-list row, selects the row, and closes on a second press', async () => {
    const store = createWidgetDataStore(), person = store.getSnapshot().tables.staff[0]!;
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('tab', { name: '직원 목록' }));
    const grid = within(screen.getByRole('grid', { name: '직원 목록' }));
    const cell = grid.getByRole('gridcell', { name: new RegExp(person.name) });
    fireEvent.click(cell);
    const panel = panelOf('직원 고치기');
    expect(within(panel).getByRole('textbox', { name: '직원 이름' })).toHaveValue(person.name);
    expect(cell.closest('tr')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(cell);
    await gone('직원 고치기');
  });

  it('opens the staff delete confirmation in the panel from the row-end trash only', () => {
    const store = createWidgetDataStore();
    renderWithKit(<StaffDetail {...props} />, { store });
    fireEvent.click(screen.getByRole('tab', { name: '직원 목록' }));
    fireEvent.click(screen.getAllByRole('button', { name: '직원 지우기' })[0]!);
    const panel = panelOf('직원 지우기');
    expect(within(panel).getByText(/근무 일정도 함께 지워요/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: '직원 지우기' })).not.toBeInTheDocument();
  });

  it('shrinks the table beside the panel instead of hiding columns under it', () => {
    const { container } = renderWithKit(<><style>{css()}</style><StaffDetail {...props} /></>);
    const rules = Array.from(container.querySelector('style')!.sheet!.cssRules).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    const beside = rules.find(rule => rule.selectorText.includes('.ui-detail-side-panel[data-layout="overlay"]'));
    expect(beside?.style.getPropertyValue('max-width')).toBe('calc(100% - var(--sidepanel-width) - var(--space-6))');
    expect(css()).not.toContain('ui-inline-form');
  });
});

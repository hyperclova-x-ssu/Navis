// K-C: hit areas (G1), status chip shape and icon meanings (A9, E2), DateField / TimeField (D1, G-17, G-25).
import '../test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../test-utils';
import { Icon, type IconName } from '../icons';
import { StatusBadge, statusSemantics, statusSemanticIcon, type StatusSemantic } from './badges';
import { StatusChip, renderStatusChip } from './management';
import { Checkbox, RadioGroup } from './choice-controls';
import { DateField } from './date-field';
import { TimeField } from './time-field';
import { DataGrid, type GridColumn } from './data-grid';
import { addDays, addMonths, clampIso, isDisabledDay, monthMatrix, parseIsoDate, timeSlots, toIsoDate, weekdayIndex } from './date-grid';

afterEach(cleanup);
const css = (file: string) => readFileSync(resolve(__dirname, file), 'utf8');
const pathOf = (name: IconName) => { const { container, unmount } = render(<Icon name={name} />); const d = container.querySelector('path')!.getAttribute('d'); unmount(); return d; };
const iconOf = (root: HTMLElement) => root.querySelector('svg path')?.getAttribute('d') ?? null;
const rule = (source: string, selector: string) => { const at = `\n${source}`.indexOf(`\n${selector} {`); expect(at, selector).toBeGreaterThanOrEqual(0); return source.slice(at, source.indexOf('}', at)); };

describe('date-grid (pure, store-local)', () => {
  it('parses only real calendar dates and never reads the device clock', () => {
    expect(parseIsoDate('2026-10-26')).toEqual({ y: 2026, m: 10, d: 26 });
    expect(parseIsoDate('2026-10-26 15:45')).toEqual({ y: 2026, m: 10, d: 26 });
    expect(parseIsoDate('2026-02-30')).toBeNull();
    expect(parseIsoDate('10/26')).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
    expect(toIsoDate({ y: 2026, m: 3, d: 4 })).toBe('2026-03-04');
  });
  it('adds days and months with the month end clamped', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -2)).toBe('2025-11-15');
  });
  it('lays out six Monday-first weeks', () => {
    expect(weekdayIndex('2026-10-26')).toBe(0);
    expect(weekdayIndex('2026-11-01')).toBe(6);
    const weeks = monthMatrix(2026, 10);
    expect(weeks).toHaveLength(6);
    expect(weeks.every(week => week.length === 7)).toBe(true);
    expect(weeks[0]![0]!.iso).toBe('2026-09-28');
    expect(weeks[0]![3]).toEqual({ iso: '2026-10-01', day: 1, inMonth: true });
    expect(weeks[0]![0]!.inMonth).toBe(false);
  });
  it('clamps and disables outside min and max', () => {
    expect(clampIso('2026-10-01', '2026-10-10', '2026-10-20')).toBe('2026-10-10');
    expect(clampIso('2026-10-30', '2026-10-10', '2026-10-20')).toBe('2026-10-20');
    expect(isDisabledDay('2026-10-09', '2026-10-10')).toBe(true);
    expect(isDisabledDay('2026-10-10', '2026-10-10')).toBe(false);
  });
  it('lists time slots on the step', () => {
    expect(timeSlots(30, '09:00', '11:00')).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
    expect(timeSlots(60).length).toBe(24);
  });
});

describe('A9 / E2: one StatusChip and StatusBadge shape, icon by meaning (DS 6.1 G-22)', () => {
  const semantics = Object.keys(statusSemantics) as StatusSemantic[];
  it('maps every semantic to its own icon and none of the non-done ones to the check mark', () => {
    const check = pathOf('check');
    for (const semantic of semantics) {
      const { container, unmount } = renderWithKit(<StatusChip semantic={semantic}>상태</StatusChip>);
      expect(iconOf(container), semantic).toBe(pathOf(statusSemantics[semantic].icon));
      if (semantic !== 'done') expect(iconOf(container), semantic).not.toBe(check);
      unmount();
    }
    expect(statusSemanticIcon('none')).toBeNull();
    expect(statusSemantics.recommend.icon).toBe('star');
    expect(statusSemantics.rating.icon).toBe('star');
    expect(statusSemantics.positive.icon).not.toBe('check');
    expect(statusSemantics.waiting.icon).toBe('clock');
    expect(statusSemantics.paused.icon).toBe('pause');
    expect(statusSemantics.info.icon).toBe('info');
    expect(statusSemantics.warning.icon).toBe('warning');
  });
  it('StatusChip keeps the tone default when no semantic is given, and none means a text-only kind chip', () => {
    const neutral = renderWithKit(<StatusChip>판매 중</StatusChip>);
    expect(iconOf(neutral.container)).toBe(pathOf('clock'));
    neutral.unmount();
    const success = renderWithKit(<StatusChip tone="success">완료</StatusChip>);
    expect(iconOf(success.container)).toBe(pathOf('check'));
    success.unmount();
    const none = renderWithKit(<StatusChip semantic="none">방문 예약</StatusChip>);
    expect(none.container.querySelector('svg')).toBeNull();
    expect(none.container.querySelector('.ui-status-chip')).toHaveAttribute('data-semantic', 'none');
  });
  it('a semantic brings its tone unless the caller sets one', () => {
    const { container } = renderWithKit(<><StatusChip semantic="warning">확인 필요</StatusChip><StatusChip semantic="done" tone="neutral">끝</StatusChip></>);
    const [warning, done] = [...container.querySelectorAll('.ui-status-chip')];
    expect(warning).toHaveAttribute('data-tone', 'warning');
    expect(done).toHaveAttribute('data-tone', 'neutral');
  });
  it('StatusBadge: recommended is a star (never the check mark), semantic wins over kind, and the words stay', () => {
    const a = renderWithKit(<StatusBadge kind="recommended" />);
    expect(iconOf(a.container)).toBe(pathOf('star'));
    expect(a.container).toHaveTextContent('추천');
    a.unmount();
    const b = renderWithKit(<StatusBadge kind="confirmed" semantic="waiting" label="대기" />);
    expect(iconOf(b.container)).toBe(pathOf('clock'));
    expect(b.container.querySelector('.ui-status-badge')).toHaveAttribute('data-semantic', 'waiting');
    b.unmount();
    const c = renderWithKit(<StatusBadge semantic="positive" label="긍정" />);
    expect(iconOf(c.container)).toBe(pathOf('thumb-up'));
    expect(c.container.querySelector('.ui-status-badge')).toHaveAttribute('data-tone', 'success');
  });
  it('shares one shape: height 28 (125% text: 30), radius.sm, 16 icon, caption 700, padding 0 / 8', () => {
    const tokens = css('../tokens.css'); const master = css('../mastermanage.css');
    const badge = rule(tokens, '.ui-integration-badge, .ui-status-badge');
    expect(badge).toContain('padding: 0 var(--space-2)'); expect(badge).toContain('border-radius: var(--radius-sm)');
    expect(badge).toContain('font-weight: var(--weight-bold)'); expect(badge).toContain('line-height: var(--leading-caption)');
    expect(rule(tokens, '.ui-status-badge')).toContain('min-height: 28px');
    expect(rule(tokens, '.ui-integration-badge .ui-icon, .ui-status-badge .ui-icon')).toContain('width: 16px');
    const chip = rule(master, '.ui-status-chip');
    expect(chip).toContain('min-height:28px'); expect(chip).toContain('padding:0 var(--space-2)'); expect(chip).toContain('border-radius:var(--radius-sm)'); expect(chip).toContain('font-weight:var(--weight-bold)');
    expect(master).toContain('.ui-status-chip svg {width:var(--space-4)');
    expect(tokens).not.toContain('.ui-recipient-row__badge'); // K-D: RecipientList uses the StatusBadge above
  });
  it('renderStatusChip is the DataGrid cell helper: one chip per cell, icon by meaning', () => {
    type Row = { id: string; name: string; label: string; semantic: StatusSemantic | 'none' };
    const rows: Row[] = [{ id: 'a', name: '우유', label: '입고 완료', semantic: 'done' }, { id: 'b', name: '원두', label: '입고 대기', semantic: 'waiting' }, { id: 'c', name: '컵', label: '방문 예약', semantic: 'none' }];
    const columns: GridColumn<Row>[] = [
      { id: 'name', header: '이름', kind: 'text', minWidth: 160, value: r => r.name },
      { id: 'status', header: '상태', kind: 'status', minWidth: 200, value: r => r.label, render: r => renderStatusChip(r.label, r.semantic) },
    ];
    renderWithKit(<DataGrid id="chips" label="상태 표" rows={rows} columns={columns} getRowId={r => r.id} getRowLabel={r => r.name} sort={null} onSortChange={() => {}} focus={null} onFocusChange={() => {}} selectedRowId={null} expandedRowIds={new Set()} emptyContent="비어 있어요" />);
    const grid = screen.getByRole('grid');
    const chips = [...grid.querySelectorAll<HTMLElement>('.ui-status-chip')];
    expect(chips.map(chip => chip.dataset.semantic)).toEqual(['done', 'waiting', 'none']);
    expect(iconOf(chips[0]!)).toBe(pathOf('check'));
    expect(iconOf(chips[1]!)).toBe(pathOf('clock'));
    expect(chips[2]!.querySelector('svg')).toBeNull();
    expect(within(grid).getByText('입고 완료')).toBeInTheDocument();
  });
});

describe('G1: checkbox and radio hit areas', () => {
  it('Checkbox: name from the label, Space and click toggle, caption is the description', async () => {
    const change = vi.fn();
    function Host() { const [on, setOn] = useState(false); return <Checkbox checked={on} onCheckedChange={next => { change(next); setOn(next); }} label="휴무일로 정하기" description="그날은 예약을 받지 않아요" name="closure" />; }
    renderWithKit(<Host />);
    const box = screen.getByRole('checkbox', { name: '휴무일로 정하기' });
    expect(box).toHaveAccessibleDescription('그날은 예약을 받지 않아요');
    expect(box).not.toBeChecked();
    box.focus(); await userEvent.keyboard(' ');
    expect(change).toHaveBeenLastCalledWith(true); expect(box).toBeChecked();
    await userEvent.click(box);
    expect(change).toHaveBeenLastCalledWith(false); expect(box).not.toBeChecked();
  });
  it('Checkbox: disabled does not toggle; primary size is marked', async () => {
    const change = vi.fn();
    renderWithKit(<Checkbox checked={false} onCheckedChange={change} label="문자 동의" disabled size="primary" />);
    const box = screen.getByRole('checkbox', { name: '문자 동의' });
    await userEvent.click(box);
    expect(change).not.toHaveBeenCalled();
    expect(box.closest('.ui-check')).toHaveAttribute('data-size', 'primary');
  });
  it('RadioGroup: a named group of round radios, click and arrows select, names stay', async () => {
    const change = vi.fn();
    function Host() { const [v, setV] = useState<'all' | 'group'>('all'); return <RadioGroup label="받는 사람" value={v} onValueChange={next => { change(next); setV(next); }} options={[{ value: 'all', label: '연락처가 있는 회원 전체' }, { value: 'group', label: '손님 그룹' }]} />; }
    renderWithKit(<Host />);
    const group = screen.getByRole('radiogroup', { name: '받는 사람' });
    const all = within(group).getByRole('radio', { name: '연락처가 있는 회원 전체' });
    const some = within(group).getByRole('radio', { name: '손님 그룹' });
    expect(all).toBeChecked(); expect(some).not.toBeChecked();
    await userEvent.click(some);
    expect(change).toHaveBeenLastCalledWith('group'); expect(some).toBeChecked();
    all.focus(); await userEvent.keyboard('{ArrowDown}');
    expect(group.querySelectorAll('.ui-check__box[data-shape="round"]')).toHaveLength(2);
  });
  it('the 48 hit area, the 24 visible box, the whole-row target and the 3px ring are in the CSS', () => {
    const tokens = css('../tokens.css'); const kit = css('./kit-controls.css');
    const box = rule(tokens, '.ui-checklist-row__box, .ui-check__box');
    expect(box).toContain('width: var(--target-default)'); expect(box).toContain('height: var(--target-default)');
    expect(box).toContain('border: var(--space-3) solid transparent'); // 48 - 2 * 12 = the 24 visible box
    expect(rule(tokens, '.ui-checklist-row__box::before, .ui-check__box::before')).toContain('inset: 0');
    expect(box).toContain('position: static'); // so inset: 0 spans the row, not just the box
    expect(rule(tokens, '.ui-checklist-row, .ui-recipient-row')).toContain('position: relative');
    expect(rule(kit, '.ui-check[data-size="primary"]')).toContain('min-height: var(--target-primary)');
    expect(rule(kit, '.ui-check')).toContain('min-height: var(--target-default)');
    expect(rule(kit, '.ui-check__box:focus-visible')).toContain('var(--stroke-focus)');
    expect(tokens).toMatch(/--stroke-focus: 3px/);
    expect(tokens).toMatch(/--target-min: 44px; --target-default: 48px; --target-primary: 56px/);
  });
});

describe('D1 / G-17: DateField', () => {
  it('shows the long date, never an ISO string, and names the field with its value', () => {
    renderWithKit(<DateField label="시작 날짜" value="2026-10-26" onValueChange={() => {}} name="start" />);
    const field = screen.getByRole('button', { name: '시작 날짜 10월 26일 월요일' });
    expect(field).toHaveTextContent('10월 26일 월요일');
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{4}\. \d{1,2}\./);
    expect(document.querySelector<HTMLInputElement>('input[name="start"]')).toHaveValue('2026-10-26');
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });
  it('shows the placeholder while empty and the localized long date in other languages', () => {
    const empty = renderWithKit(<DateField label="Date" value={null} onValueChange={() => {}} />, { locale: 'en' });
    expect(screen.getByRole('button', { name: 'Date Pick a date' })).toBeInTheDocument();
    empty.unmount();
    renderWithKit(<DateField label="日期" value="2026-10-26" onValueChange={() => {}} />, { locale: 'zh-Hans' });
    expect(screen.getByRole('button')).toHaveTextContent('10月26日 星期一');
  });
  it('opens the calendar, marks the value and today, picks a day, closes and returns focus to the field', async () => {
    const change = vi.fn();
    function Host() { const [v, setV] = useState<string | null>('2026-10-26'); return <DateField label="날짜" value={v} onValueChange={next => { change(next); setV(next); }} today="2026-10-27" />; }
    renderWithKit(<Host />);
    const field = screen.getByRole('button', { name: /^날짜 / });
    await userEvent.click(field);
    const dialog = await screen.findByRole('dialog', { name: '날짜 고르기' });
    expect(field).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('grid', { name: '2026년 10월' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['월', '화', '수', '목', '금', '토', '일']);
    const selected = within(dialog).getByRole('button', { name: '10월 26일 월요일' });
    expect(selected.closest('td')).toHaveAttribute('aria-selected', 'true');
    expect(selected).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: '10월 27일 화요일' })).toHaveAttribute('aria-current', 'date');
    await userEvent.click(within(dialog).getByRole('button', { name: '10월 29일 목요일' }));
    expect(change).toHaveBeenCalledWith('2026-10-29');
    expect(screen.queryByRole('dialog', { name: '날짜 고르기' })).toBeNull();
    expect(field).toHaveFocus();
    expect(field).toHaveTextContent('10월 29일 목요일');
  });
  it('keyboard: Down opens, arrows move a day or week, PageDown a month, Enter picks, Esc closes back to the field', async () => {
    const change = vi.fn();
    renderWithKit(<DateField label="날짜" value="2026-10-26" onValueChange={change} />);
    const field = screen.getByRole('button', { name: /^날짜 / });
    field.focus(); await userEvent.keyboard('{ArrowDown}');
    const dialog = await screen.findByRole('dialog', { name: '날짜 고르기' });
    await userEvent.keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('button', { name: '10월 27일 화요일' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(dialog).getByRole('button', { name: '11월 3일 화요일' })).toHaveFocus();
    expect(within(dialog).getByRole('grid', { name: '2026년 11월' })).toBeInTheDocument();
    await userEvent.keyboard('{Home}');
    expect(within(dialog).getByRole('button', { name: '11월 2일 월요일' })).toHaveFocus();
    await userEvent.keyboard('{PageDown}');
    expect(within(dialog).getByRole('button', { name: '12월 2일 수요일' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(change).toHaveBeenCalledWith('2026-12-02');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(field).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await screen.findByRole('dialog', { name: '날짜 고르기' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(field).toHaveFocus();
  });
  it('disables days outside min and max, offers 오늘 and 지우기', async () => {
    const change = vi.fn();
    renderWithKit(<DateField label="날짜" value="2026-10-26" onValueChange={change} min="2026-10-20" max="2026-10-28" today="2026-10-26" clearable />);
    await userEvent.click(screen.getByRole('button', { name: /^날짜 / }));
    const dialog = await screen.findByRole('dialog', { name: '날짜 고르기' });
    expect(within(dialog).getByRole('button', { name: '10월 19일 월요일' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '10월 29일 목요일' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '10월 20일 화요일' })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('button', { name: '지우기' }));
    expect(change).toHaveBeenCalledWith(null);
  });
  it('error and hint sentences sit under the field; the native fallback is only on request', () => {
    const a = renderWithKit(<DateField label="날짜" value="2026-10-26" onValueChange={() => {}} error="마지막 날보다 빨라야 해요" />);
    expect(screen.getByRole('button', { name: /^날짜 / })).toHaveAccessibleDescription(/마지막 날보다 빨라야 해요/);
    a.unmount();
    renderWithKit(<DateField label="날짜" value="2026-10-26" onValueChange={() => {}} native />);
    expect(document.querySelector('input[type="date"]')).toHaveValue('2026-10-26');
  });
  it('renders in dark mode and 125% text without a native control', () => {
    renderWithKit(<DateField label="날짜" value="2026-10-26" onValueChange={() => {}} />, { theme: 'dark', textScale: 125 });
    expect(document.querySelector('.ui-root')).toHaveAttribute('data-theme', 'dark');
    expect(document.querySelector('.ui-root')).toHaveAttribute('data-text-scale', '125');
    expect(document.querySelector('input[type="date"], input[type="time"]')).toBeNull();
  });
});

describe('TimeField', () => {
  it('shows HH:MM, lists times, picks one and returns focus', async () => {
    const change = vi.fn();
    function Host() { const [v, setV] = useState<string | null>('09:30'); return <TimeField label="시작 시각" value={v} onValueChange={next => { change(next); setV(next); }} min="09:00" max="12:00" />; }
    renderWithKit(<Host />);
    const field = screen.getByRole('button', { name: '시작 시각 09:30' });
    await userEvent.click(field);
    const list = await screen.findByRole('listbox', { name: '시작 시각' });
    expect(within(list).getAllByRole('option').map(o => o.textContent)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00']);
    expect(within(list).getByRole('option', { name: '09:30' })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('option', { name: '09:30' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(within(list).getByRole('option', { name: '10:30' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(change).toHaveBeenCalledWith('10:30');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field).toHaveFocus(); expect(field).toHaveTextContent('10:30');
  });
  it('keeps an off-grid value visible and offers a native fallback for tests only', async () => {
    const a = renderWithKit(<TimeField label="시각" value="09:10" onValueChange={() => {}} step={60} min="09:00" max="11:00" />);
    await userEvent.click(screen.getByRole('button', { name: /^시각 / }));
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').map(o => o.textContent)).toEqual(['09:00', '09:10', '10:00', '11:00']);
    a.unmount();
    renderWithKit(<TimeField label="시각" value="09:10" onValueChange={() => {}} native />);
    expect(document.querySelector('input[type="time"]')).toHaveValue('09:10');
  });
});

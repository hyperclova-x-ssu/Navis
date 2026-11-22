import { readFileSync } from 'node:fs';
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, PreviewSelection } from '../../../contracts';
import { createWidgetDataStore, readModel } from '../../../data/widget-data';
import { KitProviders, renderWithKit } from '../../../ui/test-utils';
import { DetailStack, SupplyPanel, createTestHost, moduleOf } from './testing';
import { CUPS as CUPS_ITEM, longDate, placeOrder } from './testing-cafe';
import { TODAY } from '../../../data/widget-data';

afterEach(cleanup);
// The calendar reads the cafe's 128 past orders and the week's shifts, so a screen that opens it takes longer than 5 s on a busy machine.
vi.setConfig({ testTimeout: 60_000 });
const calendarCss = readFileSync('src/features/widgets/mgmt-supply/mgmt-supply.css', 'utf8');
const preview = (family: PreviewSelection['family'], overrides: PreviewSelection['overrides'] = {}): PreviewSelection => ({ family, overrides });
const panel = (width: CellSpan, height: CellSpan, opts: Parameters<typeof renderWithKit>[1] = {}, host = createTestHost('calendar')) =>
  renderWithKit(<SupplyPanel id="calendar" width={width} height={height} host={host} />, opts);
const panelBody = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-widget="calendar"]')!;
const day = () => readModel(createWidgetDataStore().getSnapshot(), 'calendar');
/**
 * Today's list on the cafe seed: two shift changes and the owner's 16:30 sample event. The 08:00 cup delivery is already received, and a
 * delivery stays on the calendar only while quantity is open (DATA_MODEL), so it is not on the list.
 */
const CUPS = '음료 컵·뚜껑·슬리브 세트 입고 · 푸른패키징 상사';
const SAMPLE = '쇼케이스 진열 수량 확인';
/** The cafe seed has no open delivery: a test that needs one on the list puts the cups on order for today with the order screen's own command. */
const withOpenCups = () => { const store = createWidgetDataStore(); placeOrder(store, CUPS_ITEM, 500, TODAY); return store; };

describe('calendar panel (SCR-30 P5, AC-258)', () => {
  it('1×1 shows today\'s count with the date in ko, en and zh', () => {
    const count = String(day().todayCount);
    const ko = panel(1, 1);
    let body = panelBody(ko.container);
    expect(body).toHaveTextContent('오늘 일정');
    expect(body.querySelector('.ui-metric-fit__value')).toHaveTextContent(count);
    expect(body.querySelector('.ui-metric-fit__unit')).toHaveTextContent('건');
    expect(body).toHaveTextContent(longDate(TODAY));
    cleanup();
    const en = panel(1, 1, { locale: 'en' });
    body = panelBody(en.container);
    expect(body).toHaveTextContent("Today's schedule");
    expect(body.querySelector('.ui-metric-fit__unit')).toHaveTextContent('events');
    expect(body).toHaveTextContent('Tuesday, Nov 17');
    cleanup();
    const zh = panel(1, 1, { locale: 'zh-Hans' });
    body = panelBody(zh.container);
    expect(body).toHaveTextContent('今日日程');
    expect(body.querySelector('.ui-metric-fit__unit')).toHaveTextContent('项');
    expect(body).toHaveTextContent('11月17日 星期二');
  });

  it('1×2 lists today in time order: 12:00 근무 교대 / 16:30 직접 일정 / 17:00 근무 교대 (the received 08:00 컵 입고 is off the list)', () => {
    const { container } = panel(1, 2);
    const rows = [...panelBody(container).querySelectorAll('[data-row-id]')].map((r) => r.textContent);
    expect(rows).toEqual(['12:00근무 교대', `16:30${SAMPLE}`, '17:00근무 교대']);
    expect(rows).toHaveLength(day().todayCount);
    expect(day().todayCount).toBe(3);
  });

  it('2×1 shows only entries counted today', () => {
    const { container } = panel(2, 1);
    const rows = [...panelBody(container).querySelectorAll('[data-row-id]')].map((r) => r.textContent);
    expect(rows[0]).toBe('12:00근무 교대');
    expect(rows[1]).toBe(`16:30${SAMPLE}`);
    expect(rows).toHaveLength(2);
  });

  it('2×2 is the week view with the week\'s events, 3×3 the month view', () => {
    const model = day();
    const week = panel(2, 2);
    const body = panelBody(week.container);
    expect(body).toHaveAttribute('data-view', 'week');
    expect(body.querySelector('[data-slot="calendar.metric.label"]')).toHaveTextContent('오늘 일정');
    expect(body.querySelector('.ui-metric-fit__value')).toHaveTextContent(String(model.todayCount));
    expect(body.querySelectorAll('.ms-week__day')).toHaveLength(7);
    expect(body.querySelector('[aria-current="date"]')).toHaveTextContent(`${longDate(TODAY)}, 일정 ${model.todayCount}건`);
    cleanup();
    const month = panel(3, 3);
    const table = screen.getByRole('table', { name: '2026년 11월 달력' });
    // the grid runs from the Monday before the 1st to the Sunday after the 30th: 6 weeks + the weekday header
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(table.querySelector('[aria-current="date"]')).toHaveAttribute('aria-label', `${longDate(TODAY)}, 일정 ${model.todayCount}건`);
    expect(panelBody(month.container)).toHaveAttribute('data-view', 'month');
    expect(Array.from(panelBody(month.container).querySelectorAll('.ms-calendar-legend > span'), entry => entry.textContent))
      .toEqual(['매장 운영', '발주·입고', '세금·행정', '예약 픽업']);
  });

  it('the key sentence is the 1×1 sentence (accessible name) and the S line drops before the label', () => {
    const wrapper = ({ children }: { children?: ReactNode }) => <KitProviders>{children}</KitProviders>;
    const count = day().todayCount;
    const { result } = renderHook(() => moduleOf('calendar').useSummary({ featureId: 'calendar', condition: { kind: 'default' } }), { wrapper });
    expect(result.current).toBe(`오늘 일정 ${count}건, ${longDate(TODAY)}`);
    const en = renderHook(() => moduleOf('calendar').useSummary({ featureId: 'calendar', condition: { kind: 'default' } }), { wrapper: ({ children }) => <KitProviders locale="en">{children}</KitProviders> });
    expect(en.result.current).toBe(`${count} events today, Tuesday, Nov 17`);
    const { container } = panel(1, 1);
    const body = panelBody(container);
    expect(Number(body.querySelector('.ms-sub')!.getAttribute('data-drop'))).toBeGreaterThan(Number(body.querySelector('.ms-label')!.getAttribute('data-drop')));
    expect(body.querySelector('.ms-k__value')).not.toHaveAttribute('data-drop');
  });

  it('long English text keeps title, number and unit apart (AC-210/211 DOM level)', () => {
    const { container } = panel(1, 1, { locale: 'en', textScale: 125 });
    const fit = container.querySelector('.ui-metric-fit')!;
    expect(fit.querySelector('.ui-metric-fit__value')).not.toBe(fit.querySelector('.ui-metric-fit__unit'));
    expect(container.querySelector('.ui-panel-title')).toHaveTextContent('캘린더');
    expect(container.textContent).not.toContain('…');
  });
});

describe('calendar states (AC-259)', () => {
  it('empty: ‘오늘은 일정이 없어요’ + ‘일정 추가하기’ opens the detail with the add form', () => {
    const onDetail = vi.fn();
    panel(1, 1, { preview: preview('empty') }, createTestHost('calendar', { onDetail }));
    expect(screen.getByText('오늘은 일정이 없어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '일정 추가하기, 캘린더' }));
    expect(onDetail).toHaveBeenCalledWith({ featureId: 'calendar', view: 'add', focus: 'action' });
  });
  it('special: the other entries and ‘일부 일정을 불러오지 못했어요’', () => {
    const { container } = panel(1, 2, { preview: preview('special') });
    expect(panelBody(container)).toHaveTextContent('일부 일정을 불러오지 못했어요');
    expect(panelBody(container)).toHaveTextContent(SAMPLE);
  });
  it('error: retry resets this widget only', () => {
    const onReset = vi.fn();
    panel(1, 1, { preview: preview('error') }, createTestHost('calendar', { onReset }));
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기, 캘린더' }));
    expect(onReset).toHaveBeenCalledWith('calendar');
  });
});

describe('calendar detail (SCR-14·31·33, AC-226·258)', () => {
  const open = (opts: Parameters<typeof renderWithKit>[1] = {}, events = {}) => {
    const store = opts.store ?? createWidgetDataStore();
    const view = renderWithKit(<><DetailStack root={{ featureId: 'calendar' }} events={events} /><SupplyPanel id="calendar" width={1} height={1} /></>, { ...opts, store });
    return { ...view, store };
  };
  const todayCount = (store: ReturnType<typeof createWidgetDataStore>) => readModel(store.getSnapshot(), 'calendar').todayCount;

  it('uses Navis calendar copy and adds an event and a to-do that appear (AC-226, AC-258)', () => {
    const onNotify = vi.fn();
    const { store } = open({}, { onNotify });
    const start = todayCount(store);
    expect(screen.queryByText('네이버 캘린더 연결됨(예시)')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /일정 추가하기/ })[0]!);
    fireEvent.change(screen.getByLabelText('일정 제목'), { target: { value: '거래처 전화' } });
    fireEvent.change(screen.getByLabelText('시각'), { target: { value: '16:00' } });
    fireEvent.click(screen.getByRole('button', { name: '일정 저장하기' }));
    expect(todayCount(store)).toBe(start + 1);
    const today = screen.getByRole('list', { name: '오늘 일정' });
    expect([...today.querySelectorAll('.ms-entry__time')].map((n) => n.textContent)).toEqual(['12:00', '16:00', '16:30', '17:00']);
    expect(onNotify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.notice.calendarAdded', undoToken: expect.any(String) }));
    expect(within(screen.getByRole('list', { name: 'notices' })).getByText('일정에 추가했어요')).toBeInTheDocument();
    // The panel reads the same store.
    expect(document.querySelector('[data-widget="calendar"] .ui-metric-fit__value')).toHaveTextContent(String(start + 1));

    fireEvent.click(screen.getByRole('button', { name: /할 일 추가하기/ }));
    fireEvent.change(screen.getByLabelText('일정 제목'), { target: { value: '포스터 인쇄' } });
    fireEvent.click(screen.getByRole('button', { name: '할 일 저장하기' }));
    expect(todayCount(store)).toBe(start + 2);
    expect(within(screen.getByRole('list', { name: '오늘 일정' })).getByText('포스터 인쇄')).toBeInTheDocument();
  });

  it('adds an elapsed event today only after the owner chooses to keep it as a historical record', () => {
    const { store } = open();
    const before = store.getSnapshot();

    fireEvent.click(screen.getAllByRole('button', { name: /일정 추가하기/ })[0]!);
    fireEvent.change(screen.getByLabelText('일정 제목'), { target: { value: '거래처 미팅' } });
    fireEvent.change(screen.getByLabelText('시각'), { target: { value: '15:00' } });
    fireEvent.click(screen.getByRole('button', { name: '일정 저장하기' }));
    expect(store.getSnapshot()).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: '지난 기록으로 남기기' }));
    expect(store.getSnapshot().tables.calendarEvent).toHaveLength(before.tables.calendarEvent.length + 1);
    const agenda = within(screen.getByRole('list', { name: '오늘 일정' }));
    expect(agenda.getByRole('button', { name: '15:00 거래처 미팅 직접 추가함' })).toBeInTheDocument();
  });

  it('asks for a title and a valid time', () => {
    const { store } = open();
    const start = todayCount(store);
    fireEvent.click(screen.getAllByRole('button', { name: /일정 추가하기/ })[0]!);
    fireEvent.click(screen.getByRole('button', { name: '일정 저장하기' }));
    expect(screen.getByText('일정 제목을 넣어 주세요')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('일정 제목'), { target: { value: '점검' } });
    fireEvent.change(screen.getByLabelText('시각'), { target: { value: '25:99' } });
    fireEvent.click(screen.getByRole('button', { name: '일정 저장하기' }));
    expect(screen.getByText('시각을 확인해 주세요')).toBeInTheDocument();
    expect(todayCount(store)).toBe(start);
  });

  it('automatic entries are read-only and open the source detail (‘출처 열기’, AC-232)', () => {
    const onLinked = vi.fn();
    const { store } = open({ store: withOpenCups() }, { onLinked });
    const delivery = readModel(store.getSnapshot(), 'calendar').todayEntries.find((e) => e.source === 'delivery')!;
    // an order placed on the order screen has no expected hour yet: its entry is an all-day one
    const button = screen.getByRole('button', { name: new RegExp(`^종일 ${CUPS.split(' · ')[0]}.*푸른패키징 상사, 발주 자세히 보기$`) });
    expect(button).toHaveTextContent('입고에서 고칠 수 있어요');
    fireEvent.click(button);
    expect(onLinked).toHaveBeenCalledWith({ featureId: 'suppliers', view: 'order', itemId: delivery.sourceId });
    expect(screen.getByRole('region', { name: 'detail:suppliers' })).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: '발주 내역' }).querySelector(`[data-grid-row="${delivery.sourceId}"]`)).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));
    expect(screen.getByRole('region', { name: 'detail:calendar' })).toBeInTheDocument();
  });

  it('edits and deletes the owner\'s own event', () => {
    const { store } = open();
    const start = todayCount(store);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(SAMPLE) }));
    expect(screen.getByRole('button', { name: `${SAMPLE} 고치기` })).toHaveTextContent(`${SAMPLE} 고치기`);
    fireEvent.click(screen.getByRole('button', { name: `${SAMPLE} 고치기` }));
    fireEvent.change(screen.getByLabelText('일정 제목'), { target: { value: `${SAMPLE}(마감 전)` } });
    fireEvent.click(screen.getByRole('button', { name: '일정 저장하기' }));
    expect(within(screen.getByRole('list', { name: '오늘 일정' })).getByText(`${SAMPLE}(마감 전)`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `${SAMPLE}(마감 전) 지우기` }));
    expect(todayCount(store)).toBe(start);
    fireEvent.click(within(screen.getByRole('group', { name: '일정을 지울까요?' })).getByRole('button', { name: '일정 지우기' }));
    expect(todayCount(store)).toBe(start - 1);
  });

  it('reservations are off by default and add to today when turned on (AC-258)', () => {
    const { store } = open();
    const start = todayCount(store);
    const reservations = screen.getByRole('switch', { name: '예약도 보기' });
    expect(reservations).not.toBeChecked();
    act(() => { fireEvent.click(reservations); });
    expect(screen.getByRole('switch', { name: '예약도 보기' })).toBeChecked();
    expect(todayCount(store)).toBeGreaterThan(start);
  });

  it('switches month / week / day', () => {
    open();
    expect(screen.getByRole('table', { name: '2026년 11월 달력' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '주' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.querySelectorAll('.ms-week-grid__day')).toHaveLength(7);
    fireEvent.click(screen.getByRole('radio', { name: '일' }));
    expect(screen.getAllByRole('group', { name: '날짜' })[0]).toHaveTextContent(longDate(TODAY));
  });

  it('dates are picked in the kit calendar, never in a browser date input (D1)', () => {
    const { container } = open();
    expect(container.querySelector('input[type="date"]')).toBeNull();
    // the view date shows the long date, not 2026. 11. 17.
    expect(screen.getByRole('button', { name: `날짜 ${longDate(TODAY)}` })).toHaveTextContent(longDate(TODAY));
    expect(document.body.textContent).not.toMatch(/\d{4}\. \d{1,2}\. \d{1,2}\./);
    fireEvent.click(screen.getAllByRole('button', { name: /일정 추가하기/ })[0]!);
    expect(within(screen.getByRole('form')).getByRole('button', { name: `날짜 ${longDate(TODAY)}` })).toBeInTheDocument();
    expect(container.querySelector('input[type="date"]')).toBeNull();
  });

  it('the store-closure choice is a kit checkbox with the end date picked in the calendar', () => {
    open();
    fireEvent.click(screen.getAllByRole('button', { name: /일정 추가하기/ })[0]!);
    const form = within(screen.getByRole('form'));
    expect(form.queryByRole('button', { name: /^휴무 종료일 / })).toBeNull();
    const closure = form.getByRole('checkbox', { name: '매장 휴무' });
    expect(closure.closest('.ui-check')).toBeInTheDocument();
    fireEvent.click(closure);
    expect(form.getByRole('checkbox', { name: '매장 휴무' })).toBeChecked();
    expect(form.getByRole('button', { name: `휴무 종료일 ${longDate(TODAY)}` })).toBeInTheDocument();
    // one name only: the old fieldset legend repeated 매장 휴무 above its own checkbox
    expect(form.getAllByText('매장 휴무')).toHaveLength(1);
  });

  it('keeps the agenda in month view and moves pickups and staff entries into the week and day lists', () => {
    const { container } = open();
    const agenda = container.querySelector('.ms-cal__agenda')!;
    expect(within(agenda as HTMLElement).getByRole('list', { name: '오늘 일정' })).toBeInTheDocument();
    const staffEntry = agenda.querySelector('[data-row-id^="shift:"][data-row-id]:not([data-row-id*="@"])');
    expect(staffEntry).toBeInTheDocument();
    const staffRow = `[data-row-id="${staffEntry!.getAttribute('data-row-id')}"]`;
    // the cafe seed has no pickup today: the switch is there and on, and a pickup would sit in the same lists as the shifts
    const pickups = screen.getByRole('switch', { name: '예약 픽업도 보기' });
    expect(pickups).toBeChecked();
    for (const mode of ['주', '일']) {
      fireEvent.click(screen.getByRole('radio', { name: mode }));
      const main = screen.getByRole('region', { name: mode });
      expect(container.querySelector('.ms-cal__agenda')).toBeNull();
      expect(main.querySelector(staffRow)).toBeInTheDocument();
    }
    fireEvent.click(pickups);
    expect(screen.getByRole('switch', { name: '예약 픽업도 보기' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: '월' }));
    expect(container.querySelector('.ms-cal__agenda')).toBeInTheDocument();
  });

  it('a narrow week card puts the shift name and its hours on two lines instead of ending a line with a dot', () => {
    const { container } = open();
    fireEvent.click(screen.getByRole('radio', { name: '주' }));
    const card = container.querySelector('.ms-week-grid__day[data-today="true"] [data-row-id^="shift:sample-shift"]')!;
    const parts = [...card.querySelectorAll('.ms-entry__part')].map((n) => n.textContent!.replace(/\s*·\s*/, ''));
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatch(/^\d{2}:\d{2}~\d{2}:\d{2}$/);
    for (const part of card.querySelectorAll('.ms-entry__part')) expect(part.textContent).not.toMatch(/·\s*$/);
  });

  it('shows one editor in week and day view without restoring the agenda', () => {
    const { store, container } = open();
    const start = todayCount(store);
    fireEvent.click(screen.getByRole('radio', { name: '주' }));
    fireEvent.click(screen.getByRole('button', { name: '일정 추가하기' }));
    fireEvent.change(screen.getByLabelText('일정 제목'), { target: { value: '주간 점검' } });
    fireEvent.click(screen.getByRole('radio', { name: '일' }));

    expect(container.querySelector('.ms-cal__agenda')).toBeNull();
    expect(screen.getAllByRole('form')).toHaveLength(1);
    expect(screen.getByLabelText('일정 제목')).toHaveValue('주간 점검');
    fireEvent.click(screen.getByRole('button', { name: '일정 저장하기' }));
    expect(todayCount(store)).toBe(start + 1);
    expect(screen.getByRole('region', { name: '일' })).toHaveTextContent('주간 점검');
  });

  it('shows the agenda number and unit in one text node and centers only linked chevrons', () => {
    const { container, store } = open({ store: withOpenCups() });
    renderWithKit(<style>{calendarCss}</style>);
    const agenda = container.querySelector<HTMLElement>('.ms-cal__agenda')!;
    const count = within(agenda).getByText(`${todayCount(store)}건`);
    expect(count.childNodes).toHaveLength(1);
    expect(count.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    const delivery = within(agenda).getByRole('button', { name: /컵·뚜껑·슬리브 세트 입고/ });
    expect(getComputedStyle(delivery.querySelector('.ms-entry__chevron')!).alignSelf).toBe('center');
    expect(within(agenda).getByRole('button', { name: new RegExp(SAMPLE) }).querySelector('.ms-entry__chevron')).toBeNull();
  });

  it('keeps the view, source switches and add buttons above the category checkboxes (SCR-224)', () => {
    const { container } = open();
    renderWithKit(<style>{calendarCss}</style>);
    const toolbar = container.querySelector<HTMLElement>('.ms-calendar-toolbar')!;
    expect(toolbar.children).toHaveLength(2);
    const [primary, filters] = Array.from(toolbar.children) as HTMLElement[];
    expect(getComputedStyle(primary!).alignItems).toBe('center');
    expect(within(primary!).getByRole('radiogroup', { name: '보기' })).toBeInTheDocument();
    expect(within(primary!).getAllByRole('switch')).toHaveLength(2);
    expect(within(primary!).queryByText('네이버 캘린더 연결됨(예시)')).not.toBeInTheDocument();
    expect(within(primary!).getByRole('button', { name: '일정 추가하기' })).toBeInTheDocument();
    expect(getComputedStyle(filters!).alignItems).toBe('center');
    expect(within(filters!).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(filters!).getByText('분류별로 보기')).toBeInTheDocument();
  });

  it('a category checkbox hides that category from today\'s list', () => {
    const { store } = open({ store: withOpenCups() });
    const start = todayCount(store);
    expect(start).toBe(4);
    const stock = screen.getByRole('checkbox', { name: '발주·입고' });
    expect(stock).toBeChecked();
    fireEvent.click(stock);
    expect(screen.getByRole('checkbox', { name: '발주·입고' })).not.toBeChecked();
    // the open cup delivery is the only purchasing entry today
    expect(todayCount(store)).toBe(start - 1);
    for (const name of ['매장 운영', '세금·행정']) fireEvent.click(screen.getByRole('checkbox', { name }));
    expect(screen.getByText('보이는 분류가 없어요. 분류를 켜 주세요')).toBeInTheDocument();
  });

  it('empty sample state: ‘일정 추가하기’ really adds and returns the widget to normal', () => {
    const onReset = vi.fn();
    const { store } = open({ preview: preview('empty') }, { onReset });
    const start = todayCount(store);
    fireEvent.click(within(screen.getByRole('region', { name: 'detail:calendar' })).getByRole('button', { name: '일정 추가하기' }));
    fireEvent.change(screen.getByLabelText('일정 제목'), { target: { value: '청소' } });
    fireEvent.click(screen.getByRole('button', { name: '일정 저장하기' }));
    expect(todayCount(store)).toBe(start + 1);
    expect(onReset).toHaveBeenCalledWith('calendar');
  });

  it('opens with the add form when asked for the action (focus) and in English', () => {
    renderWithKit(<DetailStack root={{ featureId: 'calendar', focus: 'action' }} />, { locale: 'en' });
    expect(screen.getByRole('form', { name: 'Add event' })).toBeInTheDocument();
    expect(screen.queryByText('Naver Calendar connected (sample)')).not.toBeInTheDocument();
  });
});

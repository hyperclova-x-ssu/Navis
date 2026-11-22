import { useCallback, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDomainState, useRealRetry, useStaffSchedule, useWidgetDataStore } from '../../../data/react';
import type { Staff, StaffSchedule, StaffScheduleModel } from '../../../data/widget-data';
import { staffCalendarClock, staffLocalTimestamp } from '../../../data/iteration7/staff/clock';
import { useStaffCalendarCommand } from '../../../data/reality/07/use-staff-calendar-command';
import type { ShiftConflict } from '../../../data/iteration7/staff';
import { useBundle, useI18n } from '../../../i18n';
import { dataBundle } from '../../../data/messages';
import { ActionButton, DataGrid, DateField, DateStepper, DetailFooterContent, DetailSidePanel, DetailTabs, IconButton, InlineEmpty, MetricFit, NumberField, PanelState, SegmentedControl, Table, TextField, TimeField, type DataGridHandle, type GridColumn, type GridFocus } from '../../../ui';
import { daysInPeriod, periodFor, shiftPeriod, validateSchedule, type PeriodMode } from './model';
import { FitProbe } from '../mgmt-money/fit';
import { PanelRemainder } from './panel-remainder';
import { restoreGrid } from '../mgmt-customers/workspace';
import { staffDetailEntry } from '../../assistant/domains/calendar-staff';
import { WorksSentTab, WorksShiftSection, worksBundle } from './works';
import './staff.css';

const requestId = () => `staff-ui:${crypto.randomUUID()}`;
const staffWarnings = {
  id: 'widget.staff-schedule.warnings',
  ko: { 'staffSchedule.pastShift': '지난 근무' },
  en: { 'staffSchedule.pastShift': 'Past shift' },
  'zh-Hans': { 'staffSchedule.pastShift': '已结束的班次' },
  'zh-Hant': { 'staffSchedule.pastShift': '已結束的班次' },
} as const;
function shiftLabels(row: StaffSchedule) {
  if (row.kind === 'off') return { time: '직원 휴무' };
  return { time: `${row.start}~${row.end}`, rest: row.breakMinutes ? `휴게 ${row.breakMinutes}분` : undefined };
}
function rowText(row: StaffSchedule) {
  const { time, rest } = shiftLabels(row);
  return rest ? `${time} · ${rest}` : time;
}
/** Short store-local date for headers, names and sentences (`11/17(화)`), from the shared formatter so no ISO date reaches the screen. */
type DateLabel = (date: string) => string;
type StaffClock = ReturnType<typeof staffCalendarClock>;
function useDateLabel(): DateLabel {
  const { format } = useI18n();
  return date => format.date(date, 'short');
}
const errors: Readonly<Record<string, string>> = { NAME_REQUIRED: '직원 이름을 넣어 주세요', INVALID_SHIFT: '퇴근 시각은 출근 시각보다 뒤여야 해요', BREAK_TOO_LONG: '휴게 시간은 근무 시간보다 짧아야 해요', STAFF_SHIFT_OVERLAP: '같은 직원의 근무 시간이 겹쳐요' };
const errorMessage = (reason?: string) => errors[reason ?? ''] ?? '저장하지 못했어요. 다시 시도해 주세요';
/** The whole line the shared execute gives a refusal no sentence of this form covers ("실행하지 못했어요 · {이유}. {다음}"). */
const failureLineKey = (messageKey: string) => messageKey.startsWith('data.real.commandFailure.result.') ? messageKey : undefined;

type StaffView = ReturnType<typeof useStaffSchedule>;
function State({ view, host, compact = false, detail = false, onAdd }: { view: StaffView; host: WidgetHost; compact?: boolean; detail?: boolean; onAdd?: () => void }) {
  const state = useDomainState('staff');
  const retry = useRealRetry('staff');
  const retryRead = state.mode === 'http' ? retry : host.resetPreview;
  if (view.status === 'ready') return null;
  if (view.messageKey === 'data.real.loading') return <p role="status" className="staff-empty">근무표를 불러오는 중이에요</p>;
  // In the detail window the retry is a plain default button (48); the dashboard card keeps the kit's panel action.
  if (view.status === 'error' && detail) return <PanelState tone="error" message="근무표를 불러오지 못했어요"><div className="staff-retry"><ActionButton variant="secondary" onClick={() => retryRead()}>다시 시도하기</ActionButton></div></PanelState>;
  if (view.status === 'error') return <PanelState tone="error" message="근무표를 불러오지 못했어요" shortMessage={compact ? '불러오지 못했어요' : undefined} action={{ label: '다시 시도하기', widgetName: '직원 스케줄표', onPress: () => retryRead() }} />;
  return <div className="staff-empty"><p>아직 등록한 직원이 없어요</p><ActionButton variant="secondary" onClick={() => { host.resetPreview(); if (onAdd) onAdd(); else host.openDetail({ featureId: 'staff-schedule', focus: 'action' }); }}>직원 추가하기</ActionButton></div>;
}

function useStaffClock() {
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return staffCalendarClock(snapshot.tables);
}

export function StaffPanel(props: WidgetPanelProps) {
  const { date: today } = useStaffClock();
  const period = periodFor(today, 'week');
  const view = useStaffSchedule(period);
  const dateLabel = useDateLabel();
  if (view.status !== 'ready') return <State view={view} host={props.host} compact={props.height === 1 && props.width <= 2} />;
  const m = view.model;
  const note = view.notes?.find(item => item.messageKey === 'data.real.stale' || item.messageKey === 'data.real.partial');
  const rows = m.rows.filter(row => row.date === today);
  const names = new Map(m.staff.map(person => [person.staffId, person.name]));
  const hourly = (hour: number) => m.hourly.find(item => item.date === today && item.hour === hour)?.staffCount ?? 0;
  const wide = props.width >= 3 && props.height >= 2;
  /** D-333: from 3x3 up the week grid also gets the handoff time, the break of each shift, the week total and the latest change (the reverse of the drop order). */
  const large = props.width >= 3 && props.height >= 3;
  const tallest = props.height === 4;
  const compact = props.width === 1 && props.height === 1;
  const weekTotal = <p className="staff-week-total">이번 주 근무 {m.rows.filter(row => row.kind === 'work').length}건 · 휴무 {m.rows.filter(row => row.kind === 'off').length}건</p>;
  const metric = <div className="staff-primary"><div data-slot="staff-schedule.metric.value"><MetricFit value={String(m.today.workingCount)} unit="명" longest="999" stacked={false} /></div><p className="staff-label">오늘 근무</p></div>;
  const valueRow = (name: string, value: React.ReactNode, className = '') => <div className={`staff-value-row ${className}`} key={name}><span>{name}</span><strong>{value}</strong></div>;
  return <div className="staff-panel" data-width={props.width} data-height={props.height} lang="ko">
    <div className="staff-metrics">{metric}{(large || (props.width === 2 && props.height >= 2)) && m.today.nextHandoffAt && <div className="staff-primary"><MetricFit value={m.today.nextHandoffAt} stacked={false} /><p className="staff-label">교대</p></div>}</div>
    {note ? <p className="staff-recent" role="status">{note.messageKey === 'data.real.partial' ? '일부 근무만 보여드려요' : '최신 근무표가 아닐 수 있어요'}</p> : null}
    {!compact && (props.height === 1 ? <div className="staff-panel-list">
      {valueRow('오전', `${hourly(10)}명`)}{valueRow('오후', `${hourly(18)}명`)}
      {props.width >= 3 && <>{valueRow('직원 휴무', `${m.today.offCount}명`, 'staff-extra-row')}{m.today.nextHandoffAt && valueRow('교대', m.today.nextHandoffAt, 'staff-extra-row')}</>}
    </div> : wide ? <><MiniGrid model={m} dateLabel={dateLabel} today={today} breaks={large}
      maxRows={props.height === 2 ? 2 : props.width === 3 && props.height === 3 ? 4 : undefined} />{large && <div className="staff-panel-list">
      {weekTotal}
      {m.changes.slice(tallest ? -4 : -1).reverse().map((change, index) => <p className="staff-recent" key={change.changeId}>{index === 0 && '최근 변경 · '}{historyText(change.after ?? change.before, m.staff, dateLabel)}</p>)}
    </div>}</> : <div className="staff-panel-list">
      {rows.slice(0, tallest ? undefined : props.height === 2 && props.width === 2 ? 4 : 5).map(row => <div className="staff-value-row staff-person-row" key={row.scheduleId} aria-label={`${names.get(row.staffId)} ${rowText(row)}`}><span>{names.get(row.staffId)}</span><strong>{row.kind === 'off' ? <span className="staff-off">직원 휴무</span> : `${row.start}~${row.end}`}</strong></div>)}
      {props.width === 1 && <PanelRemainder total={rows.length} rowSelector=".staff-person-row" unit="명" />}
      {props.width === 2 && weekTotal}
      {props.width === 2 && props.height >= 3 && m.changes.at(-1) && <p className="staff-recent">최근 변경 · {historyText(m.changes.at(-1)!.after ?? m.changes.at(-1)!.before, m.staff, dateLabel)}</p>}
    </div>)}
    <FitProbe order={[{ selector: '.staff-break' }, { selector: '.staff-recent' }, { selector: '.staff-week-total' }, { selector: '.staff-extra-row', last: true }, { selector: '.staff-person-row', last: true }, { selector: '.staff-mini tbody tr', last: true }]} deps={[props.width, props.height, m.rows.length, m.today.workingCount]} />
  </div>;
}
function MiniGrid({ model, dateLabel, today, breaks = false, maxRows }: { model: StaffScheduleModel; dateLabel: DateLabel; today: string; breaks?: boolean; maxRows?: number }) {
  const dates = daysInPeriod(model.period.start, model.period.end).slice(0, 7);
  const working = new Set(model.rows.filter(row => row.date === today && row.kind === 'work').map(row => row.staffId));
  const staff = maxRows === undefined ? model.staff
    : [...model.staff].sort((a, b) => Number(working.has(b.staffId)) - Number(working.has(a.staffId))).slice(0, maxRows);
  const compactStart = Math.max(0, Math.min(dates.indexOf(today), dates.length - 4));
  const dayClass = (index: number) => index >= compactStart && index < compactStart + 4 ? undefined : 'staff-extra-day';
  return <div className="staff-mini" aria-label="주간 근무표 미리보기">
    <table>
      <thead><tr><th>직원</th>{dates.map((date, i) => <th key={date} className={dayClass(i)} data-today={date === today || undefined} aria-current={date === today ? 'date' : undefined}>{dateLabel(date)}</th>)}</tr></thead>
      <tbody>{staff.map(person => <tr key={person.staffId}><th>{person.name}</th>{dates.map((date, i) => <td key={date} className={dayClass(i)}>
        {model.rows.filter(row => row.staffId === person.staffId && row.date === date).map(row => <span data-kind={row.kind} aria-label={rowText(row)} key={row.scheduleId}>
          {row.kind === 'off' ? '직원 휴무' : `${row.start}~${row.end}`}
          {breaks && row.kind === 'work' && row.breakMinutes > 0 && <small className="staff-break">휴게 {row.breakMinutes}분</small>}
        </span>)}</td>)}</tr>)}</tbody>
    </table>
    <PanelRemainder total={model.staff.length} rowSelector="tbody tr" unit="명" />
  </div>;
}

export function useStaffSummary() {
  const { date } = useStaffClock();
  const view = useStaffSchedule(periodFor(date, 'week'));
  return view.status === 'ready' ? `오늘 근무 ${view.model.today.workingCount}명${view.model.today.nextHandoffAt ? ` · ${view.model.today.nextHandoffAt} 교대` : ''}` : view.status === 'error' ? '근무표를 불러오지 못했어요' : '아직 등록한 직원이 없어요';
}

const conflictsOf = (details: Readonly<Record<string, unknown>> | undefined): readonly ShiftConflict[] => Array.isArray(details?.conflicts) ? details.conflicts as ShiftConflict[] : [];
type StaffPrefill = ReturnType<typeof staffDetailEntry>['prefill'];
type Editor = { kind: 'staff'; person?: Staff; prefill?: StaffPrefill } | { kind: 'schedule'; row?: StaffSchedule; off?: boolean; prefill?: StaffPrefill } | { kind: 'handoff'; from: string; shiftRevision?: number } | { kind: 'deleteStaff'; person: Staff; shiftRevision?: number } | { kind: 'deleteSchedule'; row: StaffSchedule };
export function StaffDetail(props: WidgetDetailProps) {
  const state = useDomainState('staff');
  const retry = useRealRetry('staff');
  if (state.mode === 'http' && (state.status === 'idle' || state.status === 'loading' || state.status === 'error')) {
    return <div className="staff-detail" data-widget="staff-schedule" lang="ko">
      {state.status === 'error'
        ? <PanelState tone="error" message="근무표를 불러오지 못했어요"><div className="staff-retry"><ActionButton variant="secondary" onClick={retry}>다시 시도하기</ActionButton></div></PanelState>
        : <p role="status" className="staff-empty">근무표를 불러오는 중이에요</p>}
    </div>;
  }
  return <StaffDetailContent {...props} />;
}

function StaffDetailContent({ host, detailRef }: WidgetDetailProps) {
  const store = useWidgetDataStore();
  const clock = useStaffClock();
  const real = store.real?.state('staff').mode === 'http';
  const [entry] = useState(() => staffDetailEntry(detailRef, store.getSnapshot()));
  const [tab, setTab] = useState<'week' | 'month' | 'staff' | 'history' | 'works'>(entry.tab);
  const { t: worksT } = useBundle(worksBundle);
  const [orientation, setOrientation] = useState<'employee' | 'date'>(entry.orientation);
  const [date, setDate] = useState(entry.date);
  const [editor, setEditor] = useState<Editor | null>(() => entry.action === 'schedule' ? { kind: 'schedule', row: entry.row, prefill: entry.prefill }
    : entry.action === 'staff' ? { kind: 'staff', person: entry.person, prefill: entry.prefill } : null);
  const dateLabel = useDateLabel();
  const mode: PeriodMode = tab === 'month' ? 'month' : 'week';
  const period = periodFor(date, mode);
  const view = useStaffSchedule(period);
  const model = view.status === 'ready' ? view.model : null;
  const note = view.status === 'ready' ? view.notes?.find(item => item.messageKey === 'data.real.stale' || item.messageKey === 'data.real.partial') : undefined;
  const retry = useRealRetry('staff');
  const detail = useRef<HTMLDivElement>(null);
  const routedShift = entry.action ? undefined : entry.row?.scheduleId;
  useLayoutEffect(() => {
    if (!routedShift || view.status !== 'ready') return;
    const shift = detail.current?.querySelector(`button[data-schedule-id="${CSS.escape(routedShift)}"]`);
    if (shift instanceof HTMLButtonElement) {
      shift.focus({ preventScroll: true });
      shift.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }, [routedShift, view.status]);
  const grid = useRef<DataGridHandle>(null);
  const firstFieldRef = useRef<HTMLElement | null>(null);
  /** What opened the panel, so closing can hand focus back to it when no row can (Safari does not focus a pressed button, so the press target is kept). */
  const opener = useRef<HTMLElement | null>(null);
  const openEditor = (next: Editor, from?: HTMLElement | null) => {
    const source = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (source && !source.closest('.ui-detail-side-panel')) opener.current = source;
    setEditor(next);
  };
  const closeEditor = useCallback(() => setEditor(null), []);
  // A form belongs to the tab it was opened in (C5/H5): changing the tab closes it.
  const changeTab = (next: typeof tab) => { setTab(next); setEditor(null); };
  const restoreFocus = (key: string) => {
    const [kind, id = ''] = key.split(':');
    if (kind === 'shift') {
      const buttons = Array.from(detail.current?.querySelectorAll<HTMLButtonElement>(`button[data-schedule-id="${CSS.escape(id)}"]`) ?? []);
      for (const button of buttons) { button.focus({ preventScroll: true }); if (document.activeElement === button) return; }
    }
    if (kind === 'person' && grid.current) { restoreGrid(grid, id, 'name', model?.staff.map(person => person.staffId) ?? []); return; }
    if (opener.current?.isConnected) { opener.current.focus({ preventScroll: true }); return; }
    detail.current?.querySelector<HTMLElement>('.staff-toolbar button')?.focus({ preventScroll: true });
  };
  const panelTitle = editor ? editorTitle(editor) : '';
  const editedShift = editor?.kind === 'schedule' ? editor.row : undefined;
  const danger = editedShift
    ? <ActionButton variant="ghost" onClick={() => setEditor({ kind: 'deleteSchedule', row: editedShift })}>근무 지우기</ActionButton> : undefined;
  const editShift = (row: StaffSchedule, from: HTMLElement) => {
    if (editedShift?.scheduleId === row.scheduleId) closeEditor();
    else openEditor({ kind: 'schedule', row }, from);
  };
  return <div ref={detail} className="staff-detail" data-widget="staff-schedule" lang="ko">
    <DetailTabs value={tab} onValueChange={changeTab} label="직원 스케줄표 보기" tabs={[{ value: 'week', label: '주간 근무표' }, { value: 'month', label: '월간 근무표' }, { value: 'staff', label: '직원 목록' }, { value: 'history', label: '근무 변경 이력' },
      { value: 'works', label: worksT('works.tab') }]} />
    {view.status === 'error' ? <State view={view} host={host} detail /> : <>
      {note ? <div className="staff-toolbar"><p role="status">{note.messageKey === 'data.real.partial' ? '일부 근무만 보여드려요' : '최신 근무표가 아닐 수 있어요'}</p>
        <ActionButton variant="outline" onClick={retry}>다시 불러오기</ActionButton></div> : null}
      {tab !== 'history' && tab !== 'works' ? <div className="staff-toolbar">
        {(tab === 'week' || tab === 'month') && <div className="staff-toolbar__view"><SegmentedControl value={orientation} onChange={setOrientation} label="근무표 보기 방식" options={[{ value: 'employee', label: '직원별 보기' }, { value: 'date', label: '날짜별 보기' }]} /><DateStepper text={`${dateLabel(period.startDate)} ~ ${dateLabel(period.endDate)}`} onPrevious={() => setDate(shiftPeriod(date, mode, -1))} onNext={() => setDate(shiftPeriod(date, mode, 1))} /></div>}
        <div className="staff-toolbar__add">
          <ActionButton variant="secondary" onClick={event => openEditor({ kind: 'staff' }, event.currentTarget)}>직원 추가하기</ActionButton>
          {model?.staff.length ? <><ActionButton variant="secondary" onClick={event => openEditor({ kind: 'schedule' }, event.currentTarget)}>근무 추가하기</ActionButton><ActionButton variant="secondary" onClick={event => openEditor({ kind: 'schedule', off: true }, event.currentTarget)}>휴무 등록하기</ActionButton></> : null}
          <ActionButton variant="secondary" disabled={!model?.today.nextHandoffAt}
            title={!model?.today.nextHandoffAt ? '예정된 교대가 없어요' : undefined}
            onClick={event => { if (model?.today.nextHandoffAt) openEditor({ kind: 'handoff', from: model.today.nextHandoffAt, shiftRevision: store.getSnapshot().tables.staffShiftRevision }, event.currentTarget); }}>교대 시각 고치기</ActionButton>
        </div>
      </div> : null}
      {tab === 'history' ? <History changes={model?.changes ?? []} staff={model?.staff ?? []} real={real} />
        : tab === 'works' ? <WorksSentTab today={clock.date} />
        : !model || !model.staff.length ? <div className="staff-empty"><p>아직 등록한 직원이 없어요</p></div>
        : tab === 'staff' ? <StaffList staff={model.staff} grid={grid} selectedId={editor?.kind === 'staff' || editor?.kind === 'deleteStaff' ? editor.person?.staffId ?? null : null} onEdit={person => openEditor({ kind: 'staff', person })} onClose={closeEditor} onDelete={person => openEditor({ kind: 'deleteStaff', person, shiftRevision: store.getSnapshot().tables.staffShiftRevision })} />
        : <ScheduleGrid model={model} dates={daysInPeriod(period.startDate, period.endDate)} mode={mode} orientation={orientation} clock={clock} selectedId={editedShift?.scheduleId ?? routedShift} onEdit={editShift} />}
      <DetailSidePanel open={!!editor} selectedRowId={editor ? JSON.stringify(editor) : null} title={panelTitle} onClose={closeEditor}
        returnFocusKey={editor ? editorFocusKey(editor) : ''} onRestoreFocus={restoreFocus} initialFocusRef={firstFieldRef} danger={danger}>
        {editor && <EditorForm key={JSON.stringify(editor)} editor={editor} model={model} date={date} today={clock.date} host={host} firstFieldRef={firstFieldRef} onClose={closeEditor} />}
        {editor?.kind === 'schedule' && editor.row ? <WorksShiftSection key={editor.row.scheduleId} row={editor.row} /> : null}
      </DetailSidePanel>
    </>}
  </div>;
}
const staffColumns: readonly GridColumn<Staff>[] = [
  { id: 'name', header: '직원 이름', kind: 'text', minWidth: 200, value: person => person.name },
];

function StaffList({ staff, grid, selectedId, onEdit, onClose, onDelete }: { staff: readonly Staff[]; grid: React.RefObject<DataGridHandle | null>; selectedId: string | null; onEdit: (person: Staff) => void; onClose: () => void; onDelete: (person: Staff) => void }) {
  const [focus, setFocus] = useState<GridFocus>(null);
  return <div className="staff-people">
    <DataGrid
      id="staff-people"
      label="직원 목록"
      columns={staffColumns}
      ref={grid}
      rows={staff}
      getRowId={person => person.staffId}
      getRowLabel={person => person.name}
      sort={null}
      onSortChange={() => {}}
      selectedRowId={selectedId}
      onSelectionChange={id => {
        const person = staff.find(item => item.staffId === id);
        if (person) onEdit(person); else onClose();
      }}
      expandedRowIds={new Set()}
      focus={focus}
      onFocusChange={setFocus}
      rowActionsLabel="지우기"
      getRowActions={person => [{ id: 'delete', label: '직원 지우기', onPress: () => onDelete(person) }]}
      renderRowActions={(_person, actions) => actions.map(action => (
        <IconButton key={action.id} variant="ghost" className="staff-people__delete" icon="trash" label={action.label} onClick={action.onPress} />
      ))}
      emptyContent="아직 등록한 직원이 없어요"
    />
  </div>;
}

function ShiftButton({ row, label, prefix, pastLabel, clock, selected, onEdit }: {
  row: StaffSchedule; label: string; prefix?: string; pastLabel: string; clock: StaffClock; selected: boolean;
  onEdit: (row: StaffSchedule, from: HTMLElement) => void;
}) {
  const pastId = useId();
  const { time, rest } = shiftLabels(row);
  const ended = row.kind === 'work' && (row.date < clock.date || row.date === clock.date && row.end !== null && row.end <= clock.time);
  return (
    <button type="button" className="staff-shift" data-kind={row.kind} data-schedule-id={row.scheduleId} data-ended={ended || undefined} aria-pressed={selected}
      onClick={event => onEdit(row, event.currentTarget)} aria-label={label} aria-describedby={ended ? pastId : undefined}>
      {prefix}
      {row.kind === 'off' ? time : <span className="staff-shift__time">{time}</span>}
      {rest && <span className="staff-shift__rest">{rest}</span>}
      {ended && <span id={pastId} className="ui-sr-only">{pastLabel}</span>}
    </button>
  );
}

function ScheduleGrid({ model, dates, mode, orientation, clock, selectedId, onEdit }: { model: StaffScheduleModel; dates: string[]; mode: PeriodMode; orientation: 'employee' | 'date'; clock: StaffClock; selectedId?: string; onEdit: (row: StaffSchedule, from: HTMLElement) => void }) {
  const dateLabel = useDateLabel();
  const { t } = useBundle(staffWarnings);
  const pastLabel = t('staffSchedule.pastShift');
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstColumnRef = useRef<HTMLTableCellElement>(null);
  const todayRef = useRef<HTMLTableCellElement>(null);
  const hasRows = model.rows.length > 0;
  const showToday = mode === 'month' && orientation === 'employee' && dates.includes(clock.date);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const firstColumn = firstColumnRef.current;
    const today = todayRef.current;
    if (!(showToday && hasRows && scroll && firstColumn && today)) return;
    // Today's column starts right after the fixed name column.
    const fixed = firstColumn.offsetWidth;
    const target = Math.max(0, today.offsetLeft - fixed);
    scroll.scrollLeft = target;
    // When the scroll limit stops short of the target, a date can sit half behind the fixed column.
    // Step back to the edge of the column that is cut, so every date header that shows is whole.
    const reached = scroll.scrollLeft;
    if (reached < target) {
      const edges = Array.from(scroll.querySelectorAll<HTMLElement>('thead th:not(:first-child)'), head => head.offsetLeft - fixed);
      const cut = edges.filter(edge => edge < reached).at(-1);
      if (cut !== undefined && cut >= 0) scroll.scrollLeft = cut;
    }
  }, [showToday, hasRows]);
  if (!hasRows) return <p className="staff-empty">등록된 근무 일정이 없어요</p>;
  const cell = (person: Staff, date: string) => <td key={`${person.staffId}-${date}`} data-today={date === clock.date || undefined}>
    {model.rows.filter(row => row.staffId === person.staffId && row.date === date).map(row =>
      <ShiftButton key={row.scheduleId} row={row} label={`${person.name} ${dateLabel(date)} ${rowText(row)} 고치기`} pastLabel={pastLabel} clock={clock} selected={row.scheduleId === selectedId} onEdit={onEdit} />)}
  </td>;
  const mobile = <div className="staff-mobile-list">{dates.map(day => <section key={day}>
    <h3>{dateLabel(day)}</h3>
    {model.rows.filter(row => row.date === day).map(row => {
      const name = model.staff.find(person => person.staffId === row.staffId)?.name;
      return <ShiftButton key={row.scheduleId} row={row} label={`${name ?? ''} · ${rowText(row)}`} prefix={name ? `${name} · ` : undefined}
        pastLabel={pastLabel} clock={clock} selected={row.scheduleId === selectedId} onEdit={onEdit} />;
    })}
  </section>)}</div>;
  return <>{mobile}
    <div className="staff-grid-scroll" ref={scrollRef} data-orientation={orientation} data-period={mode}>
      <Table className="staff-grid" aria-label={mode === 'month' ? '월간 근무표' : '주간 근무표'}>
        <thead><tr>
          <th scope="col" ref={firstColumnRef}>{orientation === 'employee' ? '직원' : '날짜'}</th>
          {orientation === 'employee' ? dates.map(day => (
            <th scope="col" key={day} ref={day === clock.date ? todayRef : undefined} data-today={day === clock.date || undefined} aria-current={day === clock.date ? 'date' : undefined}>{dateLabel(day)}</th>
          )) : model.staff.map(person => <th scope="col" key={person.staffId}>{person.name}</th>)}
        </tr></thead>
        <tbody>
          {orientation === 'employee' ? model.staff.map(person => (
            <tr key={person.staffId}><th scope="row">{person.name}</th>{dates.map(day => cell(person, day))}</tr>
          )) : dates.map(day => (
            <tr key={day}><th scope="row" data-today={day === clock.date || undefined} aria-current={day === clock.date ? 'date' : undefined}>{dateLabel(day)}</th>{model.staff.map(person => cell(person, day))}</tr>
          ))}
        </tbody>
      </Table>
    </div>
  </>;
}
function History({ changes, staff, real }: { changes: StaffScheduleModel['changes']; staff: readonly Staff[]; real: boolean }) {
  const t = useI18n();
  const dateLabel = useDateLabel();
  const timestamp = (at: string) => {
    if (!real) return t.format.dateTime(at);
    const { date, time } = staffLocalTimestamp(at);
    return t.format.dateTime(`${date}T${time}`);
  };
  // InlineEmpty carries the state; the clock (◷) is the waiting icon only and does not belong to a history list.
  if (!changes.length) return <div className="staff-history-empty">
    <InlineEmpty title="아직 근무 변경 이력이 없어요" description="근무를 고치면 여기에 남아요" />
  </div>;
  return <Table className="staff-history"><thead><tr><th>변경 시각</th><th>변경 내용</th></tr></thead><tbody>{[...changes].reverse().map(change => <tr key={change.changeId}><td>{timestamp(change.at)}</td><td>{change.operation === 'create' ? '추가' : change.operation === 'delete' ? '지우기' : '고치기'} · {historyText(change.before, staff, dateLabel)}{change.before && change.after ? ' → ' : ''}{historyText(change.after, staff, dateLabel)}</td></tr>)}</tbody></Table>;
}
function historyText(value: unknown, staff: readonly Staff[], dateLabel: DateLabel): string {
  if (!value || typeof value !== 'object') return '';
  const item = value as { staffId?: string; name?: string; date?: string; kind?: string; start?: string; end?: string; breakMinutes?: number };
  const name = item.name ?? staff.find(person => person.staffId === item.staffId)?.name ?? '';
  const time = item.kind === 'off' ? '직원 휴무' : item.start && item.end ? `${item.start}~${item.end} · 휴게 ${item.breakMinutes ?? 0}분` : '';
  return [name, item.date ? dateLabel(item.date) : '', time].filter(Boolean).join(' · ');
}
const editorTitle = (editor: Editor) => editor.kind === 'staff' ? editor.person ? '직원 고치기' : '직원 추가하기' : editor.kind === 'schedule' ? editor.row ? '근무 고치기' : editor.off ? '휴무 등록하기' : '근무 추가하기' : editor.kind === 'handoff' ? '교대 시각 고치기' : editor.kind === 'deleteStaff' ? '직원 지우기' : '근무 지우기';
/** Where focus goes when the panel closes: the pressed row when there is one, otherwise whatever opened it. */
const editorFocusKey = (editor: Editor) => editor.kind === 'schedule' && editor.row ? `shift:${editor.row.scheduleId}` : editor.kind === 'deleteSchedule' ? `shift:${editor.row.scheduleId}`
  : (editor.kind === 'staff' || editor.kind === 'deleteStaff') && editor.person ? `person:${editor.person.staffId}` : 'opener';
/** The add/edit/delete form of the right DetailSidePanel (D-326 Q11). Fields, validation and messages are the ones the inline form had. */
function EditorForm({ editor, model, date, today, host, firstFieldRef, onClose }: { editor: Editor; model: StaffScheduleModel | null; date: string; today: string; host: WidgetHost; firstFieldRef: { current: HTMLElement | null }; onClose: () => void }) {
  const submit = useStaffCalendarCommand();
  const store = useWidgetDataStore();
  const data = useBundle(dataBundle);
  const dateLabel = useDateLabel();
  const person = editor.kind === 'staff' ? editor.person : undefined;
  const row = editor.kind === 'schedule' ? editor.row : undefined;
  const prefill = 'prefill' in editor ? editor.prefill : undefined;
  const [name, setName] = useState(prefill?.name ?? person?.name ?? '');
  const [staffId, setStaffId] = useState(row?.staffId ?? prefill?.staffId ?? model?.staff[0]?.staffId ?? '');
  const [workDate, setWorkDate] = useState(row?.date ?? prefill?.date ?? date);
  const [kind, setKind] = useState<'work' | 'off'>(row?.kind ?? (editor.kind === 'schedule' && editor.off ? 'off' : 'work'));
  const [start, setStart] = useState(prefill?.start ?? row?.start ?? '08:00');
  const [end, setEnd] = useState(prefill?.end ?? row?.end ?? '17:30');
  const [breakMinutes, setBreak] = useState<number | null>(prefill?.breakMinutes ?? row?.breakMinutes ?? 0);
  const [handoff, setHandoff] = useState(editor.kind === 'handoff' ? editor.from : '');
  const [error, setError] = useState<string>();
  /** Rows the handler said this shift runs into (GD-2): shown at the time fields, one of them can be replaced. */
  const [overlap, setOverlap] = useState<readonly ShiftConflict[] | null>(null);
  const [requestKey] = useState(requestId);
  const formId = useId();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const title = editorTitle(editor);
  const form = useRef<HTMLFormElement>(null);
  // Replacing the form can unmount its focused control while the panel stays open.
  useLayoutEffect(() => {
    firstFieldRef.current = form.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select') ?? form.current;
    if (document.activeElement === document.body) firstFieldRef.current?.focus({ preventScroll: true });
    return () => { firstFieldRef.current = null; };
  }, [firstFieldRef]);
  const save = (replaceId?: string) => {
    if (pending.current) return;
    setOverlap(null);
    if (editor.kind === 'staff' && !name.trim()) { setError('직원 이름을 넣어 주세요'); return; }
    if (editor.kind === 'schedule') {
      const invalid = validateSchedule(kind, start, end, breakMinutes);
      if (invalid) { setError(invalid); return; }
      if (!staffId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) { setError('직원과 날짜를 선택해 주세요'); return; }
    }
    if (editor.kind === 'handoff' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(handoff)) { setError('교대 시각을 확인해 주세요'); return; }
    const tables = store.getSnapshot().tables;
    const personAtOpen = editor.kind === 'deleteStaff' ? editor.person : person;
    const shiftAtOpen = editor.kind === 'deleteSchedule' ? editor.row : row;
    if ((personAtOpen?.revision !== undefined && tables.staff.find(person => person.staffId === personAtOpen.staffId)?.revision !== personAtOpen.revision)
      || (shiftAtOpen?.revision !== undefined && tables.staffSchedule.find(shift => shift.scheduleId === shiftAtOpen.scheduleId)?.revision !== shiftAtOpen.revision)
      || ('shiftRevision' in editor && editor.shiftRevision !== undefined && editor.shiftRevision !== tables.staffShiftRevision)) {
      setError('그사이 근무표가 바뀌었어요. 내용을 다시 열어 확인해 주세요');
      return;
    }
    pending.current = true;
    host.supersedeSuccessNotice?.();
    setSaving(true);
    const command = editor.kind === 'staff' ? person ? { type: 'staff.update' as const, staffId: person.staffId, name: name.trim() } : { type: 'staff.create' as const, name: name.trim(), idempotencyKey: requestKey }
      : editor.kind === 'schedule' ? { type: 'staff.saveSchedule' as const, ...(row || replaceId ? { scheduleId: row?.scheduleId ?? replaceId } : { idempotencyKey: requestKey }), staffId, date: workDate, kind, ...(kind === 'work' ? { start, end, breakMinutes: breakMinutes! } : {}) }
      : editor.kind === 'handoff' ? { type: 'staff.moveHandoff' as const, date: today, fromTime: editor.from, toTime: handoff, idempotencyKey: requestKey }
      : editor.kind === 'deleteStaff' ? { type: 'staff.delete' as const, staffId: editor.person.staffId, cascadeSchedules: true as const, idempotencyKey: requestKey }
      : { type: 'staff.deleteSchedule' as const, scheduleId: editor.row.scheduleId, idempotencyKey: requestKey };
    submit(command, result => {
      pending.current = false;
      if (result.ok) {
        if (result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, ...(result.params ? { params: result.params } : {}), ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
        if (form.current) onClose();
        return;
      }
      if (!form.current) return;
      setSaving(false);
      if (result.reason === 'STAFF_SHIFT_OVERLAP') { setError(undefined); setOverlap(conflictsOf(result.details)); return; }
      const line = failureLineKey(result.messageKey);
      setError(result.reason === 'STALE_REVISION' ? '그사이 근무표가 바뀌었어요. 내용을 다시 열어 확인해 주세요' : result.reason && errors[result.reason] || !line ? errorMessage(result.reason) : data.t(line as never));
    });
  };
  const touch = <T,>(set: (value: T) => void) => (value: T) => { set(value); setOverlap(null); };
  const overlapText = overlap ? kind === 'off' && overlap.some(item => item.kind === 'work') ? '이날 근무가 있어요' : errorMessage('STAFF_SHIFT_OVERLAP') : undefined;
  /** Only a new row can replace the one it runs into; editing a row keeps its own identity. */
  const replaceable = !row && overlap?.length === 1 ? overlap[0]! : null;
  return <form id={formId} ref={form} className="staff-editor" aria-label={title} tabIndex={-1} onSubmit={event => { event.preventDefault(); save(); }}>
    {editor.kind === 'staff' && <TextField label="직원 이름" value={name} onValueChange={value => { setName(value); setError(undefined); }} error={error} />}
    {editor.kind === 'schedule' && <>
      <label className="staff-field">직원<select className="ui-text-input" value={staffId} onChange={event => touch(setStaffId)(event.currentTarget.value)}>{model?.staff.map(p => <option key={p.staffId} value={p.staffId}>{p.name}</option>)}</select></label>
      <DateField label="날짜" value={workDate} today={today} onValueChange={next => { if (next) touch(setWorkDate)(next); }} />
      <div><SegmentedControl label="근무 종류" value={kind} onChange={touch(setKind)} options={[{ value: 'work', label: '근무' }, { value: 'off', label: '직원 휴무' }]} /></div>
      {kind === 'work' && <><div className="staff-editor__times"><TimeField label="출근 시각" value={start} onValueChange={next => touch(setStart)(next ?? "")} step={1} native /><TimeField label="퇴근 시각" value={end} onValueChange={next => touch(setEnd)(next ?? "")} step={1} native error={overlapText} /></div><NumberField label="휴게 시간" value={breakMinutes} onValueChange={setBreak} min={0} step={1} unit="분" /></>}
      {kind === 'off' && overlapText && <p role="alert" className="staff-error">{overlapText}</p>}
      {overlap && <ul className="staff-overlap" aria-label="겹치는 근무">{overlap.map(item => <li key={item.scheduleId}>{item.kind === 'off' ? '직원 휴무' : `${item.start}~${item.end} 근무`}</li>)}</ul>}
      {replaceable && <ActionButton variant="secondary" disabled={saving} onClick={() => save(replaceable.scheduleId)}>{replaceable.kind === 'off' ? '겹치는 휴무를 이 내용으로 바꾸기' : kind === 'off' ? '겹치는 근무를 휴무로 바꾸기' : '겹치는 근무를 이 시간으로 바꾸기'}</ActionButton>}
      {error && <p role="alert" className="staff-error">{error}</p>}
    </>}
    {editor.kind === 'handoff' && <><p>{editor.from} 교대에 연결된 근무를 함께 바꿔요</p><TextField label="교대 시각" value={handoff} onValueChange={setHandoff} error={error} /></>}
    {editor.kind === 'deleteStaff' && <><p>{editor.person.name}의 근무 일정도 함께 지워요. 지운 뒤 되돌릴 수 있어요.</p>{error && <p role="alert">{error}</p>}</>}
    {editor.kind === 'deleteSchedule' && <><p>{dateLabel(editor.row.date)} {rowText(editor.row)} 일정을 지워요. 지운 뒤 되돌릴 수 있어요.</p>{error && <p role="alert">{error}</p>}</>}
    {editor.kind === 'deleteStaff' || editor.kind === 'deleteSchedule'
      ? <div className="staff-editor__actions"><ActionButton variant="secondary" onClick={onClose} disabled={saving}>취소</ActionButton>
          <ActionButton type="submit" variant="destructive" loading={saving}>{editor.kind === 'deleteStaff' ? '직원 지우기' : '지우기'}</ActionButton></div>
      : <DetailFooterContent><div className="detail-footer-actions"><ActionButton type="submit" form={formId} loading={saving}>저장하기</ActionButton></div></DetailFooterContent>}
  </form>;
}

export const staffScheduleWidget: WidgetModule = { id: 'staff-schedule', Panel: StaffPanel, Detail: StaffDetail, useSummary: useStaffSummary };

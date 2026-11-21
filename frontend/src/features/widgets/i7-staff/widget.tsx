import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useStaffSchedule, useWidgetDataStore } from '../../../data/react';
import { TODAY, type Staff, type StaffSchedule, type StaffScheduleModel } from '../../../data/widget-data';
import type { ShiftConflict } from '../../../data/iteration7/staff';
import { useI18n } from '../../../i18n';
import { ActionButton, DataGrid, DateField, DateStepper, DetailSidePanel, DetailTabs, IconButton, InlineEmpty, MetricFit, NumberField, PanelState, SegmentedControl, Table, TextField, type DataGridHandle, type GridColumn, type GridFocus } from '../../../ui';
import { daysInPeriod, periodFor, shiftPeriod, validateSchedule, type PeriodMode } from './model';
import { FitProbe } from '../mgmt-money/fit';
import { PanelRemainder } from './panel-remainder';
import { restoreGrid } from '../mgmt-customers/workspace';
import { staffDetailEntry } from '../../assistant/domains/calendar-staff';
import './staff.css';

let sequence = 0;
const key = () => `staff-ui:${++sequence}`;
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
function useDateLabel(): DateLabel {
  const { format } = useI18n();
  return date => format.date(date, 'short');
}
const errors: Readonly<Record<string, string>> = { NAME_REQUIRED: '직원 이름을 넣어 주세요', INVALID_SHIFT: '퇴근 시각은 출근 시각보다 뒤여야 해요', BREAK_TOO_LONG: '휴게 시간은 근무 시간보다 짧아야 해요', STAFF_SHIFT_OVERLAP: '같은 직원의 근무 시간이 겹쳐요' };
const errorMessage = (reason?: string) => errors[reason ?? ''] ?? '저장하지 못했어요. 다시 시도해 주세요';

type StaffView = ReturnType<typeof useStaffSchedule>;
function State({ view, host, compact = false, detail = false, onAdd }: { view: StaffView; host: WidgetHost; compact?: boolean; detail?: boolean; onAdd?: () => void }) {
  if (view.status === 'ready') return null;
  // In the detail window the retry is a plain default button (48); the dashboard card keeps the kit's panel action.
  if (view.status === 'error' && detail) return <PanelState tone="error" message="근무표를 불러오지 못했어요"><div className="staff-retry"><ActionButton variant="secondary" onClick={() => host.resetPreview()}>다시 시도하기</ActionButton></div></PanelState>;
  if (view.status === 'error') return <PanelState tone="error" message="근무표를 불러오지 못했어요" shortMessage={compact ? '불러오지 못했어요' : undefined} action={{ label: '다시 시도하기', widgetName: '직원 스케줄표', onPress: () => host.resetPreview() }} />;
  return <div className="staff-empty"><p>아직 등록한 직원이 없어요</p><ActionButton variant="secondary" onClick={() => { host.resetPreview(); if (onAdd) onAdd(); else host.openDetail({ featureId: 'staff-schedule', focus: 'action' }); }}>직원 추가하기</ActionButton></div>;
}

export function StaffPanel(props: WidgetPanelProps) {
  const period = periodFor(TODAY, 'week');
  const view = useStaffSchedule(period);
  const dateLabel = useDateLabel();
  if (view.status !== 'ready') return <State view={view} host={props.host} compact={props.height === 1 && props.width <= 2} />;
  const m = view.model;
  const rows = m.rows.filter(row => row.date === TODAY);
  const names = new Map(m.staff.map(person => [person.staffId, person.name]));
  const hourly = (hour: number) => m.hourly.find(item => item.date === TODAY && item.hour === hour)?.staffCount ?? 0;
  const wide = props.width >= 3 && props.height >= 2;
  const compact = props.width === 1 && props.height === 1;
  const metric = <div className="staff-primary"><div data-slot="staff-schedule.metric.value"><MetricFit value={String(m.today.workingCount)} unit="명" longest="999" stacked={false} /></div><p className="staff-label">오늘 근무</p></div>;
  const valueRow = (name: string, value: React.ReactNode, className = '') => <div className={`staff-value-row ${className}`} key={name}><span>{name}</span><strong>{value}</strong></div>;
  return <div className="staff-panel" data-width={props.width} data-height={props.height} lang="ko">
    <div className="staff-metrics">{metric}{props.width === 2 && props.height >= 2 && m.today.nextHandoffAt && <div className="staff-primary"><MetricFit value={m.today.nextHandoffAt} stacked={false} /><p className="staff-label">교대</p></div>}</div>
    {!compact && (props.height === 1 ? <div className="staff-panel-list">
      {valueRow('오전·낮', `${hourly(14)}명`)}{valueRow('오후', `${hourly(18)}명`)}
      {props.width >= 3 && <>{valueRow('직원 휴무', `${m.today.offCount}명`, 'staff-extra-row')}{m.today.nextHandoffAt && valueRow('교대', m.today.nextHandoffAt, 'staff-extra-row')}</>}
    </div> : wide ? <MiniGrid model={m} dateLabel={dateLabel} /> : <div className="staff-panel-list">
      {rows.slice(0, props.height === 2 && props.width === 2 ? 4 : 5).map(row => <div className="staff-value-row staff-person-row" key={row.scheduleId} aria-label={`${names.get(row.staffId)} ${rowText(row)}`}><span>{names.get(row.staffId)}</span><strong>{row.kind === 'off' ? <span className="staff-off">직원 휴무</span> : `${row.start}~${row.end}`}</strong></div>)}
      {props.width === 1 && <PanelRemainder total={rows.length} rowSelector=".staff-person-row" unit="명" />}
      {props.width === 2 && <p className="staff-week-total">주간 총 {m.rows.filter(row => row.kind === 'work').length}건 · 휴무 {m.rows.filter(row => row.kind === 'off').length}건</p>}
      {props.width === 2 && props.height >= 3 && m.changes.at(-1) && <p className="staff-recent">최근 변경 · {historyText(m.changes.at(-1)!.after ?? m.changes.at(-1)!.before, m.staff, dateLabel)}</p>}
    </div>)}
    <FitProbe order={[{ selector: '.staff-recent' }, { selector: '.staff-week-total' }, { selector: '.staff-extra-row', last: true }, { selector: '.staff-person-row', last: true }, { selector: '.staff-mini tbody tr', last: true }]} deps={[props.width, props.height, m.rows.length, m.today.workingCount]} />
  </div>;
}
function MiniGrid({ model, dateLabel }: { model: StaffScheduleModel; dateLabel: DateLabel }) {
  const dates = daysInPeriod(model.period.start, model.period.end).slice(0, 7);
  return <div className="staff-mini" aria-label="주간 근무표 미리보기"><table><thead><tr><th>직원</th>{dates.map((date, i) => <th key={date} className={i >= 5 ? 'staff-late-day' : undefined} data-today={date === TODAY || undefined}>{dateLabel(date)}</th>)}</tr></thead><tbody>{model.staff.map(person => <tr key={person.staffId}><th>{person.name}</th>{dates.map((date, i) => <td key={date} className={i >= 5 ? 'staff-late-day' : undefined}>{model.rows.filter(row => row.staffId === person.staffId && row.date === date).map(row => <span data-kind={row.kind} aria-label={rowText(row)} key={row.scheduleId}>{row.kind === 'off' ? '직원 휴무' : `${row.start}~${row.end}`}</span>)}</td>)}</tr>)}</tbody></table></div>;
}

export function useStaffSummary() {
  const view = useStaffSchedule(periodFor(TODAY, 'week'));
  return view.status === 'ready' ? `오늘 근무 ${view.model.today.workingCount}명${view.model.today.nextHandoffAt ? ` · ${view.model.today.nextHandoffAt} 교대` : ''}` : view.status === 'error' ? '근무표를 불러오지 못했어요' : '아직 등록한 직원이 없어요';
}

const conflictsOf = (details: Readonly<Record<string, unknown>> | undefined): readonly ShiftConflict[] => Array.isArray(details?.conflicts) ? details.conflicts as ShiftConflict[] : [];
type StaffPrefill = ReturnType<typeof staffDetailEntry>['prefill'];
type Editor = { kind: 'staff'; person?: Staff; prefill?: StaffPrefill } | { kind: 'schedule'; row?: StaffSchedule; off?: boolean; prefill?: StaffPrefill } | { kind: 'handoff'; from: string } | { kind: 'deleteStaff'; person: Staff } | { kind: 'deleteSchedule'; row: StaffSchedule };
export function StaffDetail({ host, detailRef }: WidgetDetailProps) {
  const store = useWidgetDataStore();
  const [entry] = useState(() => staffDetailEntry(detailRef, store.getSnapshot()));
  const [tab, setTab] = useState<'week' | 'month' | 'staff' | 'history'>(entry.tab);
  const [orientation, setOrientation] = useState<'employee' | 'date'>(entry.orientation);
  const [date, setDate] = useState(entry.date);
  const [editor, setEditor] = useState<Editor | null>(() => entry.action === 'schedule' ? { kind: 'schedule', row: entry.row, prefill: entry.prefill }
    : entry.action === 'staff' ? { kind: 'staff', person: entry.person, prefill: entry.prefill } : null);
  const dateLabel = useDateLabel();
  const mode: PeriodMode = tab === 'month' ? 'month' : 'week';
  const period = periodFor(date, mode);
  const view = useStaffSchedule(period);
  const model = view.status === 'ready' ? view.model : null;
  const detail = useRef<HTMLDivElement>(null);
  const routedShift = entry.action ? undefined : entry.row?.scheduleId;
  useLayoutEffect(() => {
    if (!routedShift || view.status !== 'ready') return;
    const shift = detail.current?.querySelector(`button[data-schedule-id="${CSS.escape(routedShift)}"]`);
    if (shift instanceof HTMLButtonElement) shift.focus();
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
    <DetailTabs value={tab} onValueChange={changeTab} label="직원 스케줄표 보기" tabs={[{ value: 'week', label: '주간 근무표' }, { value: 'month', label: '월간 근무표' }, { value: 'staff', label: '직원 목록' }, { value: 'history', label: '근무 변경 이력' }]} />
    {view.status === 'error' ? <State view={view} host={host} detail /> : <>
      {tab !== 'history' ? <div className="staff-toolbar">
        {(tab === 'week' || tab === 'month') && <div className="staff-toolbar__view"><SegmentedControl value={orientation} onChange={setOrientation} label="근무표 보기 방식" options={[{ value: 'employee', label: '직원별 보기' }, { value: 'date', label: '날짜별 보기' }]} /><DateStepper text={`${dateLabel(period.startDate)} ~ ${dateLabel(period.endDate)}`} onPrevious={() => setDate(shiftPeriod(date, mode, -1))} onNext={() => setDate(shiftPeriod(date, mode, 1))} /></div>}
        <div className="staff-toolbar__add">
          <ActionButton variant="secondary" onClick={event => openEditor({ kind: 'staff' }, event.currentTarget)}>직원 추가하기</ActionButton>
          {model?.staff.length ? <><ActionButton variant="secondary" onClick={event => openEditor({ kind: 'schedule' }, event.currentTarget)}>근무 추가하기</ActionButton><ActionButton variant="secondary" onClick={event => openEditor({ kind: 'schedule', off: true }, event.currentTarget)}>휴무 등록하기</ActionButton></> : null}
          {model?.today.nextHandoffAt ? <ActionButton variant="secondary" onClick={event => openEditor({ kind: 'handoff', from: model.today.nextHandoffAt! }, event.currentTarget)}>교대 시각 고치기</ActionButton> : null}
        </div>
      </div> : null}
      {tab === 'history' ? <History changes={model?.changes ?? []} staff={model?.staff ?? []} />
        : !model || !model.staff.length ? <div className="staff-empty"><p>아직 등록한 직원이 없어요</p></div>
        : tab === 'staff' ? <StaffList staff={model.staff} grid={grid} selectedId={editor?.kind === 'staff' || editor?.kind === 'deleteStaff' ? editor.person?.staffId ?? null : null} onEdit={person => openEditor({ kind: 'staff', person })} onClose={closeEditor} onDelete={person => openEditor({ kind: 'deleteStaff', person })} />
        : <ScheduleGrid model={model} dates={daysInPeriod(period.startDate, period.endDate)} mode={mode} orientation={orientation} onEdit={editShift} />}
      <DetailSidePanel open={!!editor} selectedRowId={editor ? JSON.stringify(editor) : null} title={panelTitle} onClose={closeEditor}
        returnFocusKey={editor ? editorFocusKey(editor) : ''} onRestoreFocus={restoreFocus} initialFocusRef={firstFieldRef} danger={danger}>
        {editor && <EditorForm editor={editor} model={model} date={date} host={host} firstFieldRef={firstFieldRef} onClose={closeEditor} />}
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

function ShiftContent({ row }: { row: StaffSchedule }) {
  const { time, rest } = shiftLabels(row);
  if (row.kind === 'off') return time;
  return <>
    <span className="staff-shift__time">{time}</span>
    {rest && <span className="staff-shift__rest">{rest}</span>}
  </>;
}

function ScheduleGrid({ model, dates, mode, orientation, onEdit }: { model: StaffScheduleModel; dates: string[]; mode: PeriodMode; orientation: 'employee' | 'date'; onEdit: (row: StaffSchedule, from: HTMLElement) => void }) {
  const dateLabel = useDateLabel();
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstColumnRef = useRef<HTMLTableCellElement>(null);
  const todayRef = useRef<HTMLTableCellElement>(null);
  const hasRows = model.rows.length > 0;
  const showToday = mode === 'month' && orientation === 'employee' && dates.includes(TODAY);
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
  const cell = (person: Staff, date: string) => <td key={`${person.staffId}-${date}`} data-today={date === TODAY || undefined}>
    {model.rows.filter(row => row.staffId === person.staffId && row.date === date).map(row => (
      <button type="button" className="staff-shift" data-kind={row.kind} data-schedule-id={row.scheduleId} key={row.scheduleId} onClick={event => onEdit(row, event.currentTarget)} aria-label={`${person.name} ${dateLabel(date)} ${rowText(row)} 고치기`}>
        <ShiftContent row={row} />
      </button>
    ))}
  </td>;
  const mobile = <div className="staff-mobile-list">{dates.map(day => <section key={day}>
    <h3>{dateLabel(day)}</h3>
    {model.rows.filter(row => row.date === day).map(row => {
      const name = model.staff.find(person => person.staffId === row.staffId)?.name;
      return <button type="button" className="staff-shift" data-kind={row.kind} data-schedule-id={row.scheduleId} key={row.scheduleId} onClick={event => onEdit(row, event.currentTarget)} aria-label={`${name ?? ''} · ${rowText(row)}`}>
        {name} · <ShiftContent row={row} />
      </button>;
    })}
  </section>)}</div>;
  return <>{mobile}
    <div className="staff-grid-scroll" ref={scrollRef} data-orientation={orientation}>
      <Table className="staff-grid" aria-label={mode === 'month' ? '월간 근무표' : '주간 근무표'}>
        <thead><tr>
          <th scope="col" ref={firstColumnRef}>{orientation === 'employee' ? '직원' : '날짜'}</th>
          {orientation === 'employee' ? dates.map(day => (
            <th scope="col" key={day} ref={day === TODAY ? todayRef : undefined} data-today={day === TODAY || undefined} aria-current={day === TODAY ? 'date' : undefined}>{dateLabel(day)}</th>
          )) : model.staff.map(person => <th scope="col" key={person.staffId}>{person.name}</th>)}
        </tr></thead>
        <tbody>
          {orientation === 'employee' ? model.staff.map(person => (
            <tr key={person.staffId}><th scope="row">{person.name}</th>{dates.map(day => cell(person, day))}</tr>
          )) : dates.map(day => (
            <tr key={day}><th scope="row" data-today={day === TODAY || undefined} aria-current={day === TODAY ? 'date' : undefined}>{dateLabel(day)}</th>{model.staff.map(person => cell(person, day))}</tr>
          ))}
        </tbody>
      </Table>
    </div>
  </>;
}
function History({ changes, staff }: { changes: StaffScheduleModel['changes']; staff: readonly Staff[] }) {
  const t = useI18n();
  const dateLabel = useDateLabel();
  // InlineEmpty carries the state; the clock (◷) is the waiting icon only and does not belong to a history list.
  if (!changes.length) return <div className="staff-history-empty">
    <InlineEmpty title="아직 근무 변경 이력이 없어요" description="근무를 고치면 여기에 남아요" />
  </div>;
  return <Table className="staff-history"><thead><tr><th>변경 시각</th><th>변경 내용</th></tr></thead><tbody>{[...changes].reverse().map(change => <tr key={change.changeId}><td>{t.format.dateTime(change.at)}</td><td>{change.operation === 'create' ? '추가' : change.operation === 'delete' ? '지우기' : '고치기'} · {historyText(change.before, staff, dateLabel)}{change.before && change.after ? ' → ' : ''}{historyText(change.after, staff, dateLabel)}</td></tr>)}</tbody></Table>;
}
function historyText(value: unknown, staff: readonly Staff[], dateLabel: DateLabel): string {
  if (!value || typeof value !== 'object') return '';
  const item = value as { staffId?: string; name?: string; date?: string; kind?: string; start?: string; end?: string; breakMinutes?: number };
  const name = item.name ?? staff.find(person => person.staffId === item.staffId)?.name ?? '';
  const time = item.kind === 'off' ? '직원 휴무' : item.start && item.end ? `${item.start}~${item.end} · 휴게 ${item.breakMinutes ?? 0}분` : '';
  return [name, item.date ? dateLabel(item.date) : '', time].filter(Boolean).join(' · ');
}
const editorTitle = (editor: Editor) => editor.kind === 'staff' ? editor.person ? '직원 고치기' : '직원 추가하기' : editor.kind === 'schedule' ? editor.row ? '근무 고치기' : '근무 추가하기' : editor.kind === 'handoff' ? '교대 시각 고치기' : editor.kind === 'deleteStaff' ? '직원 지우기' : '근무 지우기';
/** Where focus goes when the panel closes: the pressed row when there is one, otherwise whatever opened it. */
const editorFocusKey = (editor: Editor) => editor.kind === 'schedule' && editor.row ? `shift:${editor.row.scheduleId}` : editor.kind === 'deleteSchedule' ? `shift:${editor.row.scheduleId}`
  : (editor.kind === 'staff' || editor.kind === 'deleteStaff') && editor.person ? `person:${editor.person.staffId}` : 'opener';
/** The add/edit/delete form of the right DetailSidePanel (D-326 Q11). Fields, validation and messages are the ones the inline form had. */
function EditorForm({ editor, model, date, host, firstFieldRef, onClose }: { editor: Editor; model: StaffScheduleModel | null; date: string; host: WidgetHost; firstFieldRef: { current: HTMLElement | null }; onClose: () => void }) {
  const dispatch = useDataDispatch();
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
  const [requestKey] = useState(key);
  const [saving, setSaving] = useState(false);
  const title = editorTitle(editor);
  const form = useRef<HTMLFormElement>(null);
  // Replacing the form can unmount its focused control while the panel stays open.
  useLayoutEffect(() => {
    firstFieldRef.current = form.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select') ?? form.current;
    if (document.activeElement === document.body) firstFieldRef.current?.focus({ preventScroll: true });
    return () => { firstFieldRef.current = null; };
  }, [firstFieldRef]);
  const save = (replaceId?: string) => {
    if (saving) return;
    setOverlap(null);
    if (editor.kind === 'staff' && !name.trim()) { setError('직원 이름을 넣어 주세요'); return; }
    if (editor.kind === 'schedule') {
      const invalid = validateSchedule(kind, start, end, breakMinutes);
      if (invalid) { setError(invalid); return; }
      if (!staffId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) { setError('직원과 날짜를 선택해 주세요'); return; }
    }
    if (editor.kind === 'handoff' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(handoff)) { setError('교대 시각을 확인해 주세요'); return; }
    setSaving(true);
    const command = editor.kind === 'staff' ? person ? { type: 'staff.update' as const, staffId: person.staffId, name: name.trim() } : { type: 'staff.create' as const, name: name.trim(), idempotencyKey: requestKey }
      : editor.kind === 'schedule' ? { type: 'staff.saveSchedule' as const, ...(row || replaceId ? { scheduleId: row?.scheduleId ?? replaceId } : { idempotencyKey: requestKey }), staffId, date: workDate, kind, ...(kind === 'work' ? { start, end, breakMinutes: breakMinutes! } : {}) }
      : editor.kind === 'handoff' ? { type: 'staff.moveHandoff' as const, date: TODAY, fromTime: editor.from, toTime: handoff, idempotencyKey: requestKey }
      : editor.kind === 'deleteStaff' ? { type: 'staff.delete' as const, staffId: editor.person.staffId, cascadeSchedules: true as const, idempotencyKey: requestKey }
      : { type: 'staff.deleteSchedule' as const, scheduleId: editor.row.scheduleId, idempotencyKey: requestKey };
    const result = dispatch(command);
    setSaving(false);
    if (!result.ok) {
      if (result.reason === 'STAFF_SHIFT_OVERLAP') { setError(undefined); setOverlap(conflictsOf(result.details)); return; }
      setError(errorMessage(result.reason)); return;
    }
    if (result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, ...(result.params ? { params: result.params } : {}), ...(result.undoToken ? { undoToken: result.undoToken } : {}) });
    onClose();
  };
  const touch = <T,>(set: (value: T) => void) => (value: T) => { set(value); setOverlap(null); };
  const overlapText = overlap ? errorMessage('STAFF_SHIFT_OVERLAP') : undefined;
  /** Only a new row can replace the one it runs into; editing a row keeps its own identity. */
  const replaceable = !row && overlap?.length === 1 ? overlap[0]! : null;
  return <form ref={form} className="staff-editor" aria-label={title} tabIndex={-1} onSubmit={event => { event.preventDefault(); save(); }}>
    {editor.kind === 'staff' && <TextField label="직원 이름" value={name} onValueChange={value => { setName(value); setError(undefined); }} error={error} />}
    {editor.kind === 'schedule' && <>
      <label className="staff-field">직원<select className="ui-text-input" value={staffId} onChange={event => touch(setStaffId)(event.currentTarget.value)}>{model?.staff.map(p => <option key={p.staffId} value={p.staffId}>{p.name}</option>)}</select></label>
      <DateField label="날짜" value={workDate} today={TODAY} onValueChange={next => { if (next) touch(setWorkDate)(next); }} />
      <div><SegmentedControl label="근무 종류" value={kind} onChange={touch(setKind)} options={[{ value: 'work', label: '근무' }, { value: 'off', label: '직원 휴무' }]} /></div>
      {kind === 'work' && <><div className="staff-editor__times"><TextField label="출근 시각" value={start} onValueChange={touch(setStart)} placeholder="09:00" /><TextField label="퇴근 시각" value={end} onValueChange={touch(setEnd)} placeholder="18:00" error={overlapText} /></div><NumberField label="휴게 시간" value={breakMinutes} onValueChange={setBreak} min={0} step={1} unit="분" /></>}
      {kind === 'off' && overlapText && <p role="alert" className="staff-error">{overlapText}</p>}
      {overlap && <ul className="staff-overlap" aria-label="겹치는 근무">{overlap.map(item => <li key={item.scheduleId}>{item.kind === 'off' ? '직원 휴무' : `${item.start}~${item.end} 근무`}</li>)}</ul>}
      {replaceable && <ActionButton variant="secondary" disabled={saving} onClick={() => save(replaceable.scheduleId)}>{replaceable.kind === 'off' ? '겹치는 휴무를 이 내용으로 바꾸기' : kind === 'off' ? '겹치는 근무를 휴무로 바꾸기' : '겹치는 근무를 이 시간으로 바꾸기'}</ActionButton>}
      {error && <p role="alert" className="staff-error">{error}</p>}
    </>}
    {editor.kind === 'handoff' && <><p>{editor.from} 교대에 연결된 근무를 함께 바꿔요</p><TextField label="교대 시각" value={handoff} onValueChange={setHandoff} error={error} /></>}
    {editor.kind === 'deleteStaff' && <><p>{editor.person.name}의 근무 일정도 함께 지워요. 지운 뒤 되돌릴 수 있어요.</p>{error && <p role="alert">{error}</p>}</>}
    {editor.kind === 'deleteSchedule' && <><p>{dateLabel(editor.row.date)} {rowText(editor.row)} 일정을 지워요. 지운 뒤 되돌릴 수 있어요.</p>{error && <p role="alert">{error}</p>}</>}
    <div className="staff-editor__actions"><ActionButton type="submit" loading={saving}>{editor.kind === 'deleteStaff' || editor.kind === 'deleteSchedule' ? '지우기' : '저장하기'}</ActionButton></div>
  </form>;
}

export const staffScheduleWidget: WidgetModule = { id: 'staff-schedule', Panel: StaffPanel, Detail: StaffDetail, useSummary: useStaffSummary };

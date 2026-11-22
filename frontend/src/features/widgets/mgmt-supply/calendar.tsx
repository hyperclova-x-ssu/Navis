import { SupplyDetailSession } from './detail-session';
/**
 * 캘린더 (F-35, SCR-14·30·31·33): today / week / month by panel size, a month·week·day detail with
 * source switches, the owner's own events and to-dos (add · edit · delete) and read-only automatic entries
 * that open their source detail (‘출처 열기’). Reads the calendar model only; writes calendar.* commands.
 */
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useBundle } from '../../../i18n';
import { Switch } from '@base-ui/react/switch';
import type { DetailRef, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDomainState, useRealPort, useRealRetry, useWidgetDataStore, useWidgetView } from '../../../data/react';
import type { DataCommand } from '../../../data/commands/types';
import { staffCalendarClock } from '../../../data/iteration7/staff/clock';
import { useStaffCalendarCommand } from '../../../data/reality/07/use-staff-calendar-command';
import type { CalendarEntry, CalendarModel } from '../../../data/widget-data';
import { selectCalendar, type CalendarCategory } from '../../../data/widget-data';
import { calendarDetailEntry } from '../../assistant/domains/calendar-staff';
import { ActionButton, CategoryMark, Checkbox, ChipChoice, DateField, DateStepper, Icon, InlineForm, MetricFit, SegmentedControl, TextField } from '../../../ui';
import { addIsoDays, Flash, notifyResult, stateTone, SupplyPanelState, useFit, useSupplyText, SupplySurface, useTextScale, useViewMemory, WarnLine, type SupplyText } from './shared';
import { CalendarExport } from './calendar.export';
import { CalendarNaverButton, CalendarNaverReview, CalendarNaverSent, useCalendarNaver } from './calendar.naver';
import { dateRangeWithWeekdays } from '../date-range';

const ID = 'calendar' as const;
const calendarKo = { 'supply.calendar.closure':'매장 휴무', 'supply.calendar.closureKind':'휴무 종류', 'supply.calendar.regularClosure':'정기 휴무', 'supply.calendar.temporaryClosure':'임시 휴무', 'supply.calendar.closureEnd':'휴무 종료일', 'supply.calendar.pickup':'예약 픽업', 'supply.calendar.pickups':'예약 픽업도 보기', 'supply.calendar.pickupSummary':'오늘 픽업 {n}건', 'supply.calendar.date':'날짜','supply.calendar.title':'일정 제목','supply.calendar.dateTime':'날짜와 시간','supply.calendar.memo':'일정 내용','supply.calendar.titleRequired':'일정 제목을 넣어 주세요', 'supply.calendar.category':'분류', 'supply.calendar.categories':'분류별로 보기', 'supply.calendar.store':'매장 운영', 'supply.calendar.stock':'발주·입고', 'supply.calendar.finance':'세금·행정', 'supply.calendar.none':'보이는 분류가 없어요. 분류를 켜 주세요', 'supply.calendar.reservations':'예약도 보기', 'supply.calendar.keepPast':'지난 기록으로 남기기', 'supply.calendar.saveAnyway':'그래도 저장하기', 'supply.calendar.leaveAsIs':'그대로 두기', 'supply.calendar.editName':'{title} 고치기', 'supply.calendar.deleteName':'{title} 지우기' } as const;
const calendarBundle = {
  id: 'widget.mgmt-supply.calendar-v5',
  ko: {
    ...calendarKo,
    'supply.calendar.confirmDelete': '일정을 지울까요?',
    'supply.calendar.confirmClosureDelete': '매장 휴무를 지울까요?',
    'supply.calendar.deleteClosure': '휴무 지우기',
    'supply.calendar.closureDraftsUnlinked': '연결된 공지 초안에서 휴무 연결이 끊겨요',
  },
  en: {
    'supply.calendar.deleteName': 'Delete {title}',
    'supply.calendar.leaveAsIs': 'Keep it',
    'supply.calendar.confirmDelete': 'Delete this event?',
    'supply.calendar.confirmClosureDelete': 'Delete this store closure?',
    'supply.calendar.deleteClosure': 'Delete closure',
    'supply.calendar.closureDraftsUnlinked': 'Linked notice drafts will lose their connection to this closure.',
  },
  'zh-Hans': {
    'supply.calendar.deleteName': '删除{title}',
    'supply.calendar.leaveAsIs': '保留',
    'supply.calendar.confirmDelete': '要删除这条日程吗？',
    'supply.calendar.confirmClosureDelete': '要删除这条门店休息日程吗？',
    'supply.calendar.deleteClosure': '删除休息日程',
    'supply.calendar.closureDraftsUnlinked': '相关通知草稿将解除与这条休息日程的关联。',
  },
  'zh-Hant': {
    'supply.calendar.deleteName': '刪除{title}',
    'supply.calendar.leaveAsIs': '保留',
    'supply.calendar.confirmDelete': '要刪除這筆行程嗎？',
    'supply.calendar.confirmClosureDelete': '要刪除這筆門市休息行程嗎？',
    'supply.calendar.deleteClosure': '刪除休息行程',
    'supply.calendar.closureDraftsUnlinked': '相關通知草稿將解除與這筆休息行程的連結。',
  },
} as const;
const categories = [{id:'store-operations',key:'supply.calendar.store',mark:'store'},{id:'purchasing',key:'supply.calendar.stock',mark:'stock'},{id:'tax-admin',key:'supply.calendar.finance',mark:'finance'}] as const;

export const entryTime = (x: SupplyText, e: CalendarEntry): string => (e.time ? x.format.time(e.time) : e.kind === 'todo' ? x.t('widget.calendar.todoMark') : x.t('widget.calendar.allDay'));
export const entryText = (x: SupplyText, e: CalendarEntry): string => `${entryTime(x, e)} ${x.text(e.title)}`;
/** ‘윤서진 · 08:00~16:30’: in a narrow card each part is its own line, elsewhere the dot is bound to its neighbours so it never stands alone at a line end. */
function TitleParts({ text, compact }: { text: string; compact: boolean }) {
  const parts = text.split(/\s·\s/);
  if (parts.length < 2) return <>{text}</>;
  if (!compact) return <>{parts.join('\u00a0·\u00a0')}</>;
  return <span className="ms-entry__parts">{parts.map((part, i) => <span key={i} className="ms-entry__part">{i > 0 ? <span className="ui-sr-only"> · </span> : null}{part}</span>)}</span>;
}
const countUnit = (x: SupplyText, count: number) => x.t('widget.calendar.countUnit', { count });

function weekDays(start: string): string[] { return Array.from({ length: 7 }, (_, i) => addIsoDays(start, i)); }
function gridDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addIsoDays(d, 1)) out.push(d);
  return out;
}
const dayNumber = (iso: string) => Number(iso.slice(8, 10));

/* ───────── Panel ───────── */

function CalendarKey({ x, label, count, sub, status, editing, shape }: { x: SupplyText; label: string; count: number; sub?: string; status?: string; editing: boolean; shape: string }) {
  const showS = !(editing && shape === 'Q');
  return <div className="ms-k">
    <div className="ms-k__value" data-slot={`${ID}.metric.value`}><Flash value={count}><MetricFit value={x.format.number(count)} unit={countUnit(x, count)} longest="99" stacked={false} /></Flash></div>
    <p className="ms-label" data-slot={`${ID}.metric.label`}>{label}</p>
    {showS && status ? <WarnLine slot={`${ID}.state.message`}>{status}</WarnLine> : showS && sub ? <p className="ms-sub" data-slot={`${ID}.metric.secondary`} data-drop={900}>{sub}</p> : null}
  </div>;
}

function EntryLines({ x, entries, withDate = false, hiddenRows, title, more = true }: { x: SupplyText; entries: readonly CalendarEntry[]; withDate?: boolean; hiddenRows: number; title?: string; /** the ‘외 n개’ line belongs to the last list of a panel (the fit guard shows one) */ more?: boolean }) {
  return <div className="ms-list" data-slot={`${ID}.list`}>
    {title ? <p className="ms-list__title" data-slot={`${ID}.list.title`} data-drop={150}>{title}</p> : null}
    <ul className="ms-rows">
      {entries.map((e, i) => <li key={e.id} className="ms-row" data-row="" data-drop={500 + i} data-row-id={e.id} data-slot={`${ID}.list.row`}>
        <span className="ms-row__lead"><Flash value={`${e.date}:${e.time ?? ''}`}>{withDate ? `${x.format.date(e.date, 'short')} ` : ''}{entryTime(x, e)}</Flash></span>
        <span className="ms-row__name"><CategoryMark category={e.categoryId === 'purchasing' ? 'stock' : e.categoryId === 'tax-admin' ? 'finance' : 'store'}><Flash value={x.text(e.title)}>{x.locale === 'ko' ? x.text(e.title).replace(/\u00a0· /g, '\u00a0·\u00a0') : x.text(e.title)}</Flash></CategoryMark></span>
      </li>)}
      {more ? <li className="ms-row ms-row--more" data-more="" hidden>{x.t('common.moreItems', { n: hiddenRows })}</li> : null}
    </ul>
  </div>;
}

function WeekStrip({ x, model, compact }: { x: SupplyText; model: CalendarModel; compact?: boolean }) {
  const days = weekDays(model.week.start);
  return <ol className="ms-week" data-compact={compact ? 'true' : undefined} aria-label={x.t('widget.calendar.thisWeek')} data-drop={200}>
    {days.map((d) => {
      const count = model.weekEntries.filter((e) => e.date === d).length;
      return <li key={d} className="ms-week__day" data-today={d === model.today ? 'true' : undefined} aria-current={d === model.today ? 'date' : undefined}>
        <span className="ui-sr-only">{x.t('widget.calendar.dayCellName', { date: x.format.date(d, 'long'), count })}</span>
        <span className="ms-week__weekday" aria-hidden="true">{x.format.weekday(d, 'short')}</span>
        <span className="ms-week__date" aria-hidden="true">{dayNumber(d)}</span>
        <span className="ms-week__count" aria-hidden="true">{count > 0 ? <><span className="ms-dot" />{x.format.number(count)}</> : null}</span>
      </li>;
    })}
  </ol>;
}

function MonthGrid({ x, model, detail = false }: { x: SupplyText; model: CalendarModel; detail?: boolean }) {
  const todayCell = useRef<HTMLTableCellElement>(null);
  useLayoutEffect(() => { if (detail) todayCell.current?.scrollIntoView?.({ block: 'nearest' }); }, [detail, model.month.month]);
  const days = gridDays(model.month.gridStart, model.month.gridEnd);
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => days.slice(i * 7, i * 7 + 7));
  const [year, month] = model.month.month.split('-').map(Number);
  const title = x.t('widget.calendar.monthTitle', { year: year!, month: month!, monthShort: x.tk(`format.month.short.${month}`) });
  return <table className="ms-month" data-detail={detail ? 'true' : undefined} aria-label={x.t('widget.calendar.tableName', { title })} data-drop={detail ? undefined : 200}>
    <caption className={detail ? 'ms-month__caption' : 'ui-sr-only'}>{title}</caption>
    <thead><tr>{weeks[0]!.map((d) => <th key={d} scope="col" abbr={x.format.weekday(d, 'long')}>{x.format.weekday(d, 'short')}</th>)}</tr></thead>
    <tbody>{weeks.map((week) => <tr key={week[0]}>{week.map((d) => {
      const entries = model.monthEntries.filter((e) => e.date === d);
      const inMonth = d.startsWith(model.month.month);
      return <td key={d} ref={d === model.today ? todayCell : undefined} data-in-month={String(inMonth)} data-today={d === model.today ? 'true' : undefined} aria-current={d === model.today ? 'date' : undefined}
        aria-label={x.t('widget.calendar.dayCellName', { date: x.format.date(d, 'long'), count: entries.length })}>
        <span className="ms-month__date" aria-hidden="true">{dayNumber(d)}{d === model.today ? <span className="ms-month__today">{x.t('widget.calendar.todayMark')}</span> : null}</span>
        {entries.length > 0 ? <span className="ms-month__count" aria-hidden="true">{entries.slice(0, 3).map((e) => <span key={e.id} className="ms-dot" data-source={e.source} />)}{x.format.number(entries.length)}</span> : null}
      </td>;
    })}</tr>)}</tbody>
  </table>;
}

function CalendarPanelContent({ condition, width, height, shape, editing, host }: WidgetPanelProps) {
  const view = useWidgetView(ID, condition);
  const http = useRealPort()?.state('staff').mode === 'http';
  const retry = useRealRetry('staff');
  const x = useSupplyText();
  const scale = useTextScale();
  const { ref, hiddenRows } = useFit<HTMLDivElement>([view, width, height, scale, x.locale, editing]);
  if (view.status !== 'ready') {
    const action = view.status === 'error' ? { label: x.t('common.retry'), run: http ? retry : () => host.resetPreview() }
      : view.actionKey ? { label: x.tk(view.actionKey), run: () => { host.resetPreview(); host.openDetail({ featureId: ID, view: 'add', focus: 'action' }); } } : null;
    return <div ref={ref} className="ms-panel" data-shape={shape} data-widget={ID} data-state={view.status}><SupplyPanelState featureId={ID} tone={stateTone(view.status)} shape={shape} message={x.tk(view.messageKey)} actionLabel={action?.label} onAction={action?.run} /></div>;
  }
  const m = view.model;
  // The partial state (‘일부 일정을 불러오지 못했어요’) takes the S line (SCR-30 선택적 상태 표시, DS 11.5).
  const status = view.notes?.[0] ? x.tk(view.notes[0].messageKey) : undefined;
  const date = x.format.date(m.today, 'long');
  const today = <CalendarKey x={x} label={x.t('widget.calendar.today')} count={m.todayCount} sub={date} status={status} editing={editing} shape={shape} />;
  if (shape === 'Q') return <div ref={ref} className="ms-panel" data-shape="Q" data-widget={ID}>{today}</div>;
  if (shape === 'W') return <div ref={ref} className="ms-panel" data-shape="W" data-widget={ID}>{today}<div className="ms-aside"><EntryLines x={x} entries={m.todayEntries.slice(0, width >= 3 ? width : 2)} hiddenRows={hiddenRows} /></div></div>;
  if (shape === 'T') return <div ref={ref} className="ms-panel" data-shape="T" data-widget={ID}>{today}<hr className="ms-rule" /><EntryLines x={x} title={x.t('widget.calendar.today')} entries={m.todayEntries.slice(0, 8)} hiddenRows={hiddenRows} /></div>;
  const month = width >= 3 && height >= 3;
  /** D-333: from 4 rows up the month card also lists the rest of this week's entries under today's (dated, the same rows the week card shows). */
  const rest = month && height >= 4 ? m.weekEntries.filter((e) => e.date !== m.today).slice(0, 8) : [];
  if (month) return <div ref={ref} className="ms-panel" data-shape={shape} data-widget={ID} data-view="month">{today}<div className="ms-chart"><MonthGrid x={x} model={m} /></div><div className="ms-aside"><EntryLines x={x} title={x.t('widget.calendar.today')} entries={m.todayEntries.slice(0, 8)} hiddenRows={hiddenRows} more={rest.length === 0} />{rest.length > 0 ? <EntryLines x={x} title={x.t('widget.calendar.thisWeek')} entries={rest} withDate hiddenRows={hiddenRows} /> : null}</div></div>;
  const week = <CalendarKey x={x} label={x.t('widget.calendar.thisWeek')} count={m.weekCount} sub={dateRangeWithWeekdays(x, m.week.start, m.week.end)} status={status} editing={editing} shape={shape} />;
  return <div ref={ref} className="ms-panel" data-shape={shape} data-widget={ID} data-view="week">{week}<div className="ms-chart"><WeekStrip x={x} model={m} compact={shape === 'S'} /></div><div className="ms-aside"><EntryLines x={x} entries={m.weekEntries.slice(0, 8)} withDate hiddenRows={hiddenRows} /></div></div>;
}

function useCalendarSummary({ condition }: { condition: WidgetPanelProps['condition'] }): string {
  const view = useWidgetView(ID, condition);
  const x = useSupplyText();
  if (view.status !== 'ready') return x.tk(view.messageKey);
  return x.t('widget.calendar.summary', { count: view.model.todayCount, date: x.format.date(view.model.today, 'long') });
}

/* ───────── Detail ───────── */

type Mode = 'month' | 'week' | 'day';
interface FormSeed {
  readonly kind: 'event' | 'todo';
  readonly entry: CalendarEntry | null;
  readonly date: string;
  readonly revision?: number;
  readonly prefill?: ReturnType<typeof calendarDetailEntry>['prefill'];
}
type CalendarConfirmation = { readonly dateIntent?: 'historical'; readonly confirmDuplicate?: true };

function normalizeTime(raw: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  return match ? `${match[1]!.padStart(2, '0')}:${match[2]}` : null;
}

function EntryForm({ seed, onClose, onSaved, host }: { seed: FormSeed; onClose: () => void; onSaved: (eventId: string | null, date: string) => void; host: WidgetDetailProps['host'] }) {
  const x = useSupplyText();
  const submit = useStaffCalendarCommand();
  const {t:ct} = useBundle(calendarBundle);
  const editing = seed.entry !== null;
  const data = useWidgetDataStore();
  const today = staffCalendarClock(data.getSnapshot().tables).date;
  const originalClosure = seed.entry ? data.getSnapshot().tables.calendarEvent.find(e => e.eventId === seed.entry!.sourceId)?.storeClosure : seed.prefill?.closure;
  const [closure, setClosure] = useState(!!originalClosure);
  const [closureKind, setClosureKind] = useState<'regular' | 'temporary'>(originalClosure?.kind ?? 'temporary');
  const [closureEnd, setClosureEnd] = useState(originalClosure?.endDate ?? seed.date);
  const [category,setCategory]=useState<CalendarCategory>(seed.entry?.categoryId ?? seed.prefill?.category ?? 'store-operations');
  const [kind, setKind] = useState(seed.entry?.kind ?? seed.kind);
  const [title, setTitle] = useState(editing ? x.text(seed.entry!.title) : seed.prefill?.title ?? '');
  const [date, setDate] = useState(seed.entry?.date ?? seed.date);
  const [time, setTime] = useState(seed.entry?.time ?? seed.prefill?.time ?? '');
  const [memo, setMemo] = useState(editing ? x.text(seed.entry!.memo) : seed.prefill?.memo ?? '');
  const [errors, setErrors] = useState<{ title?: string; time?: string; date?: string; form?: string }>({});
  /** The handler asked before a past date or a same-title event on the same day; the owner can say yes once. */
  const [confirmation, setConfirmation] = useState<{ kind: 'past' | 'duplicate'; form: string; accepted: CalendarConfirmation } | null>(null);
  const formKey = JSON.stringify([title, kind, date, time, category, memo, closure, closureKind, closureEnd]);
  const asked = confirmation?.form === formKey ? confirmation.kind : null;
  const [saving, setSaving] = useState(false);
  const pressed = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const save = (confirm: CalendarConfirmation = {}) => {
    if (saving || pressed.current) return;
    setConfirmation(null);
    const next: typeof errors = {};
    if (!title.trim()) next.title = ct('supply.calendar.titleRequired');
    const t = kind === 'event' && time.trim() ? normalizeTime(time) : null;
    if (kind === 'event' && time.trim() && !t) next.time = x.t('data.error.timeInvalid');
    setErrors(next);
    if (next.title || next.time) return;
    if (seed.revision !== undefined && data.getSnapshot().tables.calendarEvent.find(event => event.eventId === seed.entry?.sourceId)?.revision !== seed.revision) {
      setErrors({ form: x.tk('data.real.error.STALE_REVISION') });
      return;
    }
    pressed.current = true;
    setSaving(true);
    const storeClosure = closure && kind === 'event' && category === 'store-operations' ? { kind: closureKind, endDate: closureEnd } : null;
    const command: DataCommand = editing
      ? { type: 'calendar.updateEvent', eventId: seed.entry!.sourceId, title, date, time: kind === 'event' ? t : null, memo, categoryId:category, storeClosure, ...confirm }
      : kind === 'event' ? { type: 'calendar.addEvent', title, date, time: t, memo, categoryId:category, storeClosure, ...confirm } : { type: 'calendar.addTodo', title, date, memo, ...confirm };
    submit(command, result => {
      if (result.ok) {
        notifyResult(host, result, editing ? 'data.notice.calendarUpdated' : 'data.notice.calendarAdded');
        const value = result.value as { eventId?: string; resourceId?: string } | undefined;
        if (mounted.current) onSaved(value?.resourceId ?? value?.eventId ?? seed.entry?.sourceId ?? null, date);
        return;
      }
      if (!mounted.current) return;
      pressed.current = false;
      setSaving(false);
      const kind = result.reason === 'CALENDAR_PAST_DATE' ? 'past' : result.reason === 'CALENDAR_DUPLICATE' ? 'duplicate' : null;
      if (kind) setConfirmation({ kind, form: formKey, accepted: confirm });
      setErrors(result.reason === 'CALENDAR_PAST_DATE' ? { date: x.tk(result.messageKey) } : result.field === 'title' ? { title: x.tk(result.messageKey) } : result.field === 'time' ? { time: x.tk(result.messageKey) } : { form: x.tk(result.messageKey) });
    });
  };
  const heading = editing ? x.t('widget.calendar.form.edit') : kind === 'todo' ? x.t('common.addTodo') : x.t('common.addEvent');
  const answer = asked === 'past' ? <ActionButton variant="secondary" disabled={saving} onClick={() => save({ ...confirmation?.accepted, dateIntent: 'historical' })}>{ct('supply.calendar.keepPast')}</ActionButton>
    : asked === 'duplicate' ? <div className="ms-form-answer" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}><ActionButton variant="secondary" disabled={saving} onClick={() => save({ ...confirmation?.accepted, confirmDuplicate: true })}>{ct('supply.calendar.saveAnyway')}</ActionButton><ActionButton variant="outline" onClick={onClose}>{ct('supply.calendar.leaveAsIs')}</ActionButton></div> : null;
  return <InlineForm title={heading} onSave={() => save()} onClose={onClose} saveLabel={x.t('common.saveAction')} closeLabel={x.t('common.close')} saving={saving}>
    {!editing ? <SegmentedControl label={x.t('widget.calendar.form.kind')} value={kind} onChange={setKind} options={[{ value: 'event', label: x.t('widget.calendar.form.event') }, { value: 'todo', label: x.t('widget.calendar.form.todo') }]} /> : null}
    <TextField label={ct('supply.calendar.title')} value={title} onValueChange={(v) => { setTitle(v); if (errors.title) setErrors({ ...errors, title: undefined }); }} error={errors.title} name="calendar-title" />
    {asked === 'duplicate' ? answer : null}
    <div className="ms-form-grid">
    <DateField label={ct('supply.calendar.date')} value={date} today={today} error={errors.date} onValueChange={(next) => { if (!next) return; setDate(next); if (errors.date || errors.title) setErrors({ ...errors, date: undefined, title: asked === 'duplicate' ? undefined : errors.title }); }} />
    {kind === 'event' ? <TextField label={x.t('widget.calendar.form.time')} value={time} onValueChange={(v) => { setTime(v); if (errors.time) setErrors({ ...errors, time: undefined }); }} error={errors.time} hint={x.t('widget.calendar.form.timeHint')} inputMode="numeric" name="calendar-time" /> : null}
    </div>
    {asked === 'past' ? answer : null}
    <div className="ms-form-row">
      <ChipChoice label={ct('supply.calendar.category')} value={category} onChange={setCategory} options={categories.map(c=>({value:c.id,label:ct(c.key)}))}/>
      {kind === 'event' && category === 'store-operations' ? <div className="ms-closure"><Checkbox checked={closure} label={ct('supply.calendar.closure')} onCheckedChange={(checked) => { setClosure(checked); if (checked && closureEnd < date) setClosureEnd(date); }} />{closure ? <><ChipChoice label={ct('supply.calendar.closureKind')} value={closureKind} onChange={setClosureKind} options={[{value:'regular',label:ct('supply.calendar.regularClosure')},{value:'temporary',label:ct('supply.calendar.temporaryClosure')}]}/><DateField label={ct('supply.calendar.closureEnd')} value={closureEnd} min={date} today={today} onValueChange={(next) => { if (next) setClosureEnd(next); }} /></> : null}</div> : null}
    </div>
    <TextField label={ct('supply.calendar.memo')} value={memo} onValueChange={setMemo} name="calendar-memo" />
    {errors.form ? <p className="ms-error" role="alert"><Icon name="error" />{errors.form}</p> : null}
  </InlineForm>;
}

function ConfirmDelete({ title, closure, hasLinkedDraft, revision, pending, onDelete }: { title: string; closure: boolean; hasLinkedDraft: boolean; revision?: number; pending: boolean; onDelete: (revision?: number) => void }) {
  const { t } = useBundle(calendarBundle);
  const x = useSupplyText();
  const [confirmation, setConfirmation] = useState<{ revision?: number } | null>(null);
  const confirming = confirmation !== null;
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const warningId = hasLinkedDraft ? `${id}-warning` : undefined;
  useLayoutEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  return <>
    <ActionButton ref={trigger} variant="outline" aria-label={t('supply.calendar.deleteName', { title })}
      aria-expanded={confirming} aria-controls={confirming ? id : undefined} onClick={() => setConfirmation({ revision })}>{x.t('widget.calendar.delete')}</ActionButton>
    {confirming && <div id={id} className="ms-closure-delete" data-esc-layer role="group" aria-labelledby={titleId} aria-describedby={warningId}>
      <p id={titleId} className="ms-caption">{t(closure ? 'supply.calendar.confirmClosureDelete' : 'supply.calendar.confirmDelete')}</p>
      {hasLinkedDraft && <div id={warningId}><WarnLine>{t('supply.calendar.closureDraftsUnlinked')}</WarnLine></div>}
      <div className="ms-closure-delete__actions">
        <ActionButton ref={cancel} variant="secondary" data-esc-close onClick={() => {
          setConfirmation(null);
          trigger.current?.focus();
        }}>{t('supply.calendar.leaveAsIs')}</ActionButton>
        <ActionButton variant="destructive" loading={pending} disabled={confirmation.revision !== revision} onClick={() => onDelete(confirmation.revision)}>{closure ? t('supply.calendar.deleteClosure') : x.t('widget.calendar.delete')}</ActionButton>
      </div>
    </div>}
  </>;
}

function EntryItem({ entry, selected, closures, revisions, deleting, onSelect, onEdit, onDelete, host, naver, compact = false }: { entry: CalendarEntry; selected: boolean; closures: ReadonlyMap<string, boolean>; revisions: ReadonlyMap<string, number | undefined>; deleting: string | null; onSelect: (id: string | null) => void; onEdit: (e: CalendarEntry) => void; onDelete: (e: CalendarEntry, revision?: number) => void; host: WidgetDetailProps['host']; naver?: ReturnType<typeof useCalendarNaver>; compact?: boolean }) {
  const x = useSupplyText();
  const instance=useId();
  const text = x.text(entry.title);
  const {t:ct} = useBundle(calendarBundle);
  const source = entry.source === 'pickup' ? ct('supply.calendar.pickup') : x.t(`widget.calendar.source.${entry.source}`);
  const linkedClosureDraft = closures.get(entry.sourceId);
  if (!entry.editable && entry.ref) {
    const ref: DetailRef = entry.ref;
    return <li className="ms-entry-item" data-row-id={entry.id} data-source={entry.source}>
      <button type="button" className="ms-entry" data-compact={compact ? 'true' : undefined} aria-label={x.t('widget.calendar.openSource', { entry: `${entryTime(x, entry)} ${text}`, widget: x.tk(`widget.${ref.featureId}.title`) })} onClick={() => host.openLinked(ref)}>
        <span className="ms-entry__time"><Flash slot={`calendar:detail:time:${entry.id}:${instance}`} value={entry.time ?? ''}>{entryTime(x, entry)}</Flash></span>
        <span className="ms-entry__body"><span className="ms-entry__title"><CategoryMark category={entry.categoryId==='purchasing'?'stock':entry.categoryId==='tax-admin'?'finance':'store'}><TitleParts text={text} compact={compact} /></CategoryMark></span>{compact ? null : <span className="ms-entry__meta"><span className="ms-tag" data-source={entry.source}>{source}</span>{ref.featureId === 'staff-schedule' ? x.tk('data.staff.error.READ_ONLY_SOURCE') : x.t('widget.calendar.fromSource', { source })}</span>}</span>
        <Icon name="chevron-right" className="ms-entry__chevron" />
      </button>
    </li>;
  }
  if (!entry.editable) return <li className="ms-entry-item" data-row-id={entry.id}><span className="ms-entry"><span className="ms-entry__time"><Flash slot={`calendar:detail:time:${entry.id}:${instance}`} value={entry.time ?? ''}>{entryTime(x, entry)}</Flash></span><span className="ms-entry__body"><CategoryMark category={entry.categoryId==='purchasing'?'stock':entry.categoryId==='tax-admin'?'finance':'store'}><TitleParts text={text} compact={compact} /></CategoryMark>{compact ? null : <span className="ms-entry__meta">{x.t('widget.calendar.fromSource', { source })}</span>}</span></span></li>;
  return <li className="ms-entry-item" data-row-id={entry.id} data-source={entry.source}>
    <button type="button" className="ms-entry" data-compact={compact ? 'true' : undefined} aria-pressed={selected} onClick={() => onSelect(selected ? null : entry.id)}>
      <span className="ms-entry__time"><Flash slot={`calendar:detail:time:${entry.id}:${instance}`} value={entry.time ?? ''}>{entryTime(x, entry)}</Flash></span>
      <span className="ms-entry__body"><span className="ms-entry__title"><Flash value={text}><CategoryMark category={entry.categoryId==='purchasing'?'stock':entry.categoryId==='tax-admin'?'finance':'store'}><TitleParts text={text} compact={compact} /></CategoryMark></Flash></span>{compact ? null : <span className="ms-entry__meta"><span className="ms-tag" data-source={entry.source}>{source}</span></span>}</span>
    </button>
    {selected ? <div className="ms-entry__actions">
      {entry.memo ? <p className="ms-caption"><Flash value={x.text(entry.memo)}>{x.t('widget.calendar.memoLine', { memo: x.text(entry.memo) })}</Flash></p> : null}
      {naver && entry.kind === 'event' ? <CalendarNaverSent naver={naver} eventId={entry.sourceId} /> : null}
      <ActionButton variant="secondary" aria-label={ct('supply.calendar.editName',{title:text})} onClick={() => onEdit(entry)}>{x.t('widget.calendar.edit')}</ActionButton>
      <ConfirmDelete title={text} closure={linkedClosureDraft !== undefined} hasLinkedDraft={linkedClosureDraft === true}
        revision={revisions.get(entry.sourceId)} pending={deleting === entry.id} onDelete={revision => onDelete(entry, revision)} />
    </div> : null}
  </li>;
}

function CalendarDetailContent({ condition, detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID, condition);
  const x = useSupplyText();
  const submit = useStaffCalendarCommand();
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const today = staffCalendarClock(snapshot.tables).date;
  const {t:ct} = useBundle(calendarBundle);
  const categoryLabel = useId();
  const [entry] = useState(() => calendarDetailEntry(detailRef, snapshot));
  const [mode, setMode] = useViewMemory<Mode>('calendar.mode', () => entry.mode ?? 'month');
  const [day, setDay] = useState(entry.date);
  const [form, setForm] = useState<FormSeed | null>(() => entry.prefill ? { kind: 'event', entry: entry.entry, date: entry.date,
    prefill: entry.prefill, revision: snapshot.tables.calendarEvent.find(e => e.eventId === entry.entry?.sourceId)?.revision } : null);
  const [selected, setSelected] = useState<string | null>(entry.entry?.id ?? null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const deletion = useRef<string | null>(null);
  const [settingVisibility, setSettingVisibility] = useState(false);
  const visibilityWrite = useRef(false);
  const detail = useRef<HTMLDivElement>(null);
  const routedRow = entry.prefill ? undefined : entry.entry?.id;
  const selectedEvent = selected?.startsWith('direct:') ? snapshot.tables.calendarEvent.find(event => `direct:${event.eventId}` === selected) : undefined;
  const naver = useCalendarNaver(selectedEvent);
  useLayoutEffect(() => {
    if (!routedRow || view.status !== 'ready') return;
    const row = detail.current?.querySelector(`[data-row-id="${CSS.escape(routedRow)}"] > button`);
    if (row instanceof HTMLButtonElement) row.focus();
  }, [routedRow, view.status]);
  const openAdd = (kind: 'event' | 'todo') => { setSelected(null); setForm({ kind, entry: null, date: day }); };
  const setVisibility = (command: Extract<DataCommand, { type: 'calendar.setCategoryVisible' | 'calendar.setSourceVisible' }>) => {
    if (visibilityWrite.current) return;
    visibilityWrite.current = true;
    setSettingVisibility(true);
    submit(command, result => {
      visibilityWrite.current = false;
      if (detail.current) setSettingVisibility(false);
      if (!result.ok) host.notify({ kind: 'error', messageKey: result.messageKey });
    });
  };
  const remove = (entry: CalendarEntry, revision?: number) => {
    if (deletion.current) return;
    if (revision !== undefined && store.getSnapshot().tables.calendarEvent.find(event => event.eventId === entry.sourceId)?.revision !== revision) {
      host.notify({ kind: 'error', messageKey: 'data.real.error.STALE_REVISION' });
      return;
    }
    deletion.current = entry.id;
    setDeleting(entry.id);
    submit({ type: 'calendar.deleteEvent', eventId: entry.sourceId }, result => {
      deletion.current = null;
      if (detail.current) setDeleting(null);
      if (!result.ok) {
        host.notify({ kind: 'error', messageKey: result.messageKey });
        return;
      }
      notifyResult(host, result, 'data.notice.calendarDeleted');
      if (!detail.current) return;
      if (document.activeElement === document.body) detail.current.querySelector<HTMLElement>(`[data-action="add-${entry.kind}"]`)?.focus();
      setSelected(current => current === entry.id ? null : current);
    });
  };
  if (view.status !== 'ready') {
    const isError = view.status === 'error';
    return <div className="ms-detail ms-cal" data-widget={ID}>
      <div className="ms-detail-state" data-tone={stateTone(view.status)} data-slot={`${ID}.state.message`}>
        <Icon name={isError ? 'error' : 'info'} /><p role={isError ? 'alert' : undefined}>{x.tk(view.messageKey)}</p>
        {isError ? <ActionButton variant="outline" onClick={() => host.resetPreview()}>{x.t('common.retry')}</ActionButton>
          : form ? null : <ActionButton variant="secondary" onClick={() => {host.resetPreview(); openAdd('event');}}>{x.tk(view.actionKey ?? 'data.action.addEvent')}</ActionButton>}
      </div>
      {!isError && form ? <EntryForm seed={form} host={host} onClose={() => setForm(null)} onSaved={() => { setForm(null); host.resetPreview(); }} /> : null}
    </div>;
  }
  const m = selectCalendar(snapshot, {date:day});
  const linkedDrafts = new Set(snapshot.tables.noticeDraft.map(draft => draft.closureEventId));
  const closures = new Map(snapshot.tables.calendarEvent.filter(event => event.storeClosure)
    .map(event => [event.eventId, linkedDrafts.has(event.eventId)]));
  const revisions = new Map(snapshot.tables.calendarEvent.map(event => [event.eventId, event.revision]));
  const entryProps = { closures, revisions, deleting, onSelect: setSelected,
    onEdit: (e: CalendarEntry) => setForm({ kind: e.kind, entry: e, date: e.date, revision: revisions.get(e.sourceId) }), onDelete: remove, host, naver };
  const weekEntries = [...m.weekEntries, ...m.pickupEntries, ...m.staffEntries];
  const entriesOn = (date: string) => weekEntries.filter(entry => entry.date === date)
    .sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.id.localeCompare(b.id));
  const dayEntries = mode === 'day' ? entriesOn(day) : m.todayEntries;
  const dayPickups = m.pickupEntries.filter(entry => entry.date === day);
  const dayStaff = m.staffEntries.filter(entry => entry.date === day);
  const anyCategory = Object.values(m.categoryVisibility).some(Boolean);
  return <div ref={detail} className="ms-detail ms-cal" data-widget={ID}>
    <div className="ms-toolbar ms-calendar-toolbar">
      <div className="ms-calendar-toolbar__primary">
        <SegmentedControl label={x.t('widget.calendar.view.label')} value={mode} onChange={setMode} options={[{ value: 'month', label: x.t('widget.calendar.view.month') }, { value: 'week', label: x.t('widget.calendar.view.week') }, { value: 'day', label: x.t('widget.calendar.view.day') }]} />
        <label><Switch.Root nativeButton render={<button type="button" />} disabled={settingVisibility} checked={m.visibility.reservation} onCheckedChange={visible=>setVisibility({type:'calendar.setSourceVisible',source:'reservation',visible})} className="ui-switch" aria-label={ct('supply.calendar.reservations')}><span className="ui-switch-track"><Switch.Thumb className="ui-switch-thumb"/></span></Switch.Root>{ct('supply.calendar.reservations')}</label>
        <label><Switch.Root nativeButton render={<button type="button" />} disabled={settingVisibility} checked={m.visibility.pickup !== false} onCheckedChange={visible=>setVisibility({type:'calendar.setSourceVisible',source:'pickup',visible})} className="ui-switch" aria-label={ct('supply.calendar.pickups')}><span className="ui-switch-track"><Switch.Thumb className="ui-switch-thumb"/></span></Switch.Root>{ct('supply.calendar.pickups')}</label>
        <div className="ms-toolbar__actions">
          <ActionButton variant="secondary" data-action="add-event" onClick={() => openAdd('event')}><Icon name="plus" />{x.t('common.addEvent')}</ActionButton>
          <ActionButton variant="secondary" data-action="add-todo" onClick={() => openAdd('todo')}><Icon name="plus" />{x.t('common.addTodo')}</ActionButton>
          <CalendarExport startDate={mode === 'day' ? day : mode === 'week' ? m.week.start : m.month.gridStart}
            endDate={mode === 'day' ? day : mode === 'week' ? m.week.end : m.month.gridEnd} />
          <CalendarNaverButton naver={naver} />
        </div>
      </div>
      <div className="ms-calendar-toolbar__filters" role="group" aria-labelledby={categoryLabel} aria-busy={settingVisibility || undefined}>
        <span id={categoryLabel}>{ct('supply.calendar.categories')}</span>
        {categories.map(c => <Checkbox key={c.id} disabled={settingVisibility} checked={m.categoryVisibility[c.id]} onCheckedChange={visible => setVisibility({type:'calendar.setCategoryVisible', categoryId:c.id, visible})} label={<CategoryMark category={c.mark}>{ct(c.key)}</CategoryMark>} />)}
      </div>
    </div>
    <CalendarNaverReview naver={naver} current={eventId => store.getSnapshot().tables.calendarEvent.find(event => event.eventId === eventId)} />
    {view.notes?.[0] ? <WarnLine slot={`${ID}.state.message`}>{x.tk(view.notes[0].messageKey)}</WarnLine> : null}
    <div className="ms-cal__body" data-view={mode}>
      <section className="ms-cal__main" aria-label={x.t(mode === 'month' ? 'widget.calendar.view.month' : mode === 'week' ? 'widget.calendar.view.week' : 'widget.calendar.view.day')}>
        <DateField label={ct('supply.calendar.date')} value={day} today={today} onValueChange={(next) => { if (next) setDay(next); }} />
        {!anyCategory?<p>{ct('supply.calendar.none')}</p>:null}
        {anyCategory && mode === 'month' ? <MonthGrid x={x} model={m} detail /> : null}
        {anyCategory && mode === 'week' ? <ol className="ms-week-grid">{weekDays(m.week.start).map((d) => {
          const list = entriesOn(d);
          return <li key={d} className="ms-week-grid__day" data-today={d === m.today ? 'true' : undefined} aria-current={d === m.today ? 'date' : undefined}>
            <h3 className="ms-week-grid__head">{x.format.weekday(d, 'short')} <strong>{dayNumber(d)}</strong></h3>
            {list.length ? <ul className="ms-entries">{list.map((e) => <EntryItem key={e.id} entry={e} selected={selected === e.id} compact {...entryProps} />)}</ul> : <p className="ms-caption">{x.t('widget.calendar.noEvents')}</p>}
          </li>;
        })}</ol> : null}
        {anyCategory && mode === 'day' ? <div className="ms-day">
          <DateStepper text={x.format.date(day, 'long')} onPrevious={() => setDay(addIsoDays(day, -1))} onNext={() => setDay(addIsoDays(day, 1))}  />
          {dayEntries.length ? <ul className="ms-entries">{dayEntries.map((e) => <EntryItem key={e.id} entry={e} selected={selected === e.id} {...entryProps} />)}</ul> : <p className="ms-caption">{x.t('widget.calendar.noEvents')}</p>}
        </div> : null}
      </section>
      {form || mode === 'month' ? <div className="ms-cal__side">
        {form ? <EntryForm key={`${form.entry?.id ?? 'new'}-${form.kind}`} seed={form} host={host} onClose={() => setForm(null)} onSaved={(id, savedDate) => { setForm(null); setDay(savedDate); setSelected(id ? `direct:${id}` : null); }} /> : null}
        {mode === 'month' ? <aside className="ms-cal__agenda">
          <section className="ms-section" aria-labelledby="ms-cal-today">
            <h3 id="ms-cal-today" className="ms-section__title">{x.format.date(m.today, 'long')}</h3>
            <p className="ms-count" data-slot={`${ID}.metric.value`}>{x.t('widget.calendar.today')} <Flash value={m.todayCount}><strong>{x.t('widget.calendar.eventCount', { count: m.todayCount, number: x.format.number(m.todayCount) })}</strong></Flash></p>
            {m.todayEntries.length ? <ul className="ms-entries" aria-label={x.t('widget.calendar.today')}>{m.todayEntries.map((e) => <EntryItem key={e.id} entry={e} selected={selected === e.id} {...entryProps} />)}</ul> : <p className="ms-caption">{x.t('data.state.calendar.none')}</p>}
            <p lang="ko">{ct('supply.calendar.pickupSummary',{n:m.pickupCount})}</p>
            {dayPickups.length ? <ul className="ms-entries" aria-label={x.tk('widget.custom-order.title')}>{dayPickups.map(e => <EntryItem key={e.id} entry={e} selected={selected === e.id} {...entryProps} />)}</ul> : null}
            {dayStaff.length ? <><p className="ms-list__heading" aria-hidden="true">{x.tk('widget.staff-schedule.title')}</p><ul className="ms-entries" aria-label={x.tk('widget.staff-schedule.title')}>{dayStaff.map(e => <EntryItem key={e.id} entry={e} selected={selected === e.id} {...entryProps} />)}</ul></> : null}
          </section>
          <p className="ms-count"><Flash value={m.weekCount}>{x.t('widget.calendar.weekSummary', { count: m.weekCount })}</Flash></p>
        </aside> : null}
      </div> : null}
    </div>
  </div>;
}

function CalendarPanel(props:WidgetPanelProps){return <SupplySurface featureId={ID} scope="dashboard"><CalendarPanelContent {...props}/></SupplySurface>;}
function CalendarDetailGate(props: WidgetDetailProps) {
  const state = useDomainState('staff');
  const port = useRealPort();
  const retry = useRealRetry('staff');
  const x = useSupplyText();
  useLayoutEffect(() => {
    // The POS outbox can reach Customer after the receipt-triggered refresh.
    const current = port?.state('staff');
    if (current && !current.refreshing && (current.status === 'ready' || current.status === 'stale')) retry();
  }, [port, retry]);
  const error = state.status === 'error';
  if (state.mode === 'http' && (state.status === 'idle' || state.status === 'loading' || error)) {
    return <div className="ms-detail ms-cal" data-widget={ID}>
      <div className="ms-detail-state" data-tone={error ? 'error' : undefined}>
        <p role={error ? 'alert' : 'status'}>{x.tk(error ? 'data.real.error' : 'data.real.loading')}</p>
        {error ? <ActionButton variant="outline" onClick={retry}>{x.t('common.retry')}</ActionButton> : null}
      </div>
    </div>;
  }
  return <CalendarDetailContent {...props} />;
}
function CalendarDetail(props:WidgetDetailProps){return <SupplyDetailSession><SupplySurface featureId={ID} scope="detail"><CalendarDetailGate {...props}/></SupplySurface></SupplyDetailSession>;}

export const calendarWidget: WidgetModule = { id: ID, Panel: CalendarPanel, Detail: CalendarDetail, useSummary: useCalendarSummary };

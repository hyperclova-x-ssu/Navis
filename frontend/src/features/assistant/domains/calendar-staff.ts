import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import type { CalendarCategory, CalendarEntry, Staff, StaffSchedule } from '../../../data/widget-data';
import { resolveDataText, selectCalendar } from '../../../data/widget-data';
import { handlers, type HandlerContext, type HandlerResult } from '../../../data/commands/handlers';
import { guardCalendarWrite, type CalendarWrite } from '../../../data/commands/calendar-guard';
import type { DataCommand } from '../../../data/commands/types';
import { addDays, daysBetween, isIsoDate, isTime, TODAY, weekdayOf } from '../../../data/db/time';
import type { DataSnapshot } from '../../../data/db/types';
import { selectDraftClosureLink, selectStoreClosures } from '../../../data/iteration7/notices/selectors';
import { findShiftConflicts, handoffTimes, selectStaffSchedule } from '../../../data/iteration7/staff/selectors';
import { staffCalendarClock } from '../../../data/iteration7/staff/clock';
import { validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { createTranslator } from '../../../i18n';
import { mgmtSupplyBundle } from '../../widgets/mgmt-supply/messages';
import { navisTranslator } from '../messages';
import { normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisNumber, parseNavisPeriod, parseNavisTime } from '../navis-input';
import { calendarStaffMessages } from './calendar-staff.messages';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainLookup, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter, RecordSearch, RecordTargets } from './registry';

const calendar = 'calendar' as const;
const staffFeature = 'staff-schedule' as const;
type CalendarStaffCommand = Exclude<Extract<DataCommand, { type: `calendar.${string}` | `staff.${string}` }>, { type: 'staff.delete' }>;
type Command = CalendarStaffCommand['type'];
type CalendarEvent = DataSnapshot['tables']['calendarEvent'][number];
type Options = { readonly allowClosureWrites?: boolean; readonly allowSingleDeletes?: boolean };
const commands: readonly Command[] = [
  'calendar.addEvent', 'calendar.addTodo', 'calendar.updateEvent', 'calendar.deleteEvent',
  'calendar.setCategoryVisible', 'calendar.setSourceVisible',
  'staff.create', 'staff.update', 'staff.saveSchedule', 'staff.deleteSchedule', 'staff.moveHandoff',
];
const deleteCommands = new Set<Command>(['calendar.deleteEvent', 'staff.deleteSchedule']);
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1000;
const dayOf = (snapshot: DataSnapshot) => snapshot.tables.staffCalendarAsOf
  ? staffCalendarClock(snapshot.tables).date
  : snapshot.pos?.businessDate ?? TODAY;
const inLocale = (locale: Locale, ko: string, en: string, hans: string, hant: string) => ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];
const nameKey = (name: string) => name.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
const activeStaff = (s: DataSnapshot) => s.tables.staff.filter(person => person.archivedAt === null);
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const dayRange = (start: string, end = start): QueryCondition => ({ kind: 'dateRange', start, end });
const weekStart = (date: string) => addDays(date, 1 - weekdayOf(date));
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
const monthEnd = (date: string) => addDays(monthStart(addDays(monthStart(date), 32)), -1);
const directEntry = (row: CalendarEvent): CalendarEntry => ({
  id: `direct:${row.eventId}`, source: 'direct', sourceId: row.eventId, date: row.date, time: row.time, title: row.title,
  memo: row.memo, kind: row.kind, ref: null, categoryId: row.categoryId ?? 'store-operations', editable: true,
});

function labels(locale: Locale) {
  const base = navisTranslator(locale);
  const tr = (ko: string, en: string, hans: string, hant: string) => inLocale(locale, ko, en, hans, hant);
  return { ...base, tr,
    name: tr('이름', 'Name', '姓名', '姓名'),
    date: tr('날짜', 'Date', '日期', '日期'),
    time: tr('시간', 'Time', '时间', '時間'),
    title: tr('일정', 'Event', '日程', '行程'),
    memo: tr('메모', 'Note', '备注', '備註'),
    category: tr('분류', 'Category', '类别', '類別'),
    rest: tr('휴게', 'Break', '休息', '休息'),
    staff: tr('직원', 'Staff', '员工', '員工'),
    shift: tr('근무', 'Shift', '班次', '班次'),
    off: tr('휴무', 'Off', '休息', '休息'),
    closure: tr('매장 휴무', 'Store closure', '门店休息', '門市休息'),
    linked: tr('연결된 공지 초안', 'Linked notice drafts', '关联通知草稿', '連結通知草稿'),
    allDay: tr('종일', 'All day', '全天', '全天'),
    none: tr('없어요', 'None', '暂无', '暫無'),
    empty: '—',
  };
}
function sourceLabel(source: CalendarEntry['source'], l: ReturnType<typeof labels>) {
  return source === 'pickup' ? l.tr('픽업', 'Pickup', '自提', '自取')
    : createTranslator(l.locale, mgmtSupplyBundle).t(`widget.calendar.source.${source}`);
}
const categoryLabel = (id: CalendarCategory, l: ReturnType<typeof labels>) => ({
  'store-operations': l.tr('매장 운영', 'Store operations', '门店运营', '門市營運'),
  purchasing: l.tr('발주·입고', 'Orders and deliveries', '采购与入库', '採購與入庫'),
  'tax-admin': l.tr('세금·행정', 'Tax and administration', '税务与行政', '稅務與行政'),
})[id];
const dataLabel = (value: CalendarEntry['title'] | null, l: ReturnType<typeof labels>) => value ? resolveDataText(l.t, value) : '';
const shiftLabel = (row: StaffSchedule, l: ReturnType<typeof labels>) => row.kind === 'off' ? l.off : `${row.start}~${row.end}`;
const entryLabel = (row: CalendarEntry, l: ReturnType<typeof labels>) =>
  [l.format.date(row.date, 'short'), row.time ?? (row.kind === 'event' ? l.allDay : ''), dataLabel(row.title, l)].filter(Boolean).join(' ');
const fact = (key: string, label: string, value: AgentFact['value'], display = String(value), unit = 'text', date?: string): AgentFact =>
  ({ key, label, value, display, unit, ...(date ? { date } : {}) });
const count = (key: string, label: string, value: number, l: ReturnType<typeof labels>, unit: 'person' | 'record' = 'record', date?: string) =>
  fact(key, label, value, unit === 'person' ? l.tr(`${l.format.number(value)}명`, l.format.number(value), `${value}人`, `${value}人`)
    : l.tr(`${l.format.number(value)}건`, l.format.number(value), `${value}项`, `${value}項`), unit, date);
const minuteLabel = (value: number, l: ReturnType<typeof labels>) => {
  const n = l.format.number(value);
  return l.tr(`${n}분`, `${n} min`, `${n}分钟`, `${n}分鐘`);
};
const range = (s: DataSnapshot, c: QueryCondition) => c.kind === 'default' ? { start: dayOf(s), end: dayOf(s) }
  : c.kind === 'dateRange' && isIsoDate(c.start) && isIsoDate(c.end) && c.start <= c.end && daysBetween(c.start, c.end) <= 366 ? c : undefined;

function calendarRows(snapshot: DataSnapshot, start: string, end: string) {
  const view = selectCalendar(snapshot, { date: dayOf(snapshot), start, end });
  return [...[...view.entries, ...view.pickupEntries].map(row => ({ ...row, staffShift: false })),
    ...view.staffEntries.map(row => ({ ...row, staffShift: true }))].sort((a, b) =>
    a.date.localeCompare(b.date) || (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.id.localeCompare(b.id));
}

function projectWidget(s: DataSnapshot, feature: FeatureId, condition: QueryCondition, locale: Locale) {
  if (feature !== calendar && feature !== staffFeature) return;
  const period = range(s, condition);
  if (!period) return { status: 'unsupported_period' as const };
  const { start, end } = period, l = labels(locale), date = dayOf(s);
  if (feature === calendar) {
    if (s.tables.calendarProjection === undefined && !s.tables.integration.calendar) return { status: 'unavailable' as const };
    const rows = calendarRows(s, start, end);
    const events = rows.filter(row => row.kind === 'event' && !row.staffShift && row.source !== 'pickup');
    const shifts = rows.filter(row => row.staffShift);
    const pickups = rows.filter(row => row.source === 'pickup');
    const todos = rows.filter(row => row.kind === 'todo');
    return { facts: [
      count('calendar.entries.count', l.title, events.length + shifts.length + pickups.length, l, 'record', start),
      count('calendar.scheduled.count', l.title, events.length, l, 'record', start),
      count('calendar.shift.count', l.tr('근무 일정', 'Staff shifts', '员工班次', '員工班次'), shifts.length, l, 'record', start),
      count('calendar.pickup.count', l.tr('픽업', 'Pickups', '自提', '自取'), pickups.length, l, 'record', start),
      count('calendar.todo.count', l.tr('할 일', 'To-dos', '待办', '待辦'), todos.length, l, 'record', start),
      ...rows.slice(0, 40).flatMap((row, index) => {
        const key = `calendar.entry.${index}`;
        const entry = [l.format.date(row.date, 'monthDay'), row.time ?? (row.kind === 'event' ? l.allDay : ''), dataLabel(row.title, l)].filter(Boolean).join(' ');
        const label = row.staffShift ? l.shift : row.kind === 'todo' ? l.tr('할 일', 'To-do', '待办', '待辦') : l.title;
        const source = sourceLabel(row.source, l);
        const closure = s.tables.calendarEvent.find(event => row.editable && event.eventId === row.sourceId)?.storeClosure;
        return [{ ...fact(key, label, entry, entry, 'text', row.date), ...(row.staffShift && { source: staffFeature }) },
          fact(`${key}.source`, l.tr('출처', 'Source', '来源', '來源'), row.source, source, 'text', row.date),
          fact(`${key}.category`, l.category, row.categoryId, categoryLabel(row.categoryId, l), 'text', row.date),
          fact(`${key}.kind`, l.tr('종류', 'Type', '类型', '類型'), row.kind,
            row.kind === 'todo' ? l.tr('할 일', 'To-do', '待办', '待辦') : l.title, 'text', row.date),
          ...(row.memo ? [fact(`${key}.memo`, l.memo, dataLabel(row.memo, l))] : []),
          ...(closure ? [fact(`${key}.closure`, l.closure, closure.endDate, l.format.date(closure.endDate, 'short'), 'date', row.date)] : []),
        ];
      }),
      ...selectStoreClosures(s, period).filter(closure => !rows.some(row => row.editable && row.sourceId === closure.eventId))
        .map((closure, index) => fact(`calendar.closure.${index}`, l.closure, closure.title,
          [l.format.date(closure.startDate, 'short'), l.format.date(closure.endDate, 'short'), closure.title].join(' '), 'text', closure.startDate)),
    ] };
  }
  const currentTime = staffCalendarClock(s.tables).time;
  const model = selectStaffSchedule(s, { startDate: start, endDate: end });
  const names = new Map(model.staff.map(person => [person.staffId, person.name]));
  const current = new Set(model.rows.filter(row => row.date === date && row.kind === 'work' && row.start! <= currentTime && currentTime < row.end!).map(row => row.staffId));
  const work = new Set(model.rows.filter(row => row.kind === 'work').map(row => row.staffId));
  const off = new Set(model.rows.filter(row => row.kind === 'off').map(row => row.staffId));
  const countLabel = (ko: string, en: string, hans: string, hant: string) => l.tr(ko, en, hans, hant);
  return { facts: [
    count('staff.current.count', countLabel('지금 근무', 'Working now', '当前在岗', '目前在班'), current.size, l, 'person', date),
    count('staff.roster.count', l.staff, model.staff.length, l, 'person'),
    count('staff.work.count', l.shift, work.size, l, 'person', start),
    count('staff.off.count', l.off, off.size, l, 'person', start),
    count('staff.rows.count', l.shift, model.rows.length, l, 'record', start),
    count('staff.changes.count', countLabel('근무 변경', 'Schedule changes', '排班变更', '排班變更'), model.changes.length, l),
    ...model.staff.map((person, index) => fact(`staff.roster.${index}`, l.staff, person.name)),
    ...model.staff.map((person, index) => {
      const net = model.rows.reduce((sum, row) => row.staffId === person.staffId && row.kind === 'work'
        ? sum + minutes(row.end!) - minutes(row.start!) - row.breakMinutes : sum, 0);
      const display = [l.format.quantity(Math.floor(net / 60), 'hour'), net % 60 ? minuteLabel(net % 60, l) : ''].filter(Boolean).join(' ');
      return fact(`staff.net.${index}`, person.name, net, display, 'minute', start);
    }),
    ...model.rows.slice(0, 80).map((row, index) => {
      const text = [l.format.date(row.date, 'short'), names.get(row.staffId), shiftLabel(row, l)].join(' ');
      return fact(`staff.row.${index}`, row.kind === 'work' ? l.shift : l.off, text, text, 'text', row.date);
    }),
    ...model.changes.slice(-20).map((change, index) => {
      const changed = change.after ?? change.before;
      const name = changed && 'name' in changed ? changed.name : changed && names.get(changed.staffId);
      const operation = change.operation === 'create' ? l.tr('추가', 'Added', '新增', '新增')
        : change.operation === 'delete' ? l.tr('삭제', 'Deleted', '删除', '刪除') : l.tr('변경', 'Updated', '修改', '修改');
      const text = [l.format.dateTime(change.at), operation, name].filter(Boolean).join(' ');
      return fact(`staff.change.${index}`, l.shift, text, text, 'text', change.at.slice(0, 10));
    }),
    ...(model.today.nextHandoffAt ? [fact('staff.handoff.time', l.tr('교대', 'Handoff', '交班', '交班'), model.today.nextHandoffAt)] : []),
    fact('staff.clock', l.tr('기준 시각', 'Business time', '基准时间', '基準時間'), currentTime, currentTime, 'time', date),
  ] };
}

type RecordKind = 'event' | 'staff' | 'shift';
type RowMatch = { id: string; label: string; match: 'exact' | 'similar'; fields: NonNullable<ReturnType<RecordAdapter['search']>[number]['fields']>; detail: string };
const matchName = (query: string, label: string) => {
  const key = nameKey(query), name = nameKey(label);
  if (key === name && key) return 'exact';
  if (key.length >= 2 && name.includes(key)) return 'similar';
};
function eventMatches(s: DataSnapshot, query: string, locale: Locale) {
  const l = labels(locale);
  const [name, date] = query.split('\n');
  const day = dayOf(s);
  const auto = calendarRows(s, date || addDays(day, -366), date || addDays(day, 366)).filter(row => !row.editable);
  const rows = [...s.tables.calendarEvent.map(directEntry), ...auto];
  const matches = rows.flatMap<RowMatch>(row => {
    if (date && row.date !== date) return [];
    const title = dataLabel(row.title, l), match = matchName(name, title);
    if (!match) return [];
    const closure = s.tables.calendarEvent.find(event => row.editable && event.eventId === row.sourceId)?.storeClosure;
    const linkedDraftCount = s.tables.noticeDraft.filter(draft => draft.closureEventId === row.sourceId).length;
    const source = sourceLabel(row.source, l);
    const detail = [entryLabel(row, l), source, dataLabel(row.memo, l)].filter(Boolean).join(' · ');
    return [{ id: row.editable ? row.sourceId : row.id, label: title, match, detail, fields: { date: row.date, source: row.source, ...row.time && { time: row.time },
      categoryId: row.categoryId, kind: row.kind, closure: !!closure, ...(closure ? { linkedDraftCount } : {}) } }];
  });
  return matches.some(row => row.match === 'exact') ? matches.filter(row => row.match === 'exact') : matches;
}
function staffMatches(s: DataSnapshot, name: string, locale: Locale) {
  const l = labels(locale), key = nameKey(name).replace(/(?:씨|님)$/u, '');
  const people = activeStaff(s);
  const exact = people.filter(person => nameKey(person.name) === key);
  const suffix = exact.length ? [] : people.filter(person => key.length >= 2 && nameKey(person.name).endsWith(key));
  return (exact.length ? exact : suffix).map<RowMatch>(person => {
    const scheduleCount = s.tables.staffSchedule.filter(row => row.staffId === person.staffId).length;
    return { id: person.staffId, label: person.name, match: exact.length || suffix.length === 1 ? 'exact' : 'similar',
      detail: `${person.name} ${count('x', l.shift, scheduleCount, l).display}`, fields: { scheduleCount } };
  });
}
function shiftMatches(s: DataSnapshot, query: string, locale: Locale, querySlot?: string) {
  const l = labels(locale), [name, date] = query.split('\n');
  const people = staffMatches(s, name, locale);
  return s.tables.staffSchedule.flatMap<RowMatch>(row => {
    const person = people.find(candidate => candidate.id === row.staffId);
    if (!person || date && row.date !== date) return [];
    const rest = minuteLabel(row.breakMinutes, l);
    const detail = querySlot === 'rest' ? [person.label, l.rest, rest].join(' ')
      : querySlot === 'end' ? [person.label, row.end ?? l.off].join(' ')
      : [person.label, l.format.date(row.date, 'short'), shiftLabel(row, l), row.kind === 'work' ? `${l.rest} ${rest}` : ''].filter(Boolean).join(' ');
    return [{ id: row.scheduleId, label: person.label, match: person.match, detail, fields: {
      date: row.date, kind: row.kind, ...(row.start && { start: row.start }), ...(row.end && { end: row.end }), breakMinutes: row.breakMinutes,
    } }];
  });
}
function reader(kind: RecordKind): RecordAdapter {
  const rows = ({ snapshot, query, locale, querySlot }: RecordSearch) => (kind === 'event' ? eventMatches(snapshot, query, locale)
    : kind === 'staff' ? staffMatches(snapshot, query, locale) : shiftMatches(snapshot, query, locale, querySlot)).slice(0, 20);
  const handle = (index: number) => `n10-${kind}-${index}`;
  return {
    kind,
    search: input => rows(input).map((row, index) => ({ handle: handle(index), match: row.match, fields: row.fields,
      ...(!input.privateLookup ? { label: row.label.slice(0, 180) } : {}) })),
    resolve: (input, target) => rows(input).find((_, index) => handle(index) === target)?.id,
    describe: (match, locale, input) => input ? rows({ ...input, locale }).find((_, index) => handle(index) === match.handle)?.detail : match.label,
  };
}

function expand(value: unknown, slots: LocalSlots, targets: RecordTargets): unknown {
  if (!isObject(value)) return value;
  if (typeof value.slot === 'string') return slots[value.slot];
  if (typeof value.handle === 'string') return targets.get(value.handle)?.id;
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, expand(item, slots, targets)]));
}

const slotValidators = {
  title: string, name: string, memo: (value: unknown) => value === null || typeof value === 'string' && value.length <= 1000,
  date: isIsoDate, endDate: isIsoDate, time: isTime, start: isTime, end: isTime, fromTime: isTime, toTime: isTime,
  breakMinutes: (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1438,
  dateIntent: (value: unknown) => value === 'historical',
  confirmDuplicate: (value: unknown) => value === true,
};

function simulate(command: CalendarStaffCommand, snapshot: DataSnapshot, proposalId: string) {
  let counter = 0;
  const handler = handlers[command.type] as (context: HandlerContext, command: CalendarStaffCommand) => HandlerResult;
  return handler({ snapshot, tables: snapshot.tables, nextId: prefix => `${prefix}-navis-${proposalId}-${++counter}` }, command);
}

function closureOverlaps(snapshot: DataSnapshot, row: CalendarEvent, l: ReturnType<typeof labels>) {
  if (!row.storeClosure) return;
  const start = row.date, end = row.storeClosure.endDate;
  const visible = { ...snapshot, tables: { ...snapshot.tables,
    calendarSettings: { direct: true, pickup: true, delivery: true, reservation: true, shift: true, deadline: true },
    categoryVisibility: { 'store-operations': true, 'tax-admin': true, purchasing: true },
  } };
  const view = selectCalendar(visible, { date: dayOf(snapshot), start, end });
  const workingIds = new Set(snapshot.tables.staffSchedule.filter(shift => shift.kind === 'work').map(shift => shift.scheduleId));
  const overlaps = [...view.entries.filter(entry => entry.source !== 'shift' && entry.kind === 'event' && entry.sourceId !== row.eventId),
    ...view.pickupEntries, ...view.staffEntries.filter(entry => workingIds.has(entry.sourceId))];
  const spanning = selectStoreClosures(snapshot, { start, end })
    .filter(closure => closure.eventId !== row.eventId && closure.startDate < start);
  const total = overlaps.length + spanning.length;
  if (!total) return;
  const titles = [
    ...spanning.map(closure => closure.title),
    ...overlaps.filter(entry => entry.source === 'direct').map(entry => dataLabel(entry.title, l)),
    ...overlaps.filter(entry => entry.source !== 'direct').map(entry => dataLabel(entry.title, l)),
  ];
  const examples = titles.slice(0, 2).map(title => (title || l.title).slice(0, 80));
  const remaining = total - examples.length;
  return examples.join(' · ') + (remaining ? ` +${l.format.number(remaining)}` : '');
}

function previewChanges(command: CalendarStaffCommand, before: DataSnapshot, after: DataSnapshot, value: unknown, locale: Locale) {
  const l = labels(locale), a = before.tables, b = after.tables;
  const fields: { label: string; before: string; after: string }[] = [];
  const add = (label: string, prior?: string, next?: string) => fields.push({ label, before: prior || l.empty, after: next || l.empty });
  let title: string;
  if (command.type === 'calendar.setCategoryVisible' || command.type === 'calendar.setSourceVisible') {
    const shown = (visible: boolean) => visible ? l.tr('보여요', 'Shown', '显示', '顯示') : l.tr('숨겨요', 'Hidden', '隐藏', '隱藏');
    if (command.type === 'calendar.setCategoryVisible') {
      title = categoryLabel(command.categoryId, l);
      add(title, shown(a.categoryVisibility[command.categoryId]), shown(command.visible));
    } else {
      title = sourceLabel(command.source, l);
      add(title, shown(a.calendarSettings[command.source] !== false), shown(command.visible));
    }
  } else if (command.type.startsWith('calendar.')) {
    const id = 'eventId' in command ? command.eventId : isObject(value) ? value.eventId : undefined;
    const old = a.calendarEvent.find(row => row.eventId === id), row = b.calendarEvent.find(row => row.eventId === id);
    title = row?.kind === 'todo' || old?.kind === 'todo' ? l.tr('할 일', 'To-do', '待办', '待辦') : l.title;
    add(title, dataLabel(old?.title ?? null, l), dataLabel(row?.title ?? null, l));
    add(l.date, old && l.format.date(old.date, 'long'), row && l.format.date(row.date, 'long'));
    if (old?.kind === 'event' || row?.kind === 'event') add(l.time, old && (old.time ?? l.allDay), row && (row.time ?? l.allDay));
    if (old?.categoryId || row?.categoryId) add(l.category, old?.categoryId && categoryLabel(old.categoryId, l), row?.categoryId && categoryLabel(row.categoryId, l));
    if (old?.memo || row?.memo) add(l.memo, dataLabel(old?.memo ?? null, l), dataLabel(row?.memo ?? null, l));
    if (old?.storeClosure || row?.storeClosure) {
      const closure = (event?: CalendarEvent) => event?.storeClosure ? [
        event.storeClosure.kind === 'regular' ? l.tr('정기 휴무', 'Regular', '定期', '定期') : l.tr('임시 휴무', 'Temporary', '临时', '臨時'),
        l.format.date(event.storeClosure.endDate, 'long'),
      ].join(' ') : undefined;
      add(l.closure, closure(old), closure(row));
      const overlaps = row && closureOverlaps(before, row, l);
      if (overlaps) add(l.t('common.navis.agent.closureOverlaps'), overlaps, overlaps);
      const removesClosure = old?.storeClosure && !row?.storeClosure;
      const drafts = a.noticeDraft.filter(draft => draft.closureEventId === id && (removesClosure || selectDraftClosureLink(before, draft) === 'current'));
      const stale = drafts.filter(draft => selectDraftClosureLink(after, draft) !== 'current');
      if (stale.length) {
        const next = removesClosure ? count('x', l.linked, 0, l).display
          : l.tr('다시 가져와 주세요', 'Import again', '请重新导入', '請重新匯入');
        add(l.linked, count('x', l.linked, stale.length, l).display, next);
        if (removesClosure) {
          // The Korean card label carries the localized warning into the second step.
          add('안내', undefined,
            l.tr('연결된 공지 초안에서 휴무 연결이 끊겨요', 'Linked notice drafts will lose their connection to this closure.',
              '相关通知草稿将解除与这条休息日程的关联。', '相關通知草稿將解除與這筆休息行程的連結。'));
        }
      }
    }
  } else if (command.type === 'staff.create' || command.type === 'staff.update') {
    title = l.staff;
    const id = 'staffId' in command ? command.staffId : isObject(value) ? value.staffId : undefined;
    const old = a.staff.find(person => person.staffId === id), row = b.staff.find(person => person.staffId === id);
    add(l.name, old?.name, row?.name);
  } else {
    title = command.type === 'staff.moveHandoff' ? l.tr('근무 교대', 'Shift handoff', '交班', '交班') : l.shift;
    const result = isObject(value) ? value : undefined;
    const ids = command.type === 'staff.moveHandoff' && Array.isArray(result?.scheduleIds) ? result.scheduleIds
      : ['scheduleId' in command && command.scheduleId || result?.scheduleId];
    const existingId = 'scheduleId' in command ? command.scheduleId : undefined;
    const oldDate = a.staffSchedule.find(row => row.scheduleId === existingId)?.date;
    const newDate = 'date' in command ? command.date : undefined;
    add(l.date, (oldDate ?? newDate) && l.format.date((oldDate ?? newDate)!, 'long'), newDate && l.format.date(newDate, 'long'));
    for (const id of ids) {
      const old = a.staffSchedule.find(row => row.scheduleId === id), row = b.staffSchedule.find(r => r.scheduleId === id);
      const staffId = (row ?? old)?.staffId;
      const name = a.staff.find(person => person.staffId === staffId)?.name ?? l.shift;
      add(name, old && shiftLabel(old, l), row && shiftLabel(row, l));
      if (old?.kind === 'work' || row?.kind === 'work') add(l.rest, old?.kind === 'work' ? minuteLabel(old.breakMinutes, l) : undefined,
        row?.kind === 'work' ? minuteLabel(row.breakMinutes, l) : undefined);
    }
  }
  return { title, target: fields[0]?.after === l.empty ? fields[0]?.before : fields[0]?.after, fields };
}

function commandAdapter(type: Command, options: Options): CommandAdapter<CalendarStaffCommand, { command: CalendarStaffCommand; locale: Locale }> {
  return {
    command: type, featureId: type.startsWith('staff.') ? staffFeature : calendar, slots: slotValidators,
    resolve(wire, slots, snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return;
      const args = expand(wire, slots, targets);
      if (!isObject(args) || !validateAgentCommandArgs(type, args)) return;
      if (args.eventId !== undefined && !snapshot.tables.calendarEvent.some(row => row.eventId === args.eventId)) return;
      if (args.staffId !== undefined && !activeStaff(snapshot).some(person => person.staffId === args.staffId)) return;
      if (args.scheduleId !== undefined && !snapshot.tables.staffSchedule.some(row => row.scheduleId === args.scheduleId &&
        (args.staffId === undefined || args.staffId === row.staffId) &&
        (type !== 'staff.saveSchedule' || args.date === row.date))) return;
      const locale = slots.navisLocale === 'en' || slots.navisLocale === 'zh-Hans' || slots.navisLocale === 'zh-Hant' ? slots.navisLocale : 'ko';
      return { command: { ...args, type } as CalendarStaffCommand, locale };
    },
    preflight({ command: draft, locale }, { snapshot, proposalId, idempotencyKey }) {
      const command = { ...draft, idempotencyKey };
      const prior = 'eventId' in command ? snapshot.tables.calendarEvent.find(row => row.eventId === command.eventId) : undefined;
      if (deleteCommands.has(command.type) && !options.allowSingleDeletes ||
        (prior?.storeClosure || 'storeClosure' in command) && !options.allowClosureWrites) return { kind: 'invalid' };
      if ((command.type === 'staff.create' || command.type === 'staff.update') && activeStaff(snapshot)
        .some(person => nameKey(person.name) === nameKey(command.name) && (command.type === 'staff.create' || person.staffId !== command.staffId))) {
        return { kind: 'conflict', field: 'name' };
      }
      if (command.type === 'calendar.updateEvent' && prior &&
        !('title' in command || 'date' in command || 'time' in command || 'memo' in command || 'categoryId' in command || 'storeClosure' in command)) return { kind: 'unchanged' };
      if (command.type === 'staff.update' && snapshot.tables.staff.some(person => person.staffId === command.staffId && person.name === command.name.trim())) return { kind: 'unchanged' };
      const result = simulate(command, snapshot, proposalId);
      if (!result.ok) return { kind: result.code === 'CONFLICT' ? 'conflict' : 'invalid', field: result.field, messageKey: result.messageKey };
      const after = { ...snapshot, tables: result.tables };
      if (result.tables === snapshot.tables ||
        command.type.startsWith('staff.') && result.tables.staffScheduleChange.length === snapshot.tables.staffScheduleChange.length) return { kind: 'unchanged' };
      const oldShift = command.type === 'staff.saveSchedule' ? snapshot.tables.staffSchedule.find(row => row.scheduleId === command.scheduleId) : undefined;
      const clearsClosure = command.type === 'calendar.updateEvent' && command.storeClosure === null && prior?.storeClosure;
      const removesWork = command.type === 'staff.saveSchedule' && command.kind === 'off' && oldShift?.kind === 'work';
      const tier = clearsClosure || removesWork ? 'extra-confirm' as const : undefined;
      return { kind: 'ready', command, preview: previewChanges(command, snapshot, after, result.value, locale), ...(tier ? { tier } : {}) };
    },
    undoToken: result => result.undoToken,
  };
}

const datePhrase = /(?:(?:\d{4}\s*년\s*)?\d{1,2}\s*월\s*\d{1,2}\s*일|(?<!\d)(?:\d{4}[-./])?\d{1,2}[-./]\d{1,2}(?![\d/:])|(?:(?:이번|다음|지난|저번)\s*주\s*)?[월화수목금토일]요일|(?:이번|다음|지난|저번)\s*달\s*(?:말|초|\d{1,2}\s*일)|그저께|어제|오늘|내일|모레|글피)/gu;
const dayOfMonthPhrase = /(?<!\S)(\d{1,2}|삼)\s*일(?=\s|에|로|$)/gu;
const clockNumber = '[0-9]{1,2}|열\u0020?(?:한|두|세)?|한|두|세|네|다섯|여섯|일곱|여덟|아홉|일|이|삼|사|오|육|칠|팔|구|십[일이삼사오육칠팔구]?';
const hourPhrase = new RegExp(`(?<![\\p{L}\\d])(?:(오전|오후|아침|새벽|낮|점심|저녁|밤)\\s*)?(?:(\\d{1,2}):(\\d{2})|(${clockNumber})\\s*시(?!간|대)(?:\\s*(반|(?:${clockNumber})\\s*분))?)`, 'gu');
const relativeClock = /(?<![가-힣\d])([\d]+|한|두|세|네)\s*(시간|분)\s*(뒤|후|전)(?:에)?/u;
const recent = /지금부터|이제\s*남|남은\s*일정/u;
const deleteVerb = /지워|삭제|없애|빼\s*줘/u;
const bulkDelete = /모두|전부|전체|한꺼번에|한\s*번에|싹|(?:^|\s)다\s|두\s*(?:개|건|명)|둘\s*다|\b(?:all|every|both)\b|全部|所有/iu;
const listSeparator = /(?:이랑|하고|및|[과와랑])\s+|[,·]\s*/u;
const editVerb = /바꿔|바꾸|변경|고쳐|옮겨|옮기|미뤄|미루|수정|당겨|메모(?:에|는|:)/u;
const addVerb = /넣|추가|등록|잡아|기록|하는\s*걸로|하기로/u;
const openVerb = /열어|띄워|으로\s*가|보여|화면|상세|탭/u;
const staffWords = /근무|직원|출근|퇴근|교대|휴게|쉬는\s*(?:날|시간)|누가\s*(?:언제\s*)?(?:일해|쉬어)|몇\s*명\s*일하고|스케줄표/u;
const calendarWords = /일정|캘린더|달력|할\s*일|to-do/u;
const appointment = /점검|촬영|세무사\s*상담/u;
const filterHistory = /필터.*(?:청소.*(?:언제|마지막)|언제\s*청소)/u;
const titleEdit = /(?:제목|이름)(?:을|은)?\s+.+으?로\s*[.!?]?$/u;
const memoEdit = /일정(?:에|의)\s+(.+?)\s+메모\s*(?:추가|등록|수정|변경)/u;
const calendarEdit = (text: string) => editVerb.test(text) || titleEdit.test(text) || memoEdit.test(text);
const closureWords = /(?:임시|정기|매장|가게)\s*휴무|휴무\s*일정|쉬는\s*날로\s*일정/u;
const negatedWrite = /(?:하지|남기지|넣지|옮기지|바꾸지|지우지)\s*(?:마|말)|\b(?:do not|don't|never)\b|不要|别|別/iu;
function cleanText(value: string) {
  return normalizeNavisInput(value).replace(/내일모레/gu, '모레').replace(/담\s*주/gu, '다음 주').replace(/담\s*달/gu, '다음 달')
    .replace(/금욜/gu, '금요일').replace(/월말|이달\s*말일|이번\s*달\s*마지막\s*날/gu, '이번 달 말')
    .replace(/다음날/gu, '다음 날');
}
function dateFrom(text: string, today: string) {
  const direct = parseNavisDate(text, today);
  if (direct) return direct;
  const [single] = text.matchAll(dayOfMonthPhrase);
  if (!single || [...text.matchAll(datePhrase)].length) return;
  const day = String(parseNavisNumber(single[1])).padStart(2, '0');
  const current = `${today.slice(0, 7)}-${day}`;
  const next = `${addDays(monthEnd(today), 1).slice(0, 7)}-${day}`;
  return current >= today && isIsoDate(current) ? current : isIsoDate(next) ? next : undefined;
}
function periodFrom(text: string, today: string) {
  const firstWeek = /(?<!\d)(\d{1,2})\s*월\s*첫째\s*주/u.exec(text);
  if (firstWeek) {
    const first = `${today.slice(0, 4)}-${firstWeek[1].padStart(2, '0')}-01`;
    if (isIsoDate(first)) {
      const start = weekdayOf(first) === 1 ? first : addDays(weekStart(first), 7);
      return { start, end: addDays(start, 6) };
    }
  }
  if (/다음\s*주말|이번\s*주말/u.test(text)) return;
  const period = parseNavisPeriod(text, today);
  if (period && /(?:이번\s*달|\d{1,2}\s*월)(?!\s*(?:\d+\s*일|초|말))/u.test(text)) return { start: period.start, end: monthEnd(period.start) };
  return period;
}
type SpokenClock = { readonly time: string; readonly ambiguous: boolean; readonly raw: string; readonly index: number };
function clocks(text: string): SpokenClock[] {
  const times = [...text.matchAll(hourPhrase)].flatMap<SpokenClock>(match => {
    const [, part, colon, minute, spoken, suffix] = match;
    const parsed = parseNavisNumber(colon ?? spoken);
    if (parsed === undefined || part && parsed > 12 && !colon) return [];
    const hour = part && parsed <= 12 ? parsed % 12 + (/오후|낮|점심|저녁|밤/u.test(part) ? 12 : 0) : parsed;
    const min = minute ? Number(minute) : suffix === '반' ? 30 : suffix ? parseNavisNumber(suffix.replace(/\s*분/u, '')) : 0;
    const time = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    return isTime(time) ? [{ time, ambiguous: !colon && !part && parsed >= 1 && parsed <= 12, raw: match[0], index: match.index }] : [];
  });
  if (times.length !== 1) return times;
  const shorthand = /(?<![\d:\-/])(\d{1,2})\s*[-~]\s*\d{1,2}\s*시/u.exec(text);
  return shorthand && !times.some(time => time.index === shorthand.index) ? [
    { time: `${shorthand[1].padStart(2, '0')}:00`, ambiguous: false, raw: shorthand[1], index: shorthand.index }, ...times,
  ] : times;
}
function staffClocks(text: string): SpokenClock[] {
  const times = clocks(text);
  if (times.length) return times;
  const shorthand = /(?<![\d:\-/])(\d{1,2})\s*[-~]\s*(\d{1,2})(?![\d./])\s*(?=근무)/u.exec(text);
  return shorthand ? shorthand.slice(1).map(clock => ({ time: `${clock.padStart(2, '0')}:00`, ambiguous: true, raw: clock, index: shorthand.index })) : [];
}
const afternoon = (clock: SpokenClock) => clock.ambiguous && clock.time < '12:00' ? `${Number(clock.time.slice(0, 2)) + 12}:${clock.time.slice(3)}` : clock.time;
const requestedMinutes = (text: string) => {
  const match = /(?:휴게(?:\s*시간)?|쉬는\s*시간|점심\s*시간)\s*([\d]+|한|두|세|반)\s*(시간|분)/u.exec(text);
  return match ? (parseNavisNumber(match[1]) ?? NaN) * (match[2] === '시간' ? 60 : 1) : undefined;
};
const categoryIn = (text: string): CalendarCategory | undefined => /세금[·\s]*행정/u.test(text) ? 'tax-admin'
  : /발주[·\s]*입고/u.test(text) ? 'purchasing' : /매장\s*운영/u.test(text) ? 'store-operations' : undefined;
const slotFields = new Set(['title', 'name', 'memo', 'date', 'time', 'start', 'end', 'endDate', 'fromTime', 'toTime', 'breakMinutes', 'dateIntent', 'confirmDuplicate']);
function routedCommand(command: Command, fields: Record<string, unknown>, locale: Locale, lookup: readonly DomainLookup[] = [], local: LocalSlots = {}): DomainTurnInput {
  const slots: Record<string, string | number | boolean | null | undefined> = { navisLocale: locale };
  function wire(values: Record<string, unknown>): AgentWireArgs {
    return Object.fromEntries(Object.entries(values).map(([field, value]) => {
      if (slotFields.has(field) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null && field === 'memo')) {
        slots[field] = value;
        return [field, { slot: field }];
      }
      return [field, isObject(value) ? wire(value) : value];
    })) as AgentWireArgs;
  }
  const args = wire(fields);
  return { intent: { kind: 'command', command, args, ...(lookup[0] ? { querySlot: lookup[0].querySlot } : {}) }, slots: { ...slots, ...local }, lookups: lookup };
}
const bound = (kind: RecordKind, querySlot: string, field: string): DomainLookup => ({ kind, querySlot, bind: [field] });
const widgetRead = (featureId: FeatureId, condition: QueryCondition, factKeys: readonly string[], onMissing?: DomainTurnInput['onMissing']): DomainTurnInput =>
  ({ intent: { kind: 'read', featureId, condition }, factKeys, onMissing });
const recordRead = (kind: RecordKind, querySlot: string, query: string, onMissing?: DomainTurnInput['onMissing']): DomainTurnInput =>
  ({ intent: { kind: 'read', recordKind: kind, querySlot }, slots: { [querySlot]: query }, onMissing });
const clarification = (field: string, answer: string, resume?: (value: string) => DomainRoute | undefined): DomainRoute =>
  ({ kind: 'clarification', field, answer, resume });
const answer = (text: string): DomainRoute => ({ kind: 'answer', answer: text });
const refuse = (featureId: FeatureId, text: string): DomainRoute =>
  ({ kind: 'refusal', reason: 'widget_only', answer: text, alternative: { featureId } });

function nameFrom(text: string, people: readonly Staff[]) {
  const known = people.flatMap(person => [person.name, person.name.slice(1)]).filter(name => name.length >= 2)
    .sort((a, b) => b.length - a.length).find(name => new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|씨|님|의|이|은|는|를|$)`, 'u').test(text));
  if (known) return known;
  const first = text.replace(datePhrase, ' ').replace(/^\s*(?:직원|신입|새\s*직원)\s*/u, '').trim().split(/[\s,:]+/u)[0];
  return /^[가-힣]{2,4}$/u.test(first) && !/근무|이름|교대|직원|오전|오후|쉬는|휴무|새로|다음|이번|누가|오늘|내일/u.test(first)
    ? first : undefined;
}
function staffRoute(text: string, s: DataSnapshot, locale: Locale, options: Options): DomainRoute | undefined {
  const l = labels(locale), today = dayOf(s), date = dateFrom(text, today), actual = date ?? today;
  const currentTime = staffCalendarClock(s.tables).time;
  const people = activeStaff(s), query = nameFrom(text, people), selected = query ? staffMatches(s, query, locale) : [];
  const person = selected.length === 1 && selected[0].match === 'exact' ? people.find(p => p.staffId === selected[0].id) : undefined;
  const times = staffClocks(text), start = times[0]?.time, last = times.at(-1);
  const end = last && (times.length > 1 && start && last.time <= start && !/새벽|다음\s*날|야간/u.test(text) ? afternoon(last) : last.time);
  const rest = requestedMinutes(text), working = /근무|출근|퇴근|일하는/u.test(text);
  const afterTime = /퇴근|까지\s*일하는/u.test(text);
  const off = /휴무|쉬는\s*(?:날|걸로)|못\s*나와/u.test(text);
  const remove = deleteVerb.test(text), change = editVerb.test(text), create = addVerb.test(text);
  if (remove && (bulkDelete.test(text) || [...text.matchAll(datePhrase)].length > 1 ||
    text.split(listSeparator).filter(part => {
      const name = nameFrom(part, people);
      return name && staffMatches(s, name, locale).length;
    }).length > 1)) return { kind: 'refusal', reason: 'unsupported' };
  const missing = l.tr('해당 직원을 찾지 못했어요.', 'No matching employee.', '没有找到该员工。', '找不到該員工。');
  const gated = l.tr('직원 스케줄표에서 지워 주세요.', 'Delete it in the staff schedule.', '请在员工排班中删除。', '請在員工排班中刪除。');
  const askStaff = () => clarification('name', l.tr('직원 이름을 넣어 주세요.', 'Enter the employee name.', '请输入员工姓名。', '請輸入員工姓名。'));
  const shiftQuery = query ? `${query}\n${actual}` : '';
  const rowMatches = shiftQuery ? shiftMatches(s, shiftQuery, locale) : [];
  const row = rowMatches.length === 1 ? s.tables.staffSchedule.find(value => value.scheduleId === rowMatches[0].id) : undefined;
  if (/교대/u.test(text) && (change || times.length > 0)) {
    const handoffs = handoffTimes(selectStaffSchedule(s, { startDate: actual, endDate: actual }).rows);
    const from = times.length > 1 ? start : actual === today ? handoffs.find(time => time >= currentTime) : handoffs.length === 1 ? handoffs[0] : undefined;
    if (!handoffs.length) return answer(l.tr('교대 일정이 없어요.', 'There is no shift handoff.', '没有交班安排。', '沒有交班安排。'));
    if (!from) return clarification('fromTime', l.tr('어느 교대 시간이에요?', 'Which handoff time?', '是哪个交班时间？', '是哪個交班時間？'));
    if (times.length > 1 && !handoffs.includes(from)) return clarification('fromTime', l.tr('그 시간에 교대가 없어요.', 'There is no handoff at that time.', '该时间没有交班。', '該時間沒有交班。'));
    const next = last && (/미뤄|미루|늦춰/u.test(text) ? afternoon(last) : last.time);
    if (!next || !last) return clarification('toTime', l.tr('몇 시로 바꿀까요?', 'What is the new time?', '改到几点？', '改到幾點？'));
    const command = { type: 'staff.moveHandoff' as const, date: actual, fromTime: from, toTime: next, idempotencyKey: 'preview' };
    const proposeHandoff = (toTime: string) => routedCommand(command.type, { date: actual, fromTime: from, toTime }, locale);
    const preview = simulate(command, s, 'handoff');
    if (!preview.ok) {
      const issue = l.tr('퇴근 시각은 출근 시각보다 뒤여야 해요.', 'End time must be after start time.', '下班时间须晚于上班时间。', '下班時間須晚於上班時間。');
      const alternate = afternoon(last);
      if (alternate !== next && alternate !== from && simulate({ ...command, toTime: alternate }, s, 'handoff').ok) {
        return { kind: 'clarification', field: 'toTime', answer: issue,
          choices: [{ id: 'afternoon', label: calendarStaffMessages.moveHandoff(alternate) }],
          resume: value => value === 'afternoon' ? proposeHandoff(alternate) : undefined };
      }
      return clarification('toTime', issue);
    }
    if (from === next) return answer(l.tr('이미 그 시간이에요.', 'It is already at that time.', '已经是该时间。', '已經是該時間。'));
    return proposeHandoff(next);
  }
  if (/이름/u.test(text) && (change || remove || /빈칸/u.test(text))) {
    const next = /(?:→|->)\s*([^\s]+)|이름(?:을|은)?\s+(?:['‘“]([^'’”]+)['’”]|([^\s]+?))(?:으?로|\s*(?:고쳐|바꿔|수정))/u.exec(text);
    const name = (next?.[1] ?? next?.[2] ?? next?.[3])?.trim();
    if (!name || /빈칸|없애/u.test(name)) return askStaff();
    if (!person) return answer(missing);
    if (nameKey(name) === nameKey(person.name)) return answer(l.tr('이미 그 이름이에요.', 'That name is already set.', '已经是该姓名。', '已經是該姓名。'));
    if (people.some(p => nameKey(p.name) === nameKey(name))) return clarification('name', l.tr('이미 같은 이름이 있어요.', 'That name already exists.', '已有同名员工。', '已有同名員工。'));
    return routedCommand('staff.update', { name }, locale, [bound('staff', 'staffId', 'staffId')], { staffId: query! });
  }
  if (/직원|신입|퇴사/u.test(text) && !working && !off && (create || remove)) {
    if (remove) {
      if (!person) return query ? answer(missing) : askStaff();
      return refuse(staffFeature, gated);
    }
    const name = text.replace(/^신입\s*|^새\s*직원\s*|^직원\s*/u, '')
      .replace(/\s*직원(?:으로)?\s*.*$|\s*(?:등록|추가|넣).*$|\s*하나$/u, '').trim();
    if (!string(name) || /^(?:직원|신입|하나)$/u.test(name)) return askStaff();
    if (people.some(p => nameKey(p.name) === nameKey(name))) return clarification('name', l.tr('이미 같은 이름이 있어요.', 'That name already exists.', '已有同名员工。', '已有同名員工。'));
    return routedCommand('staff.create', { name }, locale, [{ kind: 'staff', querySlot: 'name' }]);
  }
  const write = !/변경\s*이력|바뀐\s*기록/u.test(text) &&
    (remove || change || create || off && /해줘|걸로|처리/u.test(text) || !!rest && !/몇\s*분|얼마나/u.test(text) || times.length > 1 && (working || !!query));
  if (write && (working || off || rest !== undefined || times.length > 1)) {
    if (remove && !date) return clarification('scheduleId', l.tr('어느 날짜의 근무를 지울까요?', 'Which shift date?', '要删除哪一天的班次？', '要刪除哪一天的班次？'));
    if (!off && times.length > 1 && start && end && (end < start || /다음\s*날/u.test(text))) {
      const nextDate = addDays(actual, 1);
      const parts = [start < '23:59' ? `${l.format.date(actual, 'short')} ${start}~23:59` : null,
        end > '00:00' ? `${l.format.date(nextDate, 'short')} 00:00~${end}` : null].filter(Boolean);
      return clarification('splitOvernight', [calendarStaffMessages.overnight, ...parts].join('\n'));
    }
    if (!person) return query ? answer(missing) : askStaff();
    if (remove) {
      if (!rowMatches.length) return answer(l.tr('그날 근무가 없어요.', 'No shift on that day.', '当天没有班次。', '當天沒有班次。'));
      if (!options.allowSingleDeletes) return refuse(staffFeature, gated);
      return routedCommand('staff.deleteSchedule', {}, locale, [bound('shift', 'name', 'scheduleId')], { name: shiftQuery });
    }
    const replace = change || afterTime || rest !== undefined && times.length < 2 || off && row?.kind === 'work';
    const existing = replace ? row : undefined;
    if (replace && !row) return rowMatches.length > 1
      ? clarification('scheduleId', l.tr('어느 근무를 바꿀까요?', 'Which shift should change?', '要更改哪个班次？', '要更改哪個班次？'))
      : answer(l.tr('그날 근무가 없어요.', 'No shift on that day.', '当天没有班次。', '當天沒有班次。'));
    const workStart = off ? null : afterTime || times.length < 2 ? existing?.start ?? null : start ?? null;
    const workEnd = off ? null : afterTime && last ? afternoon(last) : times.length > 1 ? end ?? null : existing?.end ?? null;
    if (!off && (!isTime(workStart) || !isTime(workEnd))) return clarification('start', l.tr('출근과 퇴근 시각을 알려 주세요.', 'Enter start and end times.', '请提供上下班时间。', '請提供上下班時間。'));
    if (!off && workStart! >= workEnd!) return clarification('end', l.tr('퇴근 시각은 출근 시각보다 뒤여야 해요.', 'End time must be after start time.', '下班时间须晚于上班时间。', '下班時間須晚於上班時間。'));
    const breakMinutes = off ? 0 : rest ?? existing?.breakMinutes ?? 0;
    if (!off && breakMinutes >= minutes(workEnd!) - minutes(workStart!)) return clarification('breakMinutes', l.tr('휴게 시간은 근무 시간보다 짧아야 해요.', 'Break time must be shorter than the shift.', '休息时间须短于班次。', '休息時間須短於班次。'));
    const kind = off ? 'off' : 'work';
    if (s.tables.staffSchedule.some(shift => shift.staffId === person.staffId && shift.date === actual && shift.kind === kind &&
      shift.start === workStart && shift.end === workEnd && (rest === undefined || shift.breakMinutes === breakMinutes))) {
      return answer(l.tr('이미 같은 근무가 있어요.', 'That shift already exists.', '已有相同班次。', '已有相同班次。'));
    }
    const conflicts = findShiftConflicts(s.tables.staffSchedule, { staffId: person.staffId, scheduleId: existing?.scheduleId, date: actual, kind, start: workStart, end: workEnd });
    if (conflicts.length) return clarification('updateExisting', l.tr('같은 직원의 근무 시간이 겹쳐요.', 'This employee’s shifts overlap.', '该员工的班次重叠。', '該員工的班次重疊。'),
      value => /^(?:기존\s*근무(?:로)?\s*(?:교체|변경)|교체해\s*줘)$/u.test(value) && conflicts.length === 1
        ? routedCommand('staff.saveSchedule', { date: actual, kind, ...!off && { start: workStart, end: workEnd, breakMinutes } }, locale,
          [bound('staff', 'staffId', 'staffId'), bound('shift', 'name', 'scheduleId')], { staffId: query!, name: shiftQuery }) : undefined);
    return routedCommand('staff.saveSchedule', { date: actual, kind, ...!off && { start: workStart, end: workEnd, breakMinutes } }, locale,
      [bound('staff', 'staffId', 'staffId'), ...(existing ? [bound('shift', 'name', 'scheduleId')] : [])], { staffId: query!, ...(existing ? { name: shiftQuery } : {}) });
  }
  const period = periodFrom(text, today) ?? (/주간|이번\s*주/u.test(text) ? { start: weekStart(today), end: addDays(weekStart(today), 6) } : { start: actual, end: actual });
  const condition = period.start === today && period.end === today ? { kind: 'default' as const } : dayRange(period.start, period.end);
  const projection = projectWidget(s, staffFeature, condition, locale);
  const facts = projection?.facts ?? [];
  if (/총\s*몇\s*시간|근무\s*시간\s*합계|몇\s*시간\s*근무/u.test(text)) {
    if (!person) return query ? answer(missing) : askStaff();
    const start = period.start === period.end && !date ? weekStart(today) : period.start;
    const end = period.start === period.end && !date ? addDays(start, 6) : period.end;
    return widgetRead(staffFeature, dayRange(start, end), [`staff.net.${people.indexOf(person)}`]);
  }
  if (query && /몇\s*시|퇴근|휴게|점심\s*시간|쉬는\s*시간/u.test(text)) {
    const field = /휴게|점심\s*시간|쉬는\s*시간/u.test(text) ? 'rest' : 'end';
    return recordRead('shift', field, shiftQuery, { answer: l.tr('그날 근무가 없어요.', 'No shift on that day.', '当天没有班次。', '當天沒有班次。') });
  }
  if (/지금/u.test(text)) return widgetRead(staffFeature, { kind: 'default' }, ['staff.current.count']);
  if (/변경\s*이력|바뀐\s*거|누가\s*근무\s*바꿨/u.test(text)) {
    const history = periodFrom(text, today) ?? { start: addDays(today, -6), end: today };
    const evidence = projectWidget(s, staffFeature, dayRange(history.start, history.end), locale);
    const changes = evidence?.facts?.filter(fact => fact.key.startsWith('staff.change.')) ?? [];
    return widgetRead(staffFeature, dayRange(history.start, history.end), changes.length ? changes.map(fact => fact.key) : ['staff.changes.count']);
  }
  if (/직원(?:이|\s*명단)|직원\s*누구/u.test(text)) return widgetRead(staffFeature, condition, ['staff.roster.count', ...facts.filter(f => /^staff\.roster\.\d+$/u.test(f.key)).map(f => f.key)]);
  const isOff = /쉬어|쉬는\s*날|휴무/u.test(text);
  const rows = facts.filter(f => /^staff\.row\.\d+$/u.test(f.key) && (isOff ? f.label === l.off : f.label === l.shift));
  const countKey = isOff ? 'staff.off.count' : period.start === period.end ? 'staff.work.count' : 'staff.rows.count';
  return widgetRead(staffFeature, condition, [countKey, ...(/몇\s*명/u.test(text) ? [] : rows.map(f => f.key))]);
}

function calendarTitle(text: string, times: readonly SpokenClock[]) {
  let value = text.split(/\s*[,;]?\s*메모(?:는|에|를)?\s*:?\s*/u)[0];
  for (const clock of times) value = value.replace(clock.raw, ' ');
  value = value.replace(datePhrase, ' ').replace(relativeClock, ' ')
    .replace(/(?:^|\s)(?:\d{1,2}|삼)\s*일(?:에|로)?(?=\s|$)/gu, ' ')
    .replace(/이번\s*주말|(?:이번|다음)\s*주|(?:다음|이번)\s*달\s*초쯤|주말/gu, ' ')
    .replace(/세금[·\s]*행정|발주[·\s]*입고|매장\s*운영|세금\s*낼\s*거|부가세\s*낼/gu, token => /부가세/u.test(token) ? '부가세 납부' : /낼/u.test(token) ? '세금 납부' : ' ')
    .replace(/(?:^|\s)(?:오전|오후|아침|낮|점심때|저녁|종일|날짜로|있었다고|했다고|하는|같이|하나|새|로|에)(?:에|로|는)?(?=\s|$)/gu, ' ')
    .replace(/\s*(?:캘린더|달력)(?:에서|에|로)?|\s*(?:일정|스케줄|할\s*일|to-do)(?:에|로|도)?|\s*분류로/giu, ' ')
    .replace(/(?:^|\s)(?:에|로|는|을|를|으로|까지|부터|에다|어서|하나)(?=\s|$)/gu, ' ')
    .replace(/\([^()]*\)/gu, ' ')
    .replace(/\s*(?:추가|넣어|넣는|등록|기록|잡아|만들어|적어)(?:\s*(?:해|해줘|해주세요|줘|줘유|줘잉|줄래|해줘잉|해줘유))?\s*.*$/u, '')
    .replace(/^[\s:,.!?]+|[\s:,.!?]+$/gu, '').replace(/(?:하는|했다는|했어|이라고)\s*$/u, '').trim();
  return value;
}
const memoFrom = (text: string) => {
  const quoted = /메모(?:는|에|를)?\s*:?\s*['‘“]([^'’”]+)['’”]/u.exec(text);
  return (quoted?.[1] ?? memoEdit.exec(text)?.[1] ?? /메모(?:는|에|를)?\s*:?\s*(.+?)(?:이라고|라고|으로)?\s*(?:적어|바꿔|추가|달아|넣어)?(?:\s*(?:줘|해줘))?\s*$/u.exec(text)?.[1])?.trim();
};
function eventIn(text: string, s: DataSnapshot, l: ReturnType<typeof labels>, includeAutomatic = true) {
  const day = dayOf(s);
  const direct = s.tables.calendarEvent.map(directEntry);
  const all = includeAutomatic ? [...direct, ...calendarRows(s, addDays(day, -366), addDays(day, 366)).filter(row => !row.editable)] : direct;
  const subject = text.split(/(?:메모(?:는|에|:)|(?:일정\s*)?(?:이름|제목)|→|->|고\s*메모|날짜를)/u)[0];
  const key = normalizeNavisName(subject);
  const names = all.map(row => ({ row, title: dataLabel(row.title, l) })).filter(({ title }) => {
    const value = normalizeNavisName(title);
    return value.length >= 2 && key.includes(value);
  }).sort((a, b) => normalizeNavisName(b.title).length - normalizeNavisName(a.title).length);
  return names.length ? names.filter(a => normalizeNavisName(a.title) === normalizeNavisName(names[0].title)) : [];
}
function directCandidate(s: DataSnapshot, text: string, date: string | undefined, l: ReturnType<typeof labels>) {
  const named = eventIn(text, s, l);
  const shortTitle = !named.length && (calendarEdit(text) || deleteVerb.test(text))
    ? /^(.+?)\s+(?:일정|할\s*일)/u.exec(text)?.[1].replace(datePhrase, '').trim() : undefined;
  if (shortTitle) {
    for (const event of s.tables.calendarEvent) {
      const title = dataLabel(event.title, l);
      if (matchName(shortTitle, title)) named.push({ row: directEntry(event), title });
    }
  }
  const direct = named.filter(item => item.row.editable);
  const eligible = direct.length ? direct : named;
  const dated = date && eligible.filter(item => item.row.date === date);
  return dated && dated.length ? dated : eligible;
}
function automaticSource(text: string): FeatureId | undefined {
  if (/원천세|지방소득세|부가세|종합소득세|납부\s*(?:기한|마감)/u.test(text)) return 'tax';
  if (/입고|발주|들어오는/u.test(text)) return 'suppliers';
  if (/픽업|수령/u.test(text)) return 'custom-order';
  if (/근무|교대/u.test(text)) return staffFeature;
  if (/예약/u.test(text) && /캘린더|일정/u.test(text)) return 'voice-booking';
  if (/지원\s*사업.*마감/u.test(text)) return 'grants';
  if (/공동구매|제안.*기한|(?:응답|답장)\s*기한/u.test(text)) return 'community';
}
function calendarRoute(text: string, s: DataSnapshot, locale: Locale, options: Options): DomainRoute | undefined {
  const l = labels(locale), today = dayOf(s), date = dateFrom(text, today);
  const currentTime = staffCalendarClock(s.tables).time;
  const timeValues = clocks(text), clock = timeValues.at(-1), time = clock?.time;
  const relative = relativeClock.exec(text);
  const rel = relative ? parseNavisTime(text, `${today}T${currentTime}`) : undefined;
  const category = categoryIn(text);
  const off = closureWords.test(text);
  const missing = l.tr('그 일정이 없어요.', 'No matching event.', '没有这个日程。', '沒有這個行程。');
  const ownCalendar = l.tr('캘린더에서 바꿔 주세요.', 'Make the change in Calendar.', '请在日历中更改。', '請在行事曆中更改。');
  const auto = l.tr('자동 일정이에요. 출처에서 바꿔 주세요.', 'Change this automatic event in its source.', '请在来源中更改自动日程。', '請在來源中更改自動行程。');
  const past = l.tr('지난 기록으로 남길까요?', 'Save this as a past event?', '保存为过去的记录吗？', '儲存為過去的紀錄嗎？');
  const keepPast = (resume: () => DomainRoute): DomainRoute => ({
    kind: 'clarification', field: 'dateIntent', answer: past,
    choices: [{ id: 'historical', label: l.t('common.navis.agent.keepPastEvent') }],
    resume: value => value === 'historical' ? resume() : undefined,
  });
  const requiresHistorical = (draft: CalendarWrite) => {
    const result = guardCalendarWrite(s.tables, { ...draft, confirmDuplicate: true });
    return result?.ok === false && result.reason === 'CALENDAR_PAST_DATE';
  };
  const ambiguousTime = l.tr('오전과 오후 중 언제예요?', 'Is that AM or PM?', '上午还是下午？', '上午還是下午？');
  const dateQuestion = l.tr('어느 날짜예요?', 'Which date?', '是哪一天？', '是哪一天？');
  if (filterHistory.test(text)) {
    const title = text.split(/언제|마지막/u)[0].trim();
    const latest = eventMatches(s, title, locale).filter(({ fields }) => fields.source === 'direct' && fields.kind === 'event' &&
      typeof fields.date === 'string' && (fields.date < today || fields.date === today &&
        (typeof fields.time !== 'string' || fields.time <= currentTime))).sort((a, b) =>
      String(b.fields.date).localeCompare(String(a.fields.date)) || String(b.fields.time ?? '').localeCompare(String(a.fields.time ?? '')))[0];
    return answer(latest?.detail ?? missing);
  }
  if (!date && /\d{1,2}\s*월\s*\d{1,2}\s*일/u.test(text) &&
    [...text.matchAll(datePhrase)].some(match => !parseNavisDate(match[0], today))) {
    return clarification('date', l.tr('그런 날짜는 없어요.', 'That date does not exist.', '该日期不存在。', '該日期不存在。'));
  }
  const remove = deleteVerb.test(text), change = calendarEdit(text);
  const dateChangeText = text.split(/메모/u)[0];
  const movesDate = /옮|미뤄|미루|날짜|로\s*변경/u.test(dateChangeText);
  const hasDestinationSuffix = (match: RegExpExecArray) => /^\s*으?로/u.test(dateChangeText.slice(match.index + match[0].length));
  const destination = change && movesDate && (
    [...dateChangeText.matchAll(datePhrase)].reverse().find(hasDestinationSuffix) ??
    [...dateChangeText.matchAll(dayOfMonthPhrase)].reverse().find(hasDestinationSuffix)
  );
  const destinationDate = destination ? dateFrom(destination[0], today) : undefined;
  const sourceDate = remove ? date : change ? dateFrom(dateChangeText.slice(0, destination ? destination.index : undefined), today) : undefined;
  const named = directCandidate(s, text, change ? sourceDate : date, l);
  const selected = sourceDate ? named.filter(item => item.row.date === sourceDate) : named;
  const target = selected.length === 1 ? selected[0] : undefined;
  if (remove && (bulkDelete.test(text) || [...text.matchAll(datePhrase)].length > 1 ||
    text.split(listSeparator).filter(part => eventIn(part, s, l).length).length > 1)) {
    return { kind: 'refusal', reason: 'unsupported' };
  }
  const toggle = /숨겨|안\s*보이|꺼\s*줘|보이게|보기\s*켜|같이\s*보여/u.test(text);
  if (toggle) {
    const visible = !/숨겨|안\s*보이|꺼/u.test(text);
    const source = /예약(?!\s*픽업)/u.test(text) ? 'reservation' : /픽업/u.test(text) ? 'pickup' : /근무/u.test(text) ? 'shift' : undefined;
    const categoryId = category ?? (/입고/u.test(text) ? 'purchasing' : undefined);
    if (source || categoryId) {
      if (source ? (s.tables.calendarSettings[source] !== false) === visible : s.tables.categoryVisibility[categoryId!] === visible) {
        return answer(l.tr('이미 그렇게 보여요.', 'That visibility is already set.', '已使用该显示设置。', '已使用該顯示設定。'));
      }
      return source ? routedCommand('calendar.setSourceVisible', { source, visible }, locale)
        : routedCommand('calendar.setCategoryVisible', { categoryId, visible }, locale);
    }
  }
  if (remove || change && !(addVerb.test(text.split(/메모/u)[0]) && !target && !/옮|미루|미뤄|변경|수정/u.test(text.split(/메모/u)[0]))) {
    if (selected.length > 1) {
      if (selected.every(item => item.row.editable)) return clarification('eventId', l.tr('어느 날짜의 일정이에요?', 'Which event date?', '是哪一天的日程？', '是哪一天的行程？'));
      return clarification('eventId', l.tr('어느 일정이에요?', 'Which event?', '是哪条日程？', '是哪個行程？'));
    }
    const from = target?.row.ref?.featureId ?? (!target || !target.row.editable ? automaticSource(text) : undefined);
    if (from) return refuse(from, auto);
    if (!target) return answer(missing);
    const { row, title } = target;
    const old = s.tables.calendarEvent.find(item => item.eventId === row.sourceId);
    if ((old?.storeClosure || off) && !options.allowClosureWrites || remove && !options.allowSingleDeletes) return refuse(calendar, ownCalendar);
    const lookup = [bound('event', 'name', 'eventId')], slots = { name: `${title}\n${row.date}` };
    if (remove) return routedCommand('calendar.deleteEvent', {}, locale, lookup, slots);
    const dateChange = destinationDate ?? (movesDate ? date : undefined);
    const newName = /(?:제목|이름)(?:을|은)?\s*(?:['‘“]([^'’”]+)['’”]|(.+?))\s*(?:으?로(?:\s*(?:바꿔|고쳐|수정|변경))?|$)|(?:→|->)\s*(.+?)\s*(?:으?로)?\s*(?:제목\s*)?(?:수정|변경|$)/u.exec(text);
    const titleChange = newName?.slice(1).find(Boolean)?.trim();
    const memo = memoFrom(text);
    const nextTime = clock && !/메모[^'‘“]*[:]?\s*['‘“][^'’”]*$/u.test(text.slice(0, clock.index)) ? afternoon(clock) : /종일/u.test(text) ? null : undefined;
    const storeClosure = old?.storeClosure && dateChange && dateChange !== old.date
      ? { kind: old.storeClosure.kind, endDate: addDays(dateChange, daysBetween(old.date, old.storeClosure.endDate)) } : undefined;
    const fields = {
      ...titleChange && titleChange !== title && { title: titleChange },
      ...dateChange && dateChange !== row.date && { date: dateChange },
      ...nextTime !== undefined && nextTime !== row.time && { time: nextTime },
      ...memo !== undefined && memo !== dataLabel(row.memo, l) && { memo },
      ...category && category !== row.categoryId && { categoryId: category },
      ...storeClosure && { storeClosure },
    };
    if (!Object.keys(fields).length) return /\d|메모|분류|이름/u.test(text) || !!date
      ? answer(l.tr('이미 그렇게 되어 있어요.', 'It is already set that way.', '已经是这个设置。', '已經是這個設定。'))
      : clarification('change', l.tr('무엇을 바꿀까요?', 'What should change?', '要更改什么？', '要更改什麼？'));
    const proposeUpdate = (historical = false) => routedCommand('calendar.updateEvent',
      { ...fields, ...(historical ? { dateIntent: 'historical' } : {}) }, locale, lookup, slots);
    return requiresHistorical({ type: 'calendar.updateEvent', eventId: row.sourceId, ...fields })
      ? keepPast(() => proposeUpdate(true)) : proposeUpdate();
  }

  const isTodo = /할\s*일|to-do/iu.test(text);
  const relativeDay = rel ? (relative?.[3] !== '전' && rel < currentTime ? addDays(today, 1)
    : relative?.[3] === '전' && rel > currentTime ? addDays(today, -1) : today) : undefined;
  const write = addVerb.test(text.split(/메모/u)[0]) ||
    !!date && !!time && !!category && calendarWords.test(text) && /분류로\s*[.!?]?$/u.test(text) ||
    !!date && !openVerb.test(text) && /일정$/u.test(text) && (!!time || off || /달\s*(?:말|초)/u.test(text)) ||
    date && isTodo && !/알려|뭐|목록/u.test(text);
  if (write) {
    const scope = automaticSource(text);
    if (scope === 'community' && /기한|답장/u.test(text)) {
      if (target && !target.row.editable) return answer(`${l.tr('이미 캘린더에 있어요.', 'It is already in Calendar.', '已在日历中。', '已在行事曆中。')} ${entryLabel(target.row, l)}`);
      return refuse(scope, auto);
    }
    if (off && !options.allowClosureWrites) return refuse(calendar, ownCalendar);
    if (!isTodo && !relativeDay && (!date || /다음\s*달\s*초|(?:이번\s*)?주말/u.test(text))) {
      const invalid = [...text.matchAll(datePhrase)].length > 0 && !date;
      const nextWeek = /다음\s*주(?:에)?/u;
      if (!invalid && nextWeek.test(text) && !/주말/u.test(text)) {
        const monday = addDays(weekStart(today), 7);
        const choices = Array.from({ length: 5 }, (_, day) => {
          const id = addDays(monday, day);
          return { id, label: calendarStaffMessages.weekday(id, day) };
        });
        return { kind: 'clarification', field: 'date', choices,
          answer: l.tr('다음 주 무슨 요일이에요?', 'Which day next week?', '下周星期几？', '下週星期幾？'),
          resume: value => calendarRoute(text.replace(nextWeek, value), s, locale, options) };
      }
      return clarification('date', invalid ? l.tr('그런 날짜는 없어요.', 'That date does not exist.', '该日期不存在。', '該日期不存在。')
        : /주말/u.test(text) ? l.tr('토요일과 일요일 중 언제예요?', 'Saturday or Sunday?', '周六还是周日？', '週六還是週日？') : dateQuestion);
    }
    const actual = date ?? relativeDay ?? today;
    const title = calendarTitle(text, timeValues);
    const inferred = /위생\s*점검|세무사|회의|촬영|필터\s*청소|회식/u.test(title);
    let chosenTime = time ?? rel;
    if (clock?.ambiguous && !isTodo && !off && inferred && (clock.time < '08:00' || /회식/u.test(title))) chosenTime = afternoon(clock);
    if (!string(title)) return clarification('title', l.tr('일정 제목을 넣어 주세요.', 'Enter an event title.', '请输入日程标题。', '請輸入行程標題。'));
    const memo = memoFrom(text);
    const base = { title, ...(date || relativeDay || !isTodo ? { date: actual } : {}),
      ...memo && { memo }, ...!isTodo && category && { categoryId: category },
      ...off && { storeClosure: { kind: /정기/u.test(text) ? 'regular' : 'temporary', endDate: actual } } };
    const command = isTodo ? 'calendar.addTodo' : 'calendar.addEvent';
    const prepareCreate = (scheduledTime: string | undefined): DomainRoute => {
      const draft = { ...base, ...!isTodo && scheduledTime && { time: scheduledTime } };
      // Show a matching row before asking whether the new entry is historical.
      const duplicate = guardCalendarWrite(s.tables, { type: command, ...draft, dateIntent: 'historical' }, today);
      const proposeCreate = (confirmDuplicate = false) => {
        const fields = { ...draft, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) };
        return requiresHistorical({ type: command, ...fields })
          ? keepPast(() => routedCommand(command, { ...fields, dateIntent: 'historical' }, locale))
          : routedCommand(command, fields, locale);
      };
      if (duplicate?.ok === false && duplicate.reason === 'CALENDAR_DUPLICATE') {
        const existing = s.tables.calendarEvent.find(event => event.eventId === duplicate.details?.eventId);
        if (existing) return {
          kind: 'clarification', field: 'duplicateChoice', answer: calendarStaffMessages.duplicate(entryLabel(directEntry(existing), l)),
          choices: [{ id: 'keep', label: calendarStaffMessages.keepDuplicate }, { id: 'add', label: calendarStaffMessages.addDuplicate }],
          resume: value => value === 'add' ? proposeCreate(true) : answer(calendarStaffMessages.keptDuplicate),
        };
      }
      return proposeCreate();
    };
    if (clock?.ambiguous && !isTodo && !off && !inferred) {
      const morning = clock.time.startsWith('12:') ? `00${clock.time.slice(2)}` : clock.time;
      const evening = afternoon(clock);
      const spoken = clock.time.replace(/^0/u, '');
      return { kind: 'clarification', field: 'time', answer: ambiguousTime,
        choices: [{ id: 'am', label: calendarStaffMessages.morning(spoken) }, { id: 'pm', label: calendarStaffMessages.evening(spoken, evening) }],
        resume: value => value === 'am' ? prepareCreate(morning) : value === 'pm' ? prepareCreate(evening) : undefined,
      };
    }
    if (!chosenTime && !isTodo && /아침|오전|저녁|오후|점심때/u.test(text)) {
      const askTime = () => clarification('time', calendarStaffMessages.eventTime, value => {
        const times = clocks(value);
        return times.length === 1 && !times[0].ambiguous ? prepareCreate(times[0].time) : undefined;
      });
      return { kind: 'clarification', field: 'time', answer: calendarStaffMessages.optionalTime,
        choices: [{ id: 'set-time', label: calendarStaffMessages.setTime }, { id: 'skip-time', label: calendarStaffMessages.skipTime }],
        resume: value => value === 'set-time' ? askTime() : value === 'skip-time' ? prepareCreate(undefined) : undefined,
      };
    }
    return prepareCreate(chosenTime);
  }

  if (selected.length && /언제|메모|출처|분류/u.test(text)) {
    const chosen = selected[0];
    const lookup = date && selected.length === 1 ? `${chosen.title}\n${chosen.row.date}` : chosen.title;
    return recordRead('event', 'name', lookup, { answer: missing });
  }
  if (/언제.*했|했더라|마지막.*날|필터.*청소/u.test(text) && !calendarWords.test(text)) {
    const query = text.replace(/언제.*$|마지막.*$|알려.*$/u, '').trim();
    return recordRead('event', 'name', query, { answer: missing });
  }
  const period = periodFrom(text, today) ?? { start: date ?? today, end: date ?? today };
  const condition = period.start === today && period.end === today ? { kind: 'default' as const } : dayRange(period.start, period.end);
  const upcoming = recent.test(text), listRows = calendarRows(s, period.start, period.end);
  const keys = listRows.slice(0, 40).flatMap((row, index) => {
    if ((row.kind === 'todo') !== isTodo || upcoming && (row.date !== today || !row.time || row.time < currentTime)) return [];
    return [`calendar.entry.${index}`];
  });
  const selectedKeys = upcoming ? keys
    : [...(isTodo ? ['calendar.todo.count'] : /캘린더\s*상태/u.test(text) ? ['calendar.entries.count'] : ['calendar.scheduled.count',
      ...(listRows.some(row => row.staffShift) ? ['calendar.shift.count'] : []),
      ...(listRows.some(row => row.source === 'pickup') ? ['calendar.pickup.count'] : [])]), ...keys];
  const result = widgetRead(calendar, condition, selectedKeys, { answer: isTodo
    ? l.tr('할 일이 없어요.', 'There are no to-dos.', '没有待办事项。', '沒有待辦事項。')
    : l.tr('일정이 없어요.', 'There are no events.', '没有日程。', '沒有行程。') });
  if (isTodo && !keys.length) return { ...result, factKeys: [] };
  return result;
}

function navigation(raw: string, s: DataSnapshot, locale: Locale): DomainDetail | null | undefined {
  const text = cleanText(raw), today = dayOf(s), date = dateFrom(text, today), period = periodFrom(text, today);
  const direct = /화면|상세|창|탭|열어|띄워|곳으로\s*가|보기|보여|월별/u.test(text);
  if (!direct) return;
  if ((calendarWords.test(text) || /예약.*보기\s*켜/u.test(text)) && /숨겨|안\s*보이|보이게|같이\s*보여|보기\s*켜/u.test(text)) return null;
  const next = date ?? period?.start;
  if (staffWords.test(text) || /(?:다음\s*주.*스케줄|변경\s*이력\s*탭)/u.test(text)) {
    const view = /직원\s*(?:추가|등록)|새\s*직원/u.test(text) ? 'add-staff' : /이력|바뀐\s*기록/u.test(text) ? 'history'
      : /직원\s*(?:목록|명단)/u.test(text) ? 'staff' : /월간|월별|한\s*달/u.test(text) ? 'month' : 'week';
    const orientation = /날짜별/u.test(text) ? 'date' : /직원별/u.test(text) ? 'employee' : undefined;
    if (view === 'week' && !next && !orientation && !/근무표|스케줄표|스케줄\s*화면/u.test(text)) return;
    if (view === 'week' && /이번\s*주.*알려|주간.*보여/u.test(text) && !/열어|화면/u.test(text)) return null;
    const person = nameFrom(text, activeStaff(s));
    const rows = person && next ? shiftMatches(s, `${person}\n${next}`, locale) : [];
    const row = rows.length === 1 && rows[0].match === 'exact' ? rows[0] : undefined;
    return { args: { featureId: staffFeature, view, ...(next ? { date: next } : {}), ...(view === 'add-staff' ? { focus: 'action' } : {}),
      ...(orientation ? { prefill: { orientation } } : {}), ...(row ? { itemId: row.id } : {}) },
      ...(row ? { target: { kind: 'shift', id: row.id }, querySlot: 'scheduleId' } : {}) };
  }
  if (!calendarWords.test(text) && !/월간\s*보기|주\s*보기|새\s*일정|일정\s*등록/u.test(text)) return;
  if (/일정\s*(?:추가|등록)|새\s*일정/u.test(text) && /화면|창|폼|곳으로/u.test(text)) {
    const times = clocks(text), title = calendarTitle(text.split(/화면|창|폼|곳으로/u)[0], times);
    const prefill = { ...title && { title }, ...date && { date }, ...times.length === 1 && !times[0].ambiguous && { time: times[0].time } };
    return { args: { featureId: calendar, view: 'add', focus: 'action', ...date && { date }, ...Object.keys(prefill).length && { prefill } } };
  }
  if (calendarWords.test(text) && (period && /쭉|전부/u.test(text) || /이번\s*달\s*일정|다음\s*주\s*일정/u.test(text)) && !/열어|화면|상세/u.test(text)) return null;
  const view = /월간|월별|이번\s*달/u.test(text) ? 'month' : /주간|주\s*보기|이번\s*주/u.test(text) ? 'week' : date ? 'day' : undefined;
  const event = directCandidate(s, text, date, labels(locale));
  if (event.length === 1 && event[0].row.editable && /상세|열어|화면/u.test(text)) {
    const row = event[0].row;
    return { args: { featureId: calendar, view: 'day', date: row.date, itemId: row.sourceId },
      target: { kind: 'event', id: row.sourceId }, querySlot: 'eventId' };
  }
  if (view) return { args: { featureId: calendar, view, ...(next ? { date: next } : {}) } };
}

export function createCalendarStaffDomain(options: Options = {}): DomainAdapter {
  return {
    commands: commands.map(type => commandAdapter(type, options)), reads: ['event', 'staff', 'shift'].map(kind => reader(kind as RecordKind)),
    featureIds: [calendar, staffFeature], projectWidget, navigation,
    routePresentation(raw, s, locale) {
      const text = cleanText(raw);
      if (negatedWrite.test(text)) return;
      if (/휴무자/u.test(text) && !/공지|발송|예약|회원/u.test(text)) return staffRoute(text, s, locale, options);
      const person = nameFrom(text, activeStaff(s));
      if (person && staffMatches(s, person, locale).length &&
        /(?:휴무|쉬는\s*(?:날|걸로)|\s이름(?:을|은)?\s|휴게\s*\d)/u.test(text) && !/공지|발송|예약|회원/u.test(text)) {
        return staffRoute(text, s, locale, options);
      }
      const date = dateFrom(text, dayOf(s));
      const datedMeeting = /거래처\s*미팅/u.test(text) && clocks(text).length === 1;
      const datedCalendar = (calendarWords.test(text) || /점검.*스케줄/u.test(text) || datedMeeting) && !!date && addVerb.test(text) &&
        !/납부\s*일정|예약\s*일정|발주\s*일정/u.test(text);
      const calendarCategory = !!categoryIn(text) && !!date && (addVerb.test(text) || calendarWords.test(text) && /분류로\s*[.!?]?$/u.test(text));
      const categorySetting = !!categoryIn(text) && /분류/u.test(text) && /숨겨|안\s*보이|꺼\s*줘|보이게|보기\s*켜/u.test(text);
      const storedEvent = (calendarEdit(text) || deleteVerb.test(text)) && (calendarWords.test(text) || /메모|분류/u.test(text) || !!categoryIn(text)) &&
        directCandidate(s, text, undefined, labels(locale)).some(item => item.row.editable);
      const eventMove = /\S\s+일정(?:을)?\s.*옮겨/u.test(text) && !/위젯|패널|보드|페이지|예약|픽업|근무|납부/u.test(text);
      if (datedCalendar || calendarCategory || categorySetting || storedEvent || eventMove) return calendarRoute(text, s, locale, options);
    },
    route(raw, s, locale) {
      const text = cleanText(raw);
      if (negatedWrite.test(text)) return;
      if (/^(?:일정|달력|캘린더)(?:(?:이|가)\s*궁금해요?|(?:을|를)?\s*(?:좀\s*)?(?:보여\s*줘|알려\s*줘))?[.!?]?$/u.test(text)) return;
      if (/도움말|위젯|패널|[1-9]x[1-9]|규칙|어떻게\s*(?:해|넣)|권한/u.test(text) && !/일정\s*(?:숨겨|추가)|근무\s*(?:넣|추가)/u.test(text)) return;
      if (/세금|원천세|지방소득세|부가(?:가치)?세|종합소득세/u.test(text) && /납부\s*일정/u.test(text) &&
        (addVerb.test(text) || deleteVerb.test(text)) && !/캘린더|달력/u.test(text)) return;
      const knownStaffQuestion = /몇\s*(?:시|시간).*일해|점심\s*시간.*몇/u.test(text) &&
        !!nameFrom(text, activeStaff(s));
      const overnightStaffInterval = /부터.*다음\s*날.*까지/u.test(text) && !!nameFrom(text, activeStaff(s)) &&
        !!dateFrom(text, dayOf(s)) && staffClocks(text).length === 2;
      if (overnightStaffInterval || /교대/u.test(text) && !deleteVerb.test(text) || (staffWords.test(text) || knownStaffQuestion) &&
        (!calendarWords.test(text) || /근무|교대/u.test(text) && /옮겨/u.test(text))) {
        return staffRoute(text, s, locale, options);
      }
      const periodQuestion = /^(?:이번\s*달에?|다음\s*주)\s*(?:뭐|무슨\s*일)\s*(?:있어|있었어)/u.test(text);
      const scheduledAppointment = appointment.test(text) && addVerb.test(text) &&
        (!!dateFrom(text, dayOf(s)) || /다음\s*주/u.test(text));
      if (calendarWords.test(text) || recent.test(text) || periodQuestion || scheduledAppointment || filterHistory.test(text) ||
        /(?:필터\s*청소|점검).*(?:언제|옮|변경)|(?:원두\s*공동구매|답장|응답)\s*기한|예약.*보기\s*켜/u.test(text)) {
        return calendarRoute(text, s, locale, options);
      }
      // Automatic event titles can name menu items or suppliers. Require scheduling intent for those matches.
      const schedulingIntent = /언제|몇\s*시|기한|예정/u.test(text) || addVerb.test(text) || editVerb.test(text) || deleteVerb.test(text);
      if (eventIn(text, s, labels(locale), schedulingIntent).length) {
        return calendarRoute(text, s, locale, options);
      }
    },
  };
}

export const calendarStaffDomain = createCalendarStaffDomain({ allowClosureWrites: true, allowSingleDeletes: true });

function widgetPrefill(ref: DetailRef, feature: typeof calendar | typeof staffFeature) {
  const fields = ref.prefill?.kind === 'widget-draft' ? ref.prefill.fields : undefined;
  return fields && ref.featureId === feature && validateAgentPrefill(feature, fields) ? fields as Readonly<Record<string, unknown>> : {};
}

export function calendarDetailEntry(ref: DetailRef, snapshot: DataSnapshot) {
  const fields = widgetPrefill(ref, calendar);
  const event = snapshot.tables.calendarEvent.find(row => row.eventId === ref.itemId);
  const mode: 'day' | 'week' | 'month' | undefined = ref.view === 'day' || ref.view === 'week' || ref.view === 'month' ? ref.view : event ? 'day' : undefined;
  const date = event?.date ?? (isIsoDate(ref.date) ? ref.date : isIsoDate(fields.date) ? fields.date : dayOf(snapshot));
  const entry = event ? directEntry(event) : null;
  const category: CalendarCategory | undefined = fields.categoryId === 'purchasing' || fields.categoryId === 'tax-admin' || fields.categoryId === 'store-operations' ? fields.categoryId : undefined;
  const prefill = ref.view === 'add' || ref.focus === 'action' ? {
    title: typeof fields.title === 'string' ? fields.title : undefined,
    time: isTime(fields.time) ? fields.time : undefined,
    memo: typeof fields.memo === 'string' ? fields.memo : undefined,
    category,
    closure: isObject(fields.storeClosure) && (fields.storeClosure.kind === 'regular' || fields.storeClosure.kind === 'temporary') && isIsoDate(fields.storeClosure.endDate) && fields.storeClosure.endDate >= date
      ? { kind: fields.storeClosure.kind, endDate: fields.storeClosure.endDate } as const : undefined,
  } : undefined;
  return { mode, date, entry, prefill };
}

export function staffDetailEntry(ref: DetailRef, snapshot: DataSnapshot) {
  const fields = widgetPrefill(ref, staffFeature);
  const active = activeStaff(snapshot), person = active.find(row => row.staffId === (ref.itemId ?? fields.staffId));
  const row = snapshot.tables.staffSchedule.find(row => row.scheduleId === (ref.itemId ?? fields.scheduleId) && active.some(person => person.staffId === row.staffId));
  const tab: 'week' | 'month' | 'staff' | 'history' = ref.view === 'month' || ref.view === 'staff' || ref.view === 'history' ? ref.view : person && !row ? 'staff' : 'week';
  const date = row?.date ?? (isIsoDate(ref.date) ? ref.date : ref.view === 'date' && isIsoDate(ref.itemId) ? ref.itemId : isIsoDate(fields.date) ? fields.date : dayOf(snapshot));
  const orientation: 'employee' | 'date' = fields.orientation === 'date' || ref.view === 'date' || ref.view === 'schedule' ? 'date' : 'employee';
  const prefill = {
    name: typeof fields.name === 'string' ? fields.name : undefined,
    staffId: person?.staffId,
    date: isIsoDate(fields.date) ? fields.date : undefined,
    start: isTime(fields.start) ? fields.start : undefined,
    end: isTime(fields.end) ? fields.end : undefined,
    breakMinutes: typeof fields.breakMinutes === 'number' ? fields.breakMinutes : undefined,
  };
  const action: 'staff' | 'schedule' | undefined = ref.view === 'add-staff' ? 'staff'
    : ref.focus === 'action' ? row || prefill.start || prefill.end ? 'schedule' : 'staff' : undefined;
  return { tab, date, orientation, action, prefill, person, row };
}

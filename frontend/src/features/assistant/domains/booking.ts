import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import { handlers } from '../../../data/commands/handlers';
import type { BookingInput } from '../../../data/commands/management-types';
import type { DataCommand } from '../../../data/commands/types';
import { BUSINESS_CLOCK, slotHasPassed } from '../../../data/commands/business-clock';
import { findBookingDuplicate } from '../../../data/commands/management-guards';
import { addDays, isIsoDate, isTime } from '../../../data/db/time';
import type { DataSnapshot, Reservation } from '../../../data/db/types';
import { allocateReservation, selectReservations, tableLayoutEnabled } from '../../../data/derive/reservations';
import { maskCustomer } from '../../../data/derive/members';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import { baseBundles, createTranslator, type MessageBundle, type Translator } from '../../../i18n';
import { customersBundle } from '../../widgets/mgmt-customers/messages';
import { validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentReadArgs, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import { normalizeNavisInput, parseNavisDate, parseNavisNumber, parseNavisTime } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainLookup, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter, RecordSearch, RecordTargets } from './registry';

const featureId = 'voice-booking';
const bookingRows = {
  'booking.navis.title': ['방문 예약', 'Visit reservation', '到店预约', '到店預約'],
  'booking.navis.guest': ['예약자', 'Guest', '预约人', '預約人'],
  'booking.navis.phone': ['연락처', 'Phone number', '联系电话', '聯絡電話'],
  'booking.navis.table': ['테이블', 'Table', '桌位', '桌位'],
  'booking.navis.status': ['상태', 'Status', '状态', '狀態'],
  'booking.navis.available': ['가능해요', 'Available', '有空位', '有空位'],
  'booking.navis.noTable': ['맞는 테이블이 없어요', 'No matching table', '没有合适的桌位', '沒有合適的桌位'],
  'booking.navis.confirmed': ['예약 확정', 'Confirmed', '预约已确认', '預約已確認'],
  'booking.navis.waiting': ['예약 대기', 'Needs review', '待确认', '待確認'],
  'booking.navis.proposed': ['제안함', 'Time suggested', '已建议', '已建議'],
  'booking.navis.completed': ['방문 완료', 'Visit complete', '到店完成', '到店完成'],
  'booking.navis.past': ['지난 시간에는 새 예약을 넣을 수 없어요', 'Choose a time that has not passed', '请选择还没过的时间', '請選擇還沒過的時間'],
  'booking.navis.duplicate': ['같은 시간에 비슷한 예약이 있어요', 'There is a similar booking at that time', '同一时间有类似预约', '同一時間有類似預約'],
  'booking.navis.missing': ['확인할 수 있는 매장 자료가 없어요.', 'No matching reservation.', '没有找到预约。', '沒有找到預約。'],
  'booking.navis.unavailable': ['이 요청은 준비할 수 없어요. 앱에서 직접 입력해 주세요.', 'Enter this in the booking widget.', '请在预约页面输入。', '請在預約頁面輸入。'],
  'booking.navis.unchanged': ['이미 같은 내용이에요', 'Already set', '已经是这个内容', '已經是這個內容'],
  'booking.navis.closed': ['이 예약은 상태를 바꿀 수 없어요', 'This reservation cannot be changed', '无法更改此预约', '無法更改此預約'],
} as const;
const copyAt = (position: 0 | 1 | 2 | 3) => Object.fromEntries(Object.entries(bookingRows).map(([key, row]) => [key, row[position]]));
export const bookingBundle: MessageBundle<string> = { id: 'navis.booking', ko: copyAt(0), en: copyAt(1), 'zh-Hans': copyAt(2), 'zh-Hant': copyAt(3) };
const bookingTranslator = (locale: Locale) => createTranslator<string>(locale, ...baseBundles, ...dataBundles, customersBundle, bookingBundle);
const str = (v: unknown): v is string => typeof v === 'string';
const nonEmpty = (v: unknown): v is string => str(v) && v.length <= 1000 && !!v.trim();
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const phoneNumber = (v: unknown): v is string => str(v) && /^\d{10,11}$/u.test(v);
const language = (v: unknown): Locale => v === 'en' || v === 'zh-Hans' || v === 'zh-Hant' ? v : 'ko';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const visits = (snapshot: DataSnapshot) => [...new Set(snapshot.tables.reservation.filter(row => row.kind !== 'pickup' && !row.variant).map(row => row.date))]
  .sort().flatMap(date => selectReservations(snapshot, { date }).rows);
type Visit = ReturnType<typeof visits>[number];

function rowName(row: Visit, t: Translator) {
  return typeof row.name === 'string' ? row.name : resolveDataText(t.t, row.name);
}
function requestText(row: Pick<Reservation, 'request' | 'requestKey'>, t: Translator) {
  return resolveDataText(t.t, row.request) || (row.requestKey ? t.t(row.requestKey) : '');
}
const statusKeys = {
  confirmed: 'booking.navis.confirmed', 'needs-check': 'booking.navis.waiting',
  canceled: 'widget.voice-booking.statusCanceled', 'no-show': 'widget.voice-booking.statusNoShow',
  proposed: 'booking.navis.proposed', completed: 'booking.navis.completed',
} as const;
const warningText = (warning: string | undefined, totalSeats: number, t: Translator) => warning === 'NO_MATCHING_TABLE'
  ? t.t('booking.navis.noTable') : warning === 'SEAT_LIMIT' ? t.t('widget.voice-booking.overSeats', { seats: totalSeats }) : '';
const none = (locale: Locale) => navisTranslator(locale).t('common.navis.agent.none');
const bookingTypes = ['booking.create', 'booking.update', 'booking.confirm', 'booking.cancel', 'booking.markCompleted', 'booking.markNoShow'] as const;
type BookingType = typeof bookingTypes[number];
type BookingCommand = Extract<DataCommand, { type: BookingType }>;
type BookingDraft = { readonly args: Record<string, unknown>; readonly locale: Locale };
const slotValidators = { date: isIsoDate, time: isTime, partySize: positive, name: nonEmpty, phone: phoneNumber,
  request: (v: unknown) => v === null || str(v) && v.length <= 1000 };
const reference = (slot: string) => ({ slot });

function expand(value: unknown, slots: LocalSlots, targets: RecordTargets): unknown {
  if (Array.isArray(value)) return value.map(item => expand(item, slots, targets));
  if (!object(value)) return value;
  if (typeof value.slot === 'string' && Object.keys(value).length === 1) return slots[value.slot];
  if (typeof value.handle === 'string' && Object.keys(value).length === 1) return targets.get(value.handle)?.id;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, slots, targets)]));
}

function bookingPreview(snapshot: DataSnapshot, before: Visit | undefined, after: Visit, locale: Locale) {
  const t = bookingTranslator(locale);
  const empty = none(locale);
  const status = (row: Visit) => t.t(statusKeys[row.status]);
  const keys = [
    ['booking.navis.guest', (row: Visit) => rowName(row, t)],
    ['widget.voice-booking.extDate', (row: Visit) => t.format.date(row.date, 'short')],
    ['widget.voice-booking.extTime', (row: Visit) => row.time],
    ['widget.voice-booking.extParty', (row: Visit) => t.t('widget.voice-booking.party', { n: row.partySize })],
    ['booking.navis.status', status],
    ['booking.navis.table', (row: Visit) => row.tableId],
    ['widget.voice-booking.extRequest', (row: Visit) => requestText(row, t)],
    ['booking.navis.phone', (row: Visit) => resolveDataText(t.t, row.phone)],
  ] as const;
  const fields = keys.flatMap(([key, value], index) => {
    const previous = before ? value(before) || empty : empty;
    const next = value(after) || empty;
    return index <= 4 || previous !== next ? [{ label: t.t(key), before: previous, after: next }] : [];
  });
  const warning = warningText(after.allocationWarning, selectReservations(snapshot, { date: after.date }).totalSeats, t);
  if (warning) fields.push({ label: t.t('booking.navis.status'), before: warning, after: warning });
  return { title: t.t('booking.navis.title'), target: rowName(after, t), fields, before: before ?? null, after };
}

function bookingAdapter(type: BookingType): CommandAdapter<BookingCommand, BookingDraft, ReturnType<typeof bookingPreview>> {
  return {
    command: type, featureId, slots: slotValidators,
    resolve(wire, slots, snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return;
      const args = expand(wire, slots, targets);
      if (!object(args) || !validateAgentCommandArgs(type, args)) return;
      if (type === 'booking.update' && object(args.patch) && !Object.keys(args.patch).length) return;
      if (args.reservationId !== undefined && !visits(snapshot).some(row => row.reservationId === args.reservationId)) return;
      return { args, locale: language(slots.navisLocale) };
    },
    preflight({ args, locale }, { snapshot, proposalId, idempotencyKey }) {
      const before = visits(snapshot).find(row => row.reservationId === args.reservationId);
      const command = { ...args, type, baseRevision: snapshot.revision, idempotencyKey } as BookingCommand;
      const ctx = { snapshot, tables: snapshot.tables, nextId: (prefix: string) => `${prefix}-navis-preview-${proposalId}` };
      const handler = handlers[type] as (context: typeof ctx, command: BookingCommand) => ReturnType<typeof handlers['booking.create']>;
      const result = handler(ctx, command);
      if (!result.ok) return { kind: result.reason === 'BOOKING_DUPLICATE' ? 'conflict' : 'invalid', field: result.field, messageKey: result.messageKey };
      if (result.tables === snapshot.tables) return { kind: 'unchanged' };
      const after = visits({ ...snapshot, tables: result.tables }).find(row => row.reservationId === (before?.reservationId ?? ctx.nextId('rv')));
      if (!after) return { kind: 'invalid' };
      const patch = type === 'booking.update' ? args.patch : args;
      if (object(patch) && object(patch.tableChoice) && (!tableLayoutEnabled(snapshot.tables.shopSettings) || after.allocationWarning)) {
        return { kind: 'invalid', field: 'tableChoice', messageKey: 'data.management.error.TABLE_INVALID' };
      }
      return { kind: 'ready', command, preview: bookingPreview(snapshot, before, after, locale) };
    },
    undoToken: result => result.undoToken,
  };
}

interface BookingQuery {
  readonly name?: string;
  readonly date?: string;
  readonly time?: string;
  readonly partySize?: number;
  readonly status?: 'canceled';
  readonly mode?: 'requests' | 'call' | 'waiting';
  readonly request?: string;
}
const encodeQuery = (query: BookingQuery) => JSON.stringify(query);
function queryOf(query: string): BookingQuery {
  try {
    const value: unknown = JSON.parse(query);
    if (object(value)) return {
      name: str(value.name) ? value.name : undefined, date: isIsoDate(value.date) ? value.date : undefined,
      time: isTime(value.time) ? value.time : undefined, partySize: positive(value.partySize) ? value.partySize : undefined,
      status: value.status === 'canceled' ? value.status : undefined,
      mode: value.mode === 'requests' || value.mode === 'call' || value.mode === 'waiting' ? value.mode : undefined,
      request: str(value.request) ? value.request : undefined,
    };
  } catch { /* A simple local name is also a supported lookup. */ }
  return { name: query };
}
const nameKey = (value: string) => normalizeNavisInput(value).toLowerCase().replace(/\s+/gu, '');
function visitMatches(snapshot: DataSnapshot, query: BookingQuery, locale: Locale) {
  const t = bookingTranslator(locale);
  const name = query.name && nameKey(query.name);
  return visits(snapshot).filter(row =>
    (!query.date || row.date === query.date) && (!query.time || row.time === query.time) &&
    (!query.partySize || row.partySize === query.partySize) &&
    (!query.status || row.status === query.status) &&
    (query.mode !== 'waiting' || row.status === 'needs-check') &&
    (query.mode !== 'call' || !!query.name || !!row.callId) &&
    (query.mode !== 'requests' || row.status !== 'canceled' && !!requestText(row, t)) &&
    (!query.request || requestText(row, t).includes(query.request)),
  ).flatMap(row => {
    const label = nameKey(rowName(row, t));
    const masked = name && maskCustomer({ name, maskKey: '' }).name;
    const exact = !name || name === label || typeof masked === 'string' && masked === label;
    const similar = name && (name.length >= 2 && label.includes(name) || name.length === 1 && label.startsWith(name));
    return exact || similar ? [{ row, match: exact ? 'exact' as const : 'similar' as const }] : [];
  });
}
const reservationHandle = (index: number) => `visit-${index}`;
const reservationReader: RecordAdapter = {
  kind: 'reservation',
  search({ snapshot, locale, query, privateLookup }) {
    const t = bookingTranslator(locale);
    const matches = visitMatches(snapshot, queryOf(query), locale);
    const exact = matches.filter(item => item.match === 'exact');
    return (exact.length ? exact : matches).map(({ row, match }, index) => ({
      handle: reservationHandle(index), match,
      ...(!privateLookup ? { label: rowName(row, t).slice(0, 180) } : {}),
      fields: { kind: 'visit', date: row.date, time: row.time, partySize: row.partySize, status: row.status, source: row.source,
        visitStarted: slotHasPassed(row.date, row.time),
        ...(row.allocationWarning === 'NO_MATCHING_TABLE' || row.allocationWarning === 'SEAT_LIMIT' ? { allocationWarning: row.allocationWarning } : {}) },
    }));
  },
  resolve(input, handle) {
    const matches = visitMatches(input.snapshot, queryOf(input.query), input.locale);
    const exact = matches.filter(item => item.match === 'exact');
    return (exact.length ? exact : matches).find((_, index) => reservationHandle(index) === handle)?.row.reservationId;
  },
  describe(match, locale, input) {
    const t = bookingTranslator(locale);
    const date = typeof match.fields?.date === 'string' ? t.format.date(match.fields.date, 'short') : '';
    const time = match.fields?.time;
    const party = match.fields?.partySize;
    const details = [date, time, typeof party === 'number' ? t.t('widget.voice-booking.party', { n: party }) : ''].filter(Boolean).join(' · ');
    if (!input) return details;
    const id = reservationReader.resolve?.(input, match.handle);
    const row = visits(input.snapshot).find(item => item.reservationId === id);
    if (!row) return undefined;
    const { mode } = queryOf(input.query);
    const call = mode === 'call' && row.callId ? input.snapshot.tables.callLog.find(item => !item.variant && item.callId === row.callId) : undefined;
    const additional = mode === 'call' ? call ? resolveDataText(t.t, call.summary) : t.t(row.source === 'direct' ? 'widget.voice-booking.noCall' : 'booking.navis.missing')
      : mode === 'requests' ? requestText(row, t) : '';
    return [match.label, details, additional].filter(Boolean).join(' · ');
  },
};

function tableMatches({ snapshot, query }: RecordSearch) {
  if (!tableLayoutEnabled(snapshot.tables.shopSettings)) return [];
  return snapshot.tables.shopSettings.tableLayout?.tables.filter(table =>
    table.tableId.toLowerCase() === query.toLowerCase() || `t${table.number}` === query.toLowerCase()) ?? [];
}
const tableReader: RecordAdapter = {
  kind: 'table',
  search(input) {
    return tableMatches(input).map((table, index) => ({ handle: `booking-table-${index}`, match: 'exact',
      ...(!input.privateLookup ? { label: `T${table.number}` } : {}) }));
  },
  resolve(input, handle) { return tableMatches(input).find((_, index) => handle === `booking-table-${index}`)?.tableId; },
};

function fact(key: string, value: AgentFact['value'], label: string, display: string, date: string, unit = ''): AgentFact {
  return { key, value, label, display, date, unit };
}
function projectBooking(snapshot: DataSnapshot, widget: FeatureId, condition: QueryCondition, locale: Locale) {
  if (widget !== featureId) return;
  if (condition.kind === 'dateRange' && condition.start !== condition.end) return { status: 'unsupported_period' } as const;
  const date = condition.kind === 'default' ? snapshot.pos?.businessDate ?? BUSINESS_CLOCK.date
    : condition.kind === 'snapshot' ? condition.asOf : condition.start;
  if (!isIsoDate(date)) return { status: 'unsupported_period' } as const;
  const t = bookingTranslator(locale), data = selectReservations(snapshot, { date });
  const count = (key: string, n: number, label: string) => fact(key, n, t.t(label), t.t('widget.voice-booking.bookingCount', { n }), date, 'reservation');
  const seatUnit = data.availability.kind === 'seats' ? 'seat' : 'table';
  const active = data.rows.filter(row => row.counts);
  return { facts: [
    count('booking.today.count', data.count, date === BUSINESS_CLOCK.date ? 'widget.voice-booking.today' : 'widget.voice-booking.byTimeCount'),
    fact('booking.people', data.partyTotal, t.t('widget.voice-booking.extParty'), t.t('widget.voice-booking.party', { n: data.partyTotal }), date, 'person'),
    count('booking.needsCheck.count', data.needsCheckCount, statusKeys['needs-check']),
    count('booking.source.phone', active.filter(row => row.source === 'phone_ai').length, 'widget.voice-booking.sourcePhone'),
    count('booking.source.direct', active.filter(row => row.source === 'direct').length, 'widget.voice-booking.sourceDirect'),
    count('booking.completed.count', active.filter(row => row.status === 'completed').length, statusKeys.completed),
    count('booking.past.confirmed', active.filter(row => row.canMarkCompleted).length, statusKeys.confirmed),
    fact('booking.seats', data.totalSeats, t.t('widget.voice-booking.extParty'), t.t('widget.voice-booking.seatsTotal', { n: data.totalSeats }), date, 'seat'),
    fact('booking.availability', data.availability.value, t.t('booking.navis.available'), t.format.count(data.availability.value, seatUnit), date, seatUnit),
    ...data.timeGroups.map(group => fact('booking.slot', group.count, group.time,
      t.t('widget.voice-booking.nextValue', { count: group.count, people: group.partyTotal }), date, 'reservation')),
  ] };
}

export function bookingAllocation(snapshot: DataSnapshot, input: Pick<BookingInput, 'date' | 'time' | 'partySize' | 'tableChoice'>) {
  const probe: Reservation = { kind: 'visit', reservationId: 'navis-capacity-probe', nameKey: 'data.management.guest', requestKey: null,
    source: 'direct', status: 'confirmed', confirmedBy: 'auto', callId: null, proposedTime: null, variant: null,
    date: input.date, time: input.time, partySize: input.partySize };
  return allocateReservation(snapshot.tables, probe, input.tableChoice);
}

const capacityTool = {
  tool: 'check_booking_capacity',
  read(snapshot: DataSnapshot, args: AgentReadArgs['check_booking_capacity'], locale: Locale, slots: LocalSlots, targets: RecordTargets) {
    const date = slots[args.date.slot], time = slots[args.time.slot], partySize = slots[args.partySize.slot];
    if (!isIsoDate(date) || !isTime(time) || !positive(partySize) || slotHasPassed(date, time)) return { status: 'missing' } as const;
    const table = args.tableChoice && args.tableChoice !== 'auto' ? targets.get(args.tableChoice.handle) : undefined;
    if (args.tableChoice && args.tableChoice !== 'auto' && table?.kind !== 'table') return { status: 'missing' } as const;
    const result = bookingAllocation(snapshot, { date, time, partySize, tableChoice: table ? { tableId: table.id } : 'auto' });
    const t = bookingTranslator(locale), available = result.status === 'confirmed';
    const display = available ? t.t('booking.navis.available') : warningText(result.allocationWarning, selectReservations(snapshot, { date }).totalSeats, t);
    return { facts: [fact('booking.capacity.available', Number(available),
      `${time} · ${t.t('widget.voice-booking.party', { n: partySize })}`, display, date),
      ...(result.tableId ? [fact('booking.capacity.table', result.tableId, t.t('booking.navis.table'), result.tableId, date)] : [])] };
  },
} as const;

export function bookingDetailSeed(snapshot: DataSnapshot, ref: DetailRef) {
  const row = ref.itemId ? visits(snapshot).find(item => item.reservationId === ref.itemId) : undefined;
  const fields = ref.prefill?.kind === 'widget-draft' && ref.prefill.command === 'ui.openDetail' && validateAgentPrefill(featureId, ref.prefill.fields)
    ? ref.prefill.fields : undefined;
  const suggestion = ref.prefill?.kind === 'widget-draft' && ref.prefill.command === 'booking.propose' && row?.status === 'needs-check'
    && isTime(ref.prefill.fields.time) && !slotHasPassed(row.date, ref.prefill.fields.time) ? ref.prefill.fields.time : undefined;
  return { row, fields, suggestion };
}

const bookingWords = /예약|노쇼|방문\s*(?:완료|처리)|\b(?:booking|reservation|no-show)\b|预约|預約/u;
const otherBooking = /(?:쿠폰|발주|촬영|픽업\s*예약|지원금|납부|휴무|영상|마감|근무|결제|환불|정산)/u;
const noAction = /하지\s*마|말아\s*줘|방법|\b(?:don't|never|how to)\b/iu;
const dateWords = /(?:오늘|어제|내일|담날|모레|요일|\d+\s*(?:월\s*\d+\s*)?일(?:에|로|\s|$)|\d{1,4}[-./]\d{1,2})/u;
const openWords = /열어|띄워|화면으로|자세히|상세|보여\s*줘|\b(?:open|show)\b/iu;
const registrationWords = /(?:등록|추가|입력(?:하는)?|넣는)\s*(?:창|화면|폼|데)|(?:register|create)\s*form/iu;
const timePattern = /(?<![\p{L}\d])(?:(?:오전|오후|저녁|아침|점심|낮)\s*)?(?:\d{1,2}:\d{2}|(?:\d{1,2}|[열한두세네다섯여일곱체팔구십이삼사오육칠]+)\s*시(?!간|대)(?:\s*(?:반|\d{1,2}\s*분))?)/gu;
const partyPattern = /(?<![\p{L}\d])(?:(마이너스)\s*)?(-?\d+|[한두세네다섯여섯일곱여덟아홉열영공십이삼사오육칠팔구]+)\s*(?:명|인(?:석)?(?!원)|분(?!에))/gu;
const phonePattern = /(?:연락처|번호(?:는)?|전화번호|전화)\s*[:：]?\s*([\d\- ]+)|(?<!\d)(01[016789](?:[- ]?\d){7,8})(?!\d)/u;
const knownNamePattern = /(?:[가-힣][○●*]+[가-힣]*(?:\d{4})?|[가-힣]\s*씨)(?:님|씨)?/u;
const politeNamePattern = /(?<![가-힣])[가-힣]{2,5}(?:님|씨)(?=\s|$)/u;
const requestsMentioned = /(?:아기\s*의자|창가\s*자리)/u;
const cancelIntent = /취소|캔슬|날려/u;
const bulkIntent = /전부|모두|(?:^|\s)다(?:\s|$)|한꺼번에|한\s*번에|싹/u;
const tablePattern = /\bT(\d{1,2})\b|(\d{1,2})\s*번\s*(?:테이블|자리)/iu;

function timesIn(text: string) {
  return [...text.matchAll(timePattern)].map(match => ({
    start: match.index, end: match.index + match[0].length, raw: match[0],
    time: parseNavisTime(match[0].replace(/^저녁|^낮/u, '오후').replace(/^아침/u, '오전')
      .replace(/^점심\s*(?=12시|열두\s*시)/u, '').replace(/^점심/u, '오후')),
  }));
}
function partyIn(text: string) {
  const matches = [...text.matchAll(partyPattern)].filter(match => !/시\s*\d+\s*$/u.test(text.slice(0, match.index)));
  const value = matches.find(match => !match[0].trim().endsWith('분')) ?? matches[0];
  if (!value) return { given: false };
  const number = parseNavisNumber(value[2]);
  return { given: true, value: value[1] && number !== undefined ? -Math.abs(number) : number };
}
function phoneIn(text: string) {
  const hit = phonePattern.exec(text);
  return hit && (hit[1] ?? hit[2]).replace(/[^\d]/gu, '');
}
function tableIn(text: string) {
  const match = tablePattern.exec(text);
  return match ? `T${Number(match[1] ?? match[2])}` : undefined;
}
function guestIn(text: string) {
  const masked = knownNamePattern.exec(text)?.[0];
  if (masked) return masked.replace(/\s*(?:님|씨)$/u, '');
  const named = /(?:^|\s)([가-힣]{2,5}|[A-Za-z][A-Za-z .'-]{1,50})\s*(?:이름으로|성함으로|님(?:으로)?|씨(?:로)?|으로)(?=\s|$)/u.exec(text)?.[1];
  if (named && !/^(?:없음|내일|오늘|요청|자동|수동)$/u.test(named)) return named;
  const cleaned = text
    .replace(timePattern, ' ').replace(partyPattern, ' ').replace(phonePattern, ' ').replace(tablePattern, ' ')
    .replace(registrationWords, ' ').replace(openWords, ' ')
    .replace(/테이블\s*지정해서/u, ' ')
    .replace(/(?:\d+\s*월\s*\d+\s*일|\d{1,4}[-./]\d{1,2}(?:[-./]\d{1,2})?|(?:이번|다음|지난|저번)\s*주\s*[월화수목금토일]요일)/gu, ' ')
    .replace(/(?:오늘|어제|내일|담날|모레)(?:에|로|은|는)?|날짜로|예약(?:을|이|은)?|잡아\s*(?:줘|주세요)?|넣어\s*(?:줘|주세요)?|해\s*(?:줘|주세요)|하나|새로|추가(?:해\s*줘)?|등록(?:해\s*줘)?|부탁|손님|연락처|전화|번호|단체|오전|오후|아침|저녁|점심|이름|시간|인원|방문|완료|노쇼|취소|변경|수정|확정|자동|자리|테이블|요청사항|바꿔\s*줘|옮겨\s*줘|줄여\s*줘|미뤄\s*줘/gu, ' ');
  const words = cleaned.match(/[가-힣]{2,5}/gu)?.filter(word => !/^(?:싶어|넣고|받아줘|하나요|싶어요|있는|알려줘|얼마야|보여줘|열어줘|앞당겨)$/u.test(word)) ?? [];
  return words.length === 1 ? words[0] : undefined;
}
function knownVisitName(text: string, snapshot: DataSnapshot, locale: Locale) {
  const t = bookingTranslator(locale);
  const labels = [...new Set(visits(snapshot).map(row => rowName(row, t)))].sort((a, b) => b.length - a.length);
  return labels.find(label => nameKey(text).includes(nameKey(label)));
}
function readBookingDate(text: string, date: string) {
  const current = parseNavisDate(text.replace(/담날/gu, '내일'), date);
  if (current) return current;
  const day = /(?:^|\s)(\d{1,2})\s*일(?:에|로|쯤)?(?=\s|$)/u.exec(text)?.[1];
  const dateOnly = day && `${date.slice(0, 8)}${day.padStart(2, '0')}`;
  return !/\d+\s*월/u.test(text) && isIsoDate(dateOnly) ? dateOnly : undefined;
}
function contextualTime(candidate: ReturnType<typeof timesIn>[number] | undefined, expected: (time: string) => boolean) {
  const time = candidate?.time;
  if (!time || !candidate || /오전|오후|저녁|아침|점심|낮|:/u.test(candidate.raw)) return time;
  const hour = Number(time.slice(0, 2));
  if (hour < 1 || hour > 8) return time;
  const later = `${hour + 12}:${time.slice(3)}`;
  return !expected(time) && expected(later) ? later : time;
}
const selectedDate = (date: string): QueryCondition => ({ kind: 'dateRange', start: date, end: date });
const reservationLookup = (query: BookingQuery): { slots: LocalSlots; lookup: DomainLookup } => ({
  slots: { reservationId: encodeQuery(query) }, lookup: { kind: 'reservation', querySlot: 'reservationId', bind: ['reservationId'] },
});
const recordRead = (query: BookingQuery, locale: Locale, browse = false, querySlot = 'reservationId'): DomainTurnInput => ({
  intent: { kind: 'read', recordKind: 'reservation', querySlot },
  slots: { [querySlot]: encodeQuery(query) }, browse, onMissing: { answer: bookingTranslator(locale).t('booking.navis.missing') },
});

interface CreateFields {
  readonly date?: string;
  readonly time?: string;
  readonly partySize?: number;
  readonly name?: string;
  readonly phone?: string | null;
  readonly table?: string;
  readonly request?: string;
}
function createRoute(fields: CreateFields, snapshot: DataSnapshot, locale: Locale): DomainRoute {
  const t = bookingTranslator(locale);
  const clarify = (field: keyof CreateFields, label: string, parse: (value: string) => string | number | undefined, answer?: string): DomainRoute => ({
    kind: 'clarification', field: field === 'name' ? 'guest' : field === 'table' ? 'tableChoice' : field,
    answer: answer ?? t.t(label),
    resume(value) {
      if (field === 'name' && (!nonEmpty(value) || !/^[\p{L}○●*' .-]+$/u.test(value))) return;
      const next = parse(value);
      return next === undefined ? undefined : createRoute({ ...fields, [field]: next }, snapshot, locale);
    },
  });
  const anchor = snapshot.pos?.businessDate ?? BUSINESS_CLOCK.date;
  const readTime = (value: string) => contextualTime(timesIn(value).at(-1), time => !slotHasPassed(fields.date ?? anchor, time));
  const readParty = (value: string) => partyIn(value).value ?? parseNavisNumber(value);
  if (fields.partySize !== undefined && !positive(fields.partySize)) return clarify('partySize', 'widget.voice-booking.extParty', readParty);
  if (fields.phone !== undefined && !phoneNumber(fields.phone)) return clarify('phone', 'booking.navis.phone', value => value.replace(/[^\d]/gu, ''));
  if (!fields.name) return clarify('name', 'booking.navis.guest', value => value.trim());
  if (!fields.date || fields.date < anchor) return clarify('date', 'widget.voice-booking.extDate',
    value => readBookingDate(value, anchor), fields.date ? t.t('booking.navis.past') : undefined);
  if (!fields.time || slotHasPassed(fields.date, fields.time)) return clarify('time', 'widget.voice-booking.extTime', readTime,
    fields.time ? t.t('booking.navis.past') : undefined);
  if (!positive(fields.partySize)) return clarify('partySize', 'widget.voice-booking.extParty', readParty);
  const guest = { name: fields.name, ...(fields.phone ? { phone: fields.phone } : {}) };
  if (findBookingDuplicate(snapshot.tables, { ...fields, date: fields.date, time: fields.time, partySize: fields.partySize, guest })) {
    return { kind: 'clarification', field: 'confirm_duplicate', answer: t.t('booking.navis.duplicate') };
  }
  const lookups: DomainLookup[] = [];
  const slots = { date: fields.date, time: fields.time, partySize: fields.partySize, name: fields.name,
    ...(fields.phone ? { phone: fields.phone } : {}), ...(fields.request ? { request: fields.request } : {}) };
  const args: AgentWireArgs = { date: reference('date'), time: reference('time'), partySize: reference('partySize'),
    guest: { name: reference('name'), ...(fields.phone ? { phone: reference('phone') } : {}) },
    ...(fields.request ? { request: reference('request') } : {}), ...(!fields.table ? { tableChoice: 'auto' } : {}) };
  if (fields.table) {
    if (!tableLayoutEnabled(snapshot.tables.shopSettings)) return {
      intent: { kind: 'read', recordKind: 'table', querySlot: 'tableId' }, slots: { tableId: fields.table },
      onMissing: { reason: 'invalid_target', alternative: { featureId }, answer: t.t('booking.navis.unavailable') },
    };
    const table = tableMatches({ snapshot, locale, query: fields.table, privateLookup: true })[0];
    const allocation = table && bookingAllocation(snapshot, { date: fields.date, time: fields.time, partySize: fields.partySize, tableChoice: { tableId: table.tableId } });
    if (!allocation || allocation.status !== 'confirmed') return clarify('table', 'booking.navis.table',
      value => /자동|^auto$/iu.test(value) ? '' : tableIn(value), t.t('booking.navis.noTable'));
    lookups.push({ kind: 'table', querySlot: 'tableId', bind: ['tableChoice', 'tableId'] });
  }
  return { intent: { kind: 'command', command: 'booking.create', args, ...(fields.table ? { querySlot: 'tableId' } : {}) },
    slots: { ...slots, ...(fields.table ? { tableId: fields.table } : {}) }, lookups };
}

function mutationRoute(text: string, command: BookingType | 'booking.propose', query: BookingQuery,
  destination: { date?: string; time?: string; partySize?: number }, snapshot: DataSnapshot, locale: Locale): DomainRoute {
  const t = bookingTranslator(locale), navis = navisTranslator(locale);
  const matched = visitMatches(snapshot, query, locale);
  const exact = matched.filter(item => item.match === 'exact');
  const row = exact.length === 1 ? exact[0].row : undefined;
  const refused = (answer: string): DomainRoute => ({ kind: 'refusal', reason: 'invalid_target', answer });
  const unchanged = (): DomainRoute => ({ kind: 'answer', answer: t.t('booking.navis.unchanged') });
  const clarify = (field: string, label: string, resume?: (value: string) => DomainRoute | undefined): DomainRoute =>
    ({ kind: 'clarification', field, answer: t.t(label), resume });
  if (!matched.length) return recordRead(query, locale);
  if (row) {
    if (command === 'booking.cancel' && row.status === 'canceled' || command === 'booking.confirm' && row.status === 'confirmed') return unchanged();
    if (command === 'booking.confirm' || command === 'booking.propose') {
      if (row.status !== 'needs-check') return refused(t.t('booking.navis.closed'));
    } else if (command === 'booking.update' || command === 'booking.markCompleted' || command === 'booking.markNoShow') {
      if (['canceled', 'completed', 'no-show'].includes(row.status)) return refused(t.t('booking.navis.closed'));
      if ((command === 'booking.markCompleted' || command === 'booking.markNoShow') && !row.canMarkCompleted) return refused(navis.t('data.error.notYetTime'));
    }
  }
  const { slots: querySlots, lookup } = reservationLookup(query);
  const lookups = [lookup];
  const slots: Record<string, string | number | null> = { reservationId: String(querySlots.reservationId) };
  const bindValue = (field: string, value: string | number | null) => {
    slots[field] = value;
    return reference(field);
  };
  const args: Record<string, AgentWireArgs[string]> = {};
  if (command === 'booking.update') {
    const patch: Record<string, AgentWireArgs[string]> = {};
    const party = partyIn(text);
    const movingTime = /(?:시간|시각)\s*(?:바꾸|변경|바꿔|옮겨|수정)|(?:시(?:\s*반)?|:\d\d)\s*(?:에서|로)|(?:다시\s*잡아)/u.test(text);
    const movingDate = /(?:날짜|내일|담날|모레|어제).*(?:미뤄|옮겨|날짜)|날짜\s*(?:바꿔|변경)/u.test(text);
    const restart = (suffix: string) => routeBooking(`${text} ${suffix}`, snapshot, locale);
    if (party.given && !positive(party.value)) return clarify('partySize', 'widget.voice-booking.extParty');
    if (movingTime && !destination.time) {
      return clarify('time', 'widget.voice-booking.extTime', value => {
        const time = contextualTime(timesIn(value).at(-1), item => item >= BUSINESS_CLOCK.time);
        return time ? mutationRoute(text, command, query, { ...destination, time }, snapshot, locale) : undefined;
      });
    }
    if (movingDate && !destination.date) return clarify('date', 'widget.voice-booking.extDate', restart);
    const nextDate = destination.date ?? (row && /하루\s*뒤로/u.test(text) ? addDays(row.date, 1) : undefined);
    const changedSlot = (nextDate && nextDate !== row?.date) || (destination.time && destination.time !== row?.time);
    if (changedSlot && row && slotHasPassed(nextDate ?? row.date, destination.time ?? row.time)) {
      return clarify(nextDate && nextDate < BUSINESS_CLOCK.date ? 'date' : 'time', 'booking.navis.past');
    }
    if (destination.time && destination.time !== row?.time) patch.time = bindValue('time', destination.time);
    if (nextDate && nextDate !== row?.date) patch.date = bindValue('date', nextDate);
    if (positive(destination.partySize) && destination.partySize !== row?.partySize) patch.partySize = bindValue('partySize', destination.partySize);
    const request = /["“'‘]([^"”'’]+)["”'’]/u.exec(text)?.[1];
    if (/요청(?:사항)?/u.test(text) && (request || /지워|없애|삭제|비워|빼줘/u.test(text))) patch.request = request ? bindValue('request', request) : null;
    const phone = phoneIn(text);
    const name = /(?:이름(?:을|를)?|성함)\s+([\p{L}]{2,40}?)(?:으?로|이래)(?=\s|$)/u.exec(text)?.[1];
    if (phone !== null && !phoneNumber(phone)) return clarify('phone', 'booking.navis.phone');
    if (name || phone && row) {
      const label = name ?? (row ? rowName(row, t) : undefined);
      if (label) patch.guest = { name: bindValue('name', label), ...(phone ? { phone: bindValue('phone', phone) } : {}) };
    }
    const table = tableIn(text);
    if (table) {
      slots.tableId = table;
      lookups.push({ kind: 'table', querySlot: 'tableId', bind: ['patch', 'tableChoice', 'tableId'] });
    } else if (/자동\s*(?:배정|추천|으로)|테이블\s*지정\s*풀/u.test(text)) patch.tableChoice = 'auto';
    if (!Object.keys(patch).length && !table) {
      if (row && (destination.date || destination.time || destination.partySize)) return unchanged();
      if (matched.length > 1 && !row) {
        // Let the shared target chooser establish identity before asking which field to change.
        return { intent: { kind: 'command', command, args: {}, querySlot: 'reservationId' }, slots, lookups };
      }
      if (row) return clarify('field', 'booking.navis.title');
    }
    args.patch = patch;
  } else if (command === 'booking.propose') {
    if (!destination.time) return clarify('time', 'widget.voice-booking.extTime');
    if (row && slotHasPassed(row.date, destination.time)) return clarify('time', 'booking.navis.past');
    args.time = bindValue('time', destination.time);
  }
  return { intent: { kind: 'command', command, args, querySlot: 'reservationId' }, slots, lookups };
}

function routeBooking(input: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const text = normalizeNavisInput(input);
  if (noAction.test(text)) return;
  if (bookingWords.test(text) && cancelIntent.test(text) && bulkIntent.test(text)) return { kind: 'refusal', reason: 'unsupported' };
  if (otherBooking.test(text)) return;
  const date = snapshot.pos?.businessDate ?? BUSINESS_CLOCK.date;
  const dateText = text.replace(phonePattern, ' ');
  const day = readBookingDate(dateText, date), times = timesIn(text), party = partyIn(text);
  const phone = phoneIn(text);
  const capacity = (/자리|좌석|테이블|[0-9]인석/u.test(text) && /있어|남았|가능|괜찮|되나|될까|되나요/u.test(text)
    || party.given && /괜찮|가능하/u.test(text)) && times.length > 0;
  const attended = /(?:이미\s*온|방문\s*완료|다\s*왔|안\s*온).*(?:몇|있|왔나)/u.test(text);
  const partyQuestion = /(?:오늘|내일|담날)\s*몇\s*(?:분|명)\s*(?:오|와)/u.test(text);
  const knownPerson = knownVisitName(text, snapshot, locale) ?? (knownNamePattern.test(text) || politeNamePattern.test(text) ? guestIn(text) : undefined);
  const namedBooking = knownPerson && /통화|전화|몇\s*명|몇\s*시|요청|인원|명으로|인으로|시각|\d{1,2}\s*시|날짜|자리|테이블|확정|컨펌|노쇼|취소|연락처|번호|방문|이름|성함|시간|왔대|오지\s*않음|안\s*왔/u.test(text);
  const contactBooking = times.length > 0 && party.given && phone !== null;
  const compactBooking = times.length > 0 && party.given && (dateWords.test(dateText) || /단체|인원/u.test(text)) && guestIn(text) !== undefined;
  const bulkCancel = times.length > 0 && /(?:손님|팀).*(?:취소|캔슬)/u.test(text);
  const waitBooking = /(?:대기|확인\s*필요).*(?:확정|컨펌)/u.test(text);
  const requestQuestion = /창가\s*자리.*(?:누구|손님)|아기\s*의자.*(?:전화|예약|요청)/u.test(text);
  if (!(bookingWords.test(text) || capacity || attended || partyQuestion || namedBooking || contactBooking || compactBooking || bulkCancel || waitBooking || requestQuestion)) return;
  const t = bookingTranslator(locale);
  const name = knownPerson;
  const table = tableIn(text);
  if (capacity) {
    const time = contextualTime(times[0], item => !slotHasPassed(day ?? date, item));
    if (!time || !positive(party.value)) return { kind: 'clarification', field: time ? 'partySize' : 'time',
      answer: t.t(time ? 'widget.voice-booking.extParty' : 'widget.voice-booking.extTime') };
    if (table && !tableMatches({ snapshot, locale, query: table, privateLookup: true }).length)
      return { kind: 'clarification', field: 'tableChoice', answer: t.t('booking.navis.noTable') };
    return { intent: { kind: 'read', tool: 'check_booking_capacity' },
      slots: { date: day ?? date, time, partySize: party.value, ...(table ? { tableId: table } : {}) },
      ...(table ? { lookups: [{ kind: 'table', querySlot: 'tableId', bind: ['tableChoice'] }] } : {}),
      reading: { tool: 'check_booking_capacity', args: { date: reference('date'), time: reference('time'), partySize: reference('partySize') } },
    };
  }
  if (/통화|전화.*(?:요약|받았)|요약.*전화|아기\s*의자.*전화/u.test(text)) return recordRead({ name, ...(day ? { date: day } : {}), mode: 'call',
    ...(/아기\s*의자/u.test(text) && !name ? { request: '아기 의자' } : {}) }, locale);
  if (/케이크.*픽업.*예약/u.test(text) && /있|확인/u.test(text))
    return recordRead({ date: day ?? date, mode: 'requests', request: '케이크' }, locale, true);
  if (/요청(?:사항)?|특별\s*요청|창가\s*자리/u.test(text) && /알려|있|누구|보여/u.test(text)) {
    return recordRead({ date: day ?? date, mode: 'requests', ...(/창가\s*자리.*누구/u.test(text) ? { request: '창가' } : {}) }, locale, true);
  }
  const navigation = bookingNavigation(text, snapshot, locale);
  if (navigation) return;
  if (navigation === null) {
    const query = detailQuery(text, snapshot, locale, day, times[0]);
    if (query.name || query.time || query.partySize || query.request) return recordRead(query, locale, false, !query.name && query.time ? 'time' : 'reservationId');
  }
  const bulk = bulkIntent.test(text);
  if (cancelIntent.test(text) && bulk) return { kind: 'refusal', reason: 'unsupported' };
  const cancelAndMove = /취소.*다시\s*잡/u.test(text);
  const presentChange = /(?:바꿔|바꾸|줄여|늘려|옮겨|미뤄|고쳐|고칠|수정|변경|지워|없애|비워|빼줘|삭제|배정으로|돌려|앞당겨|늦춰|하루\s*뒤로|성함|지정\s*풀|자동\s*(?:추천|으로))/u.test(text);
  const patchEnding = /(?:명|시|:\d\d)\s*(?:으로|로)|(?:요청사항|연락처|이름)(?:을|를)?/u.test(text);
  const suggestion = /(?:다른\s*시간|\d+\s*시).*제안|제안.*(?:보내|발송)/u.test(text);
  if (!suggestion && /보내|발송|게시|전송/u.test(text)) return { kind: 'refusal', reason: 'widget_only', alternative: { featureId } };
  const command = attended ? undefined : /노쇼|오지\s*않음|안\s*온\s*걸로|안\s*나타났/u.test(text) ? 'booking.markNoShow'
    : /방문\s*(?:완료|처리)|다녀갔|도착해서|(?:손님\s*)?왔(?:어|대)(?:\s|$)/u.test(text) ? 'booking.markCompleted'
    : suggestion ? 'booking.propose'
    : cancelAndMove ? 'booking.update' : /취소|캔슬/u.test(text) ? 'booking.cancel'
    : /확정\s*(?:해|처리|$)|컨펌/u.test(text) ? 'booking.confirm'
    : presentChange || name && (patchEnding || !!table || /인원|시각|시간/u.test(text) && (party.given || times.length))
      && !/잡아|넣어|예약해/u.test(text) ? 'booking.update' : undefined;
  if ((bulk || waitBooking && !bookingWords.test(text)) && command === 'booking.confirm')
    return { intent: { kind: 'read', featureId, condition: { kind: 'default' } }, factKeys: ['booking.needsCheck.count'] };
  if (command) {
    const isUpdate = command === 'booking.update';
    const firstTime = times[0];
    const destinationTime = firstTime && (/^\s*(?:로|으로)/u.test(text.slice(firstTime.end)) || /시(?:간|각)\s*\d/u.test(text));
    const timeTarget = times.length === 1 && (command === 'booking.propose' || isUpdate && destinationTime) ? undefined : firstTime;
    const lookupDay = isUpdate && /(?:미뤄|날짜(?:를|을)?\s*.*옮겨)/u.test(text) ? undefined : day;
    const waiting = /대기|확인\s*필요/u.test(text) && command === 'booking.confirm';
    const request = /요청/u.test(text) ? requestsMentioned.exec(text)?.[0] : undefined;
    const query: BookingQuery = { name: name ?? (timeTarget || waiting || request || /취소된\s*예약/u.test(text) ? undefined : guestIn(text)),
      date: lookupDay ?? (!name && timeTarget ? date : undefined),
      time: contextualTime(timeTarget, time => visits(snapshot).some(row => row.date === (lookupDay ?? date) && row.time === time)),
      ...(request && !name ? { request } : {}),
      ...(waiting ? { mode: 'waiting' } : {}) };
    if (!query.name && !query.time && !query.request && !waiting) return /취소된\s*예약/u.test(text)
      ? recordRead({ date, status: 'canceled' }, locale) : { kind: 'clarification', field: 'reservationId', answer: t.t('booking.navis.guest') };
    const target = visitMatches(snapshot, query, locale);
    const targetTime = isUpdate && (times.length > 1 || !timeTarget || /시간\s*\d/u.test(text)) || command === 'booking.propose' ? times.at(-1) : undefined;
    const nextTime = contextualTime(targetTime, time => target.some(({ row }) => row.time === time) || !slotHasPassed(day ?? date, time));
    return mutationRoute(text, command, query, { date: isUpdate && lookupDay === undefined ? day : undefined, time: nextTime,
      partySize: isUpdate && !cancelAndMove ? party.value : undefined }, snapshot, locale);
  }
  if (name && /몇|언제|알려|보여|[?？]/u.test(text)) return recordRead({ name, date: day }, locale);
  if (/몇|있어|있나|알려|어때|다\s*왔|보여|현황|나눠|있는지|인원수/u.test(text) || partyQuestion || day && /예약\s*확인/u.test(text)) {
    if (/잡아|넣어|예약해|예약\s*부탁/u.test(text)) return;
    if (!day && dateWords.test(dateText)) return { kind: 'clarification', field: 'date', answer: t.t('widget.voice-booking.extDate') };
    const keys = /전화|AI|직접\s*입력/u.test(text) ? ['booking.source.phone', 'booking.source.direct']
      : /이미\s*온|방문\s*완료|다\s*왔|안\s*온/u.test(text) ? ['booking.completed.count', 'booking.past.confirmed']
      : /인원|몇\s*명|몇\s*분/u.test(text) && (!day || day === date) ? ['booking.people']
      : ['booking.today.count', 'booking.people'];
    return { intent: { kind: 'read', featureId, condition: day && day !== date ? selectedDate(day) : { kind: 'default' } }, factKeys: keys };
  }
  if (openWords.test(text) || /위젯|패널|메뉴/u.test(text)) return;
  if (!/잡아|넣어|넣고|예약해|부탁|등록|추가|예약\s*(?:하나|받아|ㄱ)|예약.*연락처/u.test(text) &&
    !(times.length || party.given || dateWords.test(text))) return;
  const guest = guestIn(text);
  const time = contextualTime(times[0], item => !slotHasPassed(day ?? date, item));
  const actualDate = day ?? (!dateWords.test(dateText) && contactBooking ? date : undefined);
  const invalidPhone = phone !== null ? phone : /연락처|번호(?:는)?/u.test(text) ? null : undefined;
  const request = /["“'‘]([^"”'’]+)["”'’]/u.exec(text)?.[1];
  return createRoute({ name: guest, date: actualDate, time, partySize: party.value, phone: invalidPhone, table, request }, snapshot, locale);
}

function detailQuery(text: string, snapshot: DataSnapshot, locale: Locale, date: string | undefined,
  timeEntry: ReturnType<typeof timesIn>[number] | undefined): BookingQuery {
  const anchor = snapshot.pos?.businessDate ?? BUSINESS_CLOCK.date;
  const name = knownVisitName(text, snapshot, locale) ?? (knownNamePattern.test(text) || politeNamePattern.test(text) ? guestIn(text) : undefined);
  const time = contextualTime(timeEntry, value => visits(snapshot).some(row => row.date === (date ?? anchor) && row.time === value));
  return { name, time, date: date ?? (!name && time ? anchor : undefined), partySize: partyIn(text).value,
    request: !name ? requestsMentioned.exec(text)?.[0] : undefined };
}

function bookingNavigation(text: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | null | undefined {
  if (!bookingWords.test(text) || !openWords.test(text) || noAction.test(text) || otherBooking.test(text)) return;
  if (/통화|전화|요약|요청사항|몇|인원수/u.test(text)) return null;
  const anchor = snapshot.pos?.businessDate ?? BUSINESS_CLOCK.date;
  const date = readBookingDate(text, anchor);
  const time = contextualTime(timesIn(text)[0], value => visits(snapshot).some(row => row.date === (date ?? anchor) && row.time === value));
  if (registrationWords.test(text)) {
    const party = partyIn(text).value, name = guestIn(text);
    const prefill = { ...(date ? { date } : {}), ...(time ? { time } : {}), ...(positive(party) ? { partySize: party } : {}),
      ...(name ? { guest: { name } } : {}) };
    return { args: { featureId, view: 'register', ...(Object.keys(prefill).length ? { prefill } : {}) } };
  }
  const query = detailQuery(text, snapshot, locale, date, timesIn(text)[0]);
  const targeted = query.name || query.time || query.request || query.partySize;
  const rows = targeted ? visitMatches(snapshot, query, locale).filter(item => item.match === 'exact') : [];
  if (rows.length === 1) {
    const row = rows[0].row;
    return { args: { featureId, itemId: row.reservationId, date: row.date, time: row.time },
      target: { kind: 'reservation', id: row.reservationId }, querySlot: 'reservationId' };
  }
  if (targeted) return null;
  return date ? { args: { featureId, view: 'date', date } } : undefined;
}

export const bookingDomain: DomainAdapter = {
  commands: bookingTypes.map(bookingAdapter), reads: [reservationReader, tableReader], tools: [capacityTool],
  route: routeBooking, projectWidget: projectBooking, navigation: bookingNavigation,
  handoff(command, draft) {
    if (command !== 'booking.propose' || typeof draft.reservationId !== 'string' || !isTime(draft.time)) return;
    return { featureId, itemId: draft.reservationId, focus: 'action',
      prefill: { kind: 'widget-draft', command, fields: { time: draft.time } } };
  },
};

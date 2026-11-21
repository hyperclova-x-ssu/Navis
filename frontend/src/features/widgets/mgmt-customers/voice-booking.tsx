/** 음성 예약확정 (F-34, AC-227·256·257): today's phone reservations, call summary without recording, confirm / suggest / no-show. */
import { useId, useMemo, useRef, useState } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetPanelProps } from '../../../contracts';
import { useBundle, type MessageBundle, type Translator } from '../../../i18n';
import { LEGACY_BOOKING_VIEW_TIME, TODAY, resolveDataText, dataBundles, selectMembers, selectShopSettings } from '../../../data/widget-data';
import { useDataDispatch, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { allocateReservation, selectReservations } from '../../../data/derive/reservations';
import { isIsoDate, isTime } from '../../../data/db/time';
import type { Reservation } from '../../../data/db/types';
import type { VoiceBookingModel } from '../../../data/models/types';
import { bookingDetailSeed } from '../../assistant/domains/booking';
import { ActionButton, Badge, DateField, IntegrationBadge, TimeChips, TimeField, TextField, NumberField, Textarea, DataGrid, DateStepper, DetailSidePanel, InlineForm, Table, addIsoDays, layoutTokens, renderStatusChip, type GridColumn, type GridFocus, type GridSort, type DataGridHandle } from '../../../ui';
import { customersBundle } from './messages';
import { Bars, Body, DetailState, Kpi, ListBlock, PanelFrame, Row, StatePanel, reportResult, splitUnit, useT, type BarItem } from './shared';

import { FitMiniTable, restoreGrid } from './workspace';
import { PickupReservations, PickupSummary } from '../i7-custom/pickup';
import { usePickupCount } from '../i7-custom/use-custom';

const ID = 'voice-booking' as const;
const bookingCopy: MessageBundle<string> = {id:'widget.booking.i5',en:{},'zh-Hans':{},'zh-Hant':{},ko:{'widget.voice-booking.i5.list':'예약 목록','widget.voice-booking.i5.previewPending':'이대로 저장하면 예약 대기로 들어가요','widget.voice-booking.i5.bookAnyway':'그래도 예약하기','widget.voice-booking.i5.dateTime':'예약 일시','widget.voice-booking.i5.guest':'예약자 정보','widget.voice-booking.i5.path':'경로','widget.voice-booking.i5.status':'상태','widget.voice-booking.i5.table':'테이블','widget.voice-booking.i5.auto':'자동 추천','widget.voice-booking.i5.member':'회원에서 찾기','widget.voice-booking.i5.direct':'이름으로 예약','widget.voice-booking.i5.editParty':'인원','widget.voice-booking.i5.editTime':'시각','widget.voice-booking.i5.editSave':'예약 고치기','widget.voice-booking.i5.noTable':'맞는 테이블이 없어요','widget.voice-booking.i5.over':'좌석 {n}석을 넘어요','widget.voice-booking.i5.confirmed':'예약 확정','widget.voice-booking.i5.pending':'예약 대기','widget.voice-booking.i5.completed':'방문 완료','widget.voice-booking.i5.canceled':'취소','widget.voice-booking.i5.noShow':'오지 않음','widget.voice-booking.i5.proposed':'제안함','widget.voice-booking.i5.seats':'좌석 여유 {n}석','widget.voice-booking.i5.tables':'빈 테이블 {n}개','widget.voice-booking.i5.waiting':'대기 {count}건','widget.voice-booking.i5.waitingLabel':'예약 대기','widget.voice-booking.i5.add':'예약 추가하기','widget.voice-booking.i5.name':'예약자 이름','widget.voice-booking.i5.phone':'연락처','widget.voice-booking.i5.date':'예약 날짜','widget.voice-booking.i5.time':'예약 시각','widget.voice-booking.i5.party':'예약 인원','widget.voice-booking.i5.request':'요청사항','widget.voice-booking.i5.save':'저장하기','widget.voice-booking.i5.close':'닫기','widget.voice-booking.i5.cancel':'예약 취소하기','widget.voice-booking.i5.complete':'방문 완료로 바꾸기','widget.voice-booking.i5.noShowAction':'오지 않음으로 바꾸기','widget.voice-booking.i5.editSaveAction':'예약 저장하기','widget.voice-booking.i5.editAnyway':'그래도 저장하기','widget.voice-booking.i5.kind':'종류','widget.voice-booking.i5.visitKind':'방문 예약','widget.voice-booking.i5.check':'확인할 점','widget.voice-booking.i5.dayTotalToday':'오늘 예약','widget.voice-booking.i5.dayTotal':'이 날 예약','widget.voice-booking.i5.emptyToday':'오늘 예약이 없어요','widget.voice-booking.i5.emptyDay':'이 날은 예약이 없어요','widget.voice-booking.i5.summary':'예약 현황','widget.voice-booking.i5.error.guestName':'예약자 이름을 넣어 주세요','widget.voice-booking.i5.error.guestPhone':'연락처를 숫자 10~11자리로 넣어 주세요','widget.voice-booking.i5.statusCount':'{label} {count}건','widget.voice-booking.i5.unitParty':'명'}};

const countText = (t: Translator, n: number): string => t.t('widget.voice-booking.bookingCount', { n });
const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clock = (total: number): string => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
/** Up to three later times, 30 minutes apart, for ‘다른 시간 제안’. */
export const proposalTimes = (time: string): string[] => [30, 60, 90].map((add) => clock(Math.min(minutes(time) + add, 23 * 60 + 30)));

type Slot = VoiceBookingModel['slots'][number];
const slotValue = (t: Translator, s: Slot): string => t.t('widget.voice-booking.slotValue', { count: s.count, people: s.people });
const seatNote = (t: Translator, s: Slot): string => (s.seatsFree < 0 ? t.t('widget.voice-booking.seatsOver', { n: -s.seatsFree }) : t.t('widget.voice-booking.seatsFree', { n: s.seatsFree }));
/** The slots from one hour before “now” on (the 14:30 table is still at the café at 15:00). */
export const upcomingSlots = (slots: readonly Slot[]): Slot[] => slots.filter((s) => minutes(s.time) >= minutes(LEGACY_BOOKING_VIEW_TIME) - 60);

export function useVoiceBookingSummary({ condition }: { featureId: string; condition: QueryCondition }): string {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const i5 = useBundle(bookingCopy);
  const pickups = usePickupCount(TODAY);
  if (view.status !== 'ready') return t.t(view.messageKey);
  return `${t.t('widget.voice-booking.today')} ${countText(t, view.model.todayCount)}, ${t.locale === 'ko' ? i5.t('widget.voice-booking.i5.waiting', { count: view.model.needsCheckCount }) : t.t('widget.voice-booking.needsReview', { count: view.model.needsCheckCount })}${pickups === null ? '' : ` · 픽업 ${pickups}건`}`;
}

export function VoiceBookingPanel(props: WidgetPanelProps) {
  const t = useT();
  const view = useWidgetView(ID, props.condition);
  const store = useWidgetDataStore();
  const i5 = useBundle(bookingCopy);
  if (view.status !== 'ready') return <StatePanel id={ID} view={view} t={t} props={props} />;
  const m = view.model;
  const availability = selectReservations(store.getSnapshot(), { date: m.date, variant: view.variant }).availability;
  const { value, unit } = splitUnit(countText(t, m.todayCount), t.format.number(m.todayCount));
  const next = upcomingSlots(m.slots);
  const needs = m.reservations.filter((r) => r.status === 'needs-check');
  const list = props.width >= 2 && props.height === 1
    ? (
      <ListBlock id={ID} title={t.t('widget.voice-booking.nextBookings')}>
        {(props.width>=3?m.slots:next.slice(0,2)).map((s) => <Row key={s.time} id={ID} rowId={s.time} name={t.format.time(s.time)} value={slotValue(t, s)} />)}
      </ListBlock>
    )
    : (
      <ListBlock id={ID} title={t.t('widget.voice-booking.byTime')}>
        {m.slots.map((s) => <Row key={s.time} id={ID} rowId={s.time} name={t.format.time(s.time)} value={slotValue(t, s)} note={s.seatsFree < 0 ? seatNote(t, s) : undefined} />)}
        <Row id={ID} rowId="availability" name={<span lang="ko">{i5.t(availability.kind === 'tables' ? 'widget.voice-booking.i5.tables' : 'widget.voice-booking.i5.seats', { n: availability.value })}</span>} drop={8} />
        {needs.map((r) => <Row key={r.reservationId} id={ID} rowId={r.reservationId} name={`${t.format.time(r.time)} ${t.t(r.nameKey)}`} value={renderStatusChip(i5.t('widget.voice-booking.i5.pending'), 'waiting', 'warning')} />)}
      </ListBlock>
    );
  const bars: BarItem[] = m.slots.map((s) => ({ key: s.time, value: s.people, label: t.format.time(s.time), display: String(s.people), sub: seatNote(t, s), marker: s.seatsFree < 0 ? 'below' : null, tone: s.seatsFree < 0 ? 'b' : 'a', name: `${t.format.time(s.time)} ${slotValue(t, s)}, ${seatNote(t, s)}` }));
  return (
    <PanelFrame id={ID}>
      <Body
        props={props}
        primary={<><Kpi id={ID} label={t.t('widget.voice-booking.today')} value={value} unit={unit} longest="888" sub={i5.t('widget.voice-booking.i5.waiting', { count: m.needsCheckCount })} subLang="ko" /><PickupSummary date={m.date} /></>}
        chart={props.height === 1 ? undefined : <Bars items={bars} max={Math.max(...bars.map((b) => b.value ?? 0), 1)} label={t.t('widget.voice-booking.slotsHeading')} />}
        list={props.width>=3&&props.height>=2?<FitMiniTable rows={selectReservations(store.getSnapshot(),{date:m.date,variant:view.variant}).rows} columns={[{id:'time',label:i5.t('widget.voice-booking.i5.dateTime'),render:r=>r.time},{id:'name',label:i5.t('widget.voice-booking.i5.guest'),render:r=>typeof r.name==='string'?r.name:resolveDataText(t.t,r.name)},{id:'party',label:i5.t('widget.voice-booking.i5.party'),numeric:true,render:r=>r.partySize},{id:'table',label:i5.t('widget.voice-booking.i5.table'),render:r=>r.tableId??'—'},{id:'status',label:i5.t('widget.voice-booking.i5.status'),render:r=>i5.t(r.status==='needs-check'?'widget.voice-booking.i5.pending':r.status==='confirmed'?'widget.voice-booking.i5.confirmed':r.status==='completed'?'widget.voice-booking.i5.completed':r.status==='canceled'?'widget.voice-booking.i5.canceled':r.status==='proposed'?'widget.voice-booking.i5.proposed':'widget.voice-booking.i5.noShow')}]} getRowId={r=>r.reservationId} label={i5.t('widget.voice-booking.i5.list')} dropColumns={['name','table']}/>:list}
      />
    </PanelFrame>
  );
}

function BookingPickups({ date, host }: { date: string; host: WidgetDetailProps['host'] }) {
  const count = usePickupCount(date);
  if (count === null) return null;
  return <div className="mc-booking-pickups">
    <h3 className="mc-h3">픽업 {count}건</h3>
    <PickupReservations date={date} host={host} />
  </div>;
}

/** DS 12.1 kit `Table` (header 48, sticky): reservations and people per time. Its own wrapper scrolls when the day has many slots. */
function BookingTimeTable({ groups }: { groups: ReturnType<typeof selectReservations>['timeGroups'] }) {
  const t = useBundle(customersBundle);
  return <div className="mc-booking-time-wrap">
    <Table className="mc-booking-time">
      <caption className="mc-h3">{t.t('widget.voice-booking.byTime')}</caption>
      <colgroup><col className="mc-booking-time__time" /><col /><col /></colgroup>
      <thead><tr>
        <th scope="col">{t.t('widget.voice-booking.byTimeTime')}</th>
        <th scope="col" className="mc-booking-time__number">{t.t('widget.voice-booking.byTimeCount')}</th>
        <th scope="col" className="mc-booking-time__number">{t.t('widget.voice-booking.byTimePeople')}</th>
      </tr></thead>
      <tbody>{groups.map(group => <tr key={group.time}>
        <th scope="row">{t.format.time(group.time)}</th>
        <td className="mc-booking-time__number">{countText(t, group.count)}</td>
        <td className="mc-booking-time__number">{t.t('widget.voice-booking.party', { n: group.partyTotal })}</td>
      </tr>)}</tbody>
    </Table>
  </div>;
}

type BookingStatus = Reservation['status'];
/** DS 6.1 icon meanings: 예약 대기 ◷ (warning tone) · 예약 확정 ✓ · 제안함 ◷ (waiting for the guest) · 방문 완료·취소·오지 않음 words only. */
const statusChip = (status: BookingStatus, label: string) => status === 'needs-check' ? renderStatusChip(label, 'waiting', 'warning')
  : status === 'confirmed' ? renderStatusChip(label, 'done')
  : status === 'proposed' ? renderStatusChip(label, 'waiting')
  : renderStatusChip(label, 'none', 'neutral');

export function VoiceBookingDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const dispatch = useDataDispatch();
  const store=useWidgetDataStore(),grid=useRef<DataGridHandle>(null);
  const [entry] = useState(() => bookingDetailSeed(store.getSnapshot(), detailRef));
  const form = detailRef.view === 'register' ? entry.fields : undefined;
  const formGuest = form?.guest && typeof form.guest === 'object' ? form.guest : undefined;
  const formTable = form?.tableChoice && typeof form.tableChoice === 'object' ? form.tableChoice : undefined;
  const entryDate = entry.row?.date ?? (isIsoDate(detailRef.date) ? detailRef.date : TODAY);
  const [picked, setPicked] = useState<string | null>(detailRef.itemId ?? null);
  const editTitleId = useId();
  const [gridFocus,setGridFocus]=useState<GridFocus>(null),[gridSort,setGridSort]=useState<GridSort>({columnId:'time',direction:'asc'}),[selectedDate,setSelectedDate]=useState(entryDate),[editParty,setEditParty]=useState<number|null|undefined>(undefined),[editTime,setEditTime]=useState<string|null>(null),[editRequest,setEditRequest]=useState<string|null>(null);
  const [memberId,setMemberId]=useState(typeof form?.memberId === 'string' ? form.memberId : ''),[tableChoice,setTableChoice]=useState(formTable && 'tableId' in formTable && typeof formTable.tableId === 'string' ? formTable.tableId : 'auto'),[editDate,setEditDate]=useState<string|null>(null),[editGuest,setEditGuest]=useState<string|null>(null),[editPhone,setEditPhone]=useState<string|null>(null),[editTable,setEditTable]=useState<string|null>(null);
  const [proposing, setProposing] = useState<string | null>(entry.suggestion ? entry.row?.reservationId ?? null : null);
  const [time, setTime] = useState<string | null>(entry.suggestion ?? null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>('');
  const [adding, setAdding] = useState(detailRef.view==='register');
  const [guest, setGuest] = useState(formGuest && 'name' in formGuest && typeof formGuest.name === 'string' ? formGuest.name : '');
  const [phone, setPhone] = useState(formGuest && 'phone' in formGuest && typeof formGuest.phone === 'string' ? formGuest.phone : '');
  const [date, setDate] = useState(isIsoDate(form?.date) ? form.date : entryDate);
  const [bookingTime, setBookingTime] = useState(isTime(form?.time) ? form.time : isTime(detailRef.time) && adding ? detailRef.time : '17:00');
  const [party, setParty] = useState<number|null>(typeof form?.partySize === 'number' ? form.partySize : 1);
  const [request, setRequest] = useState(typeof form?.request === 'string' ? form.request : '');
  const [formError, setFormError] = useState(''), [askDuplicate, setAskDuplicate] = useState(false), [editError, setEditError] = useState(''), [editDuplicate, setEditDuplicate] = useState(false);
  const i5 = useBundle(bookingCopy, ...dataBundles);
  const reservations=selectReservations(store.getSnapshot(),{date:selectedDate,variant:view.variant});
  type Booking=typeof reservations.rows[number];
  const tableLayoutEnabled = reservations.tableLayoutEnabled;
  const hasWarning = reservations.rows.some(r => r.allocationWarning);
  const totalSeats = reservations.totalSeats;
  const { columns, bookingName, warning, statusText } = useMemo(() => {
    const bookingName=(r:Booking)=>typeof r.name==='string'?r.name:resolveDataText(t.t,r.name);
    const warning=(r:Booking)=>r.allocationWarning?i5.t(r.allocationWarning==='NO_MATCHING_TABLE'?'widget.voice-booking.i5.noTable':'widget.voice-booking.i5.over',{n:totalSeats}):'';
    const statusText=(r:Booking)=>i5.t(r.status==='confirmed'?'widget.voice-booking.i5.confirmed':r.status==='needs-check'?'widget.voice-booking.i5.pending':r.status==='completed'?'widget.voice-booking.i5.completed':r.status==='canceled'?'widget.voice-booking.i5.canceled':r.status==='proposed'?'widget.voice-booking.i5.proposed':'widget.voice-booking.i5.noShow');
    // DS 12.1 column widths follow the content: chips, numbers and paths keep a fixed track, the free width goes to time, guest and request.
    // Beside the side panel the columns drop in this order (the panel shows all of them): 경로 → 테이블 → 요청사항 → 확인할 점.
    const columns: GridColumn<Booking>[] = [
       {id:'kind',header:i5.t('widget.voice-booking.i5.kind'),kind:'text',minWidth:layoutTokens.targetDefault*3,fixedWidth:true,value:()=>i5.t('widget.voice-booking.i5.visitKind'),render:()=>renderStatusChip(i5.t('widget.voice-booking.i5.visitKind'),'none')},
       {id:'time',header:i5.t('widget.voice-booking.i5.dateTime'),kind:'text',value:r=>r.time,minWidth:170,sortable:true},
       {id:'guest',header:i5.t('widget.voice-booking.i5.guest'),kind:'text',value:bookingName,minWidth:170},
       {id:'party',header:i5.t('widget.voice-booking.i5.party'),kind:'number',unit:i5.t('widget.voice-booking.i5.unitParty'),value:r=>r.partySize,minWidth:140,fixedWidth:true,sortable:true},
       ...(tableLayoutEnabled?[{id:'table',header:i5.t('widget.voice-booking.i5.table'),kind:'text' as const,value:(r:Booking)=>r.tableId??'—',minWidth:110,fixedWidth:true,dropOrder:2}]:[]),
       {id:'request',header:i5.t('widget.voice-booking.i5.request'),kind:'text',value:r=>resolveDataText(t.t,r.request)||(r.requestKey?t.t(r.requestKey):''),minWidth:220,dropOrder:3},
       {id:'path',header:i5.t('widget.voice-booking.i5.path'),kind:'text',value:r=>t.t(r.source==='phone_ai'?'widget.voice-booking.sourcePhone':'widget.voice-booking.sourceDirect'),minWidth:130,fixedWidth:true,dropOrder:1},
       {id:'status',header:i5.t('widget.voice-booking.i5.status'),kind:'status',value:statusText,render:r=>statusChip(r.status,statusText(r)),minWidth:170,fixedWidth:true},
       ...(hasWarning?[{id:'check',header:i5.t('widget.voice-booking.i5.check'),kind:'status' as const,value:(r:Booking)=>warning(r),render:(r:Booking)=>warning(r)?renderStatusChip(warning(r),'warning'):null,minWidth:230,fixedWidth:true,dropOrder:4}]:[]),
      ];
    return { columns, bookingName, warning, statusText };
  }, [t, i5, tableLayoutEnabled, hasWarning, totalSeats]);
  if (view.status !== 'ready') return <div className="mc-detail" data-widget={ID}><DetailState id={ID} view={view} t={t} host={host} /></div>;
  const m = view.model;
  const selected = adding ? null : reservations.rows.find(row => row.reservationId === picked) ?? null;
  const rows = [...reservations.rows].sort((a, b) => {
    if (!gridSort) return 0;
    const order = gridSort.columnId === 'party' ? a.partySize - b.partySize : a.time.localeCompare(b.time);
    return order * (gridSort.direction === 'asc' ? 1 : -1) || a.reservationId.localeCompare(b.reservationId);
  });
  const resetEdit = () => {
    setEditParty(undefined);
    setEditTime(null);
    setEditRequest(null);
    setEditDate(null);
    setEditGuest(null);
    setEditPhone(null);
    setEditTable(null);
    setFormError('');
    setEditError('');
    setEditDuplicate(false);
  };
  const selectBooking = (id: string | null) => {
    setPicked(id);
    resetEdit();
    setProposing(null);
    setTime(null);
    setDone('');
  };
  const changeDate = (delta: number) => {
    setSelectedDate(addIsoDays(selectedDate, delta));
    selectBooking(null);
  };
  /** What `booking.create` would decide for the form's current values, shown before the owner presses save. */
  const formAllocation = (() => {
    if (!adding || !isIsoDate(date) || !isTime(bookingTime) || !Number.isInteger(party) || (party ?? 0) < 1) return null;
    const probe: Reservation = { kind: 'visit', reservationId: 'form-preview', nameKey: 'data.management.guest', requestKey: null, source: 'direct', status: 'confirmed', confirmedBy: 'auto', callId: null, proposedTime: null, variant: null, date, time: bookingTime, partySize: party! };
    const outcome = allocateReservation(store.getSnapshot().tables, probe, tableChoice === 'auto' ? 'auto' : { tableId: tableChoice });
    return outcome.allocationWarning ?? null;
  })();
  /** A refusal names the field to fix (AC-1085: the name and the number are asked for separately). */
  const refusalText = (result: { reason?: string; messageKey: string }, guestName: string) =>
    i5.t(result.reason === 'GUEST_INVALID' ? (guestName.trim() === '' ? 'widget.voice-booking.i5.error.guestName' : 'widget.voice-booking.i5.error.guestPhone') : result.messageKey);
  const submitBooking = (confirmDuplicate: boolean) => {
    const result = run({ type: 'booking.create', ...(memberId ? { memberId } : { guest: { name: guest, ...(phone ? { phone } : {}) } }), date, time: bookingTime, partySize: party ?? 0, request, tableChoice: tableChoice === 'auto' ? 'auto' : { tableId: tableChoice }, idempotencyKey: `booking-create-${crypto.randomUUID()}`, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }, true);
    if (result?.ok) { setAdding(false); setFormError(''); setAskDuplicate(false); setPicked(null); setSelectedDate(date); }
    else if (result && !result.ok) { setFormError(refusalText(result, guest)); setAskDuplicate(result.reason === 'BOOKING_DUPLICATE'); }
  };
  const call = selected?.callId ? m.calls.find((c) => c.callId === selected.callId) ?? null : null;
  /** Success notices say what was done (ko). `inline` keeps a refusal in the form that caused it instead of also raising a toast. */
  const noticeKeys: Readonly<Record<string, string>> = { 'booking.cancel': 'data.management.notice.bookingCanceled', 'booking.markNoShow': 'data.management.notice.bookingNoShow', 'booking.markCompleted': 'data.management.notice.visitCompleted', 'booking.create': 'data.management.notice.bookingAdded', 'booking.update': 'data.management.notice.bookingEdited', 'booking.confirm': 'data.management.notice.bookingConfirmed' };
  const run = (command: Parameters<typeof dispatch>[0], inline = false) => {
    if (busy) return;
    setBusy(true);
    const result = dispatch(command);
    const noticeKey = t.locale === 'ko' ? noticeKeys[command.type] : undefined;
    if (result.ok && noticeKey) { host.notify({kind:'success',messageKey:noticeKey,...(result.undoToken?{undoToken:result.undoToken}:{})}); setDone(i5.t(noticeKey)); }
    else if (inline && !result.ok) { /* the form shows it */ }
    else if (reportResult(host, result) && result.ok && result.noticeKey) setDone(t.t(result.noticeKey, result.params));
    setBusy(false);
    return result;
  };
  const submitEdit = (confirmDuplicate: boolean) => {
    if (!selected) return;
    const result = run({
      type: 'booking.update',
      reservationId: selected.reservationId,
      patch: {
        partySize: editParty === undefined ? selected.partySize : editParty ?? 0,
        time: editTime ?? selected.time,
        ...(editDate !== null ? { date: editDate } : {}),
        ...(editGuest !== null || editPhone !== null ? { guest: { name: editGuest ?? bookingName(selected), ...(editPhone ? { phone: editPhone } : {}) } } : {}),
        // Only a typed request is sent: an untouched request (or seeded request key) stays as it is, and a cleared one clears both.
        ...(editRequest !== null ? { request: editRequest } : {}),
        ...(editTable !== null ? { tableChoice: editTable === 'auto' ? 'auto' : { tableId: editTable } } : {}),
      },
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
    }, true);
    if (result?.ok) {
      if (editDate) setSelectedDate(editDate);
      resetEdit();
    } else if (result) { setEditError(refusalText(result, editGuest ?? bookingName(selected))); setEditDuplicate(result.reason === 'BOOKING_DUPLICATE'); }
  };
  const detail = selected ? (
    <div className="mc-booking" data-slot={`${ID}.card`}>
      <div className="mc-badges">
        <Badge>{t.t('widget.voice-booking.party', { n: selected.partySize })}</Badge>
        {statusChip(selected.status, statusText(selected))}
        <Badge>{t.t(selected.source === 'phone_ai' ? 'widget.voice-booking.sourcePhone' : 'widget.voice-booking.sourceDirect')}</Badge>
        {selected.confirmedBy ? <Badge>{t.t(selected.confirmedBy === 'auto' ? 'widget.voice-booking.autoConfirmed' : 'widget.voice-booking.personConfirmed')}</Badge> : null}
        {selected.proposedTime ? <Badge>{t.t('widget.voice-booking.proposedAt', { time: t.format.time(selected.proposedTime) })}</Badge> : null}
      </div>
      {resolveDataText(t.t, selected.request) || selected.requestKey ? <p>{t.t('widget.voice-booking.extRequest')}: {resolveDataText(t.t, selected.request) || t.t(selected.requestKey!)}</p> : null}
      {selected.allocationWarning ? <p className="mc-flag"><span aria-hidden="true">△ </span>{warning(selected)}</p> : null}
      <form className="mc-booking-edit" aria-labelledby={editTitleId} onSubmit={event => { event.preventDefault(); submitEdit(false); }}>
        <h4 className="mc-h3" id={editTitleId}>{i5.t('widget.voice-booking.i5.editSave')}</h4>
        <div className="mc-booking-edit__fields">
          <TextField label={i5.t('widget.voice-booking.i5.name')} value={editGuest ?? bookingName(selected)} onValueChange={setEditGuest} />
          <TextField label={i5.t('widget.voice-booking.i5.phone')} value={editPhone ?? ''} hint={resolveDataText(t.t, selected.phone)} onValueChange={setEditPhone} />
          <DateField label={i5.t('widget.voice-booking.i5.date')} value={editDate ?? selected.date} today={TODAY} onValueChange={value => setEditDate(value)} />
          <NumberField label={i5.t('widget.voice-booking.i5.editParty')} value={editParty === undefined ? selected.partySize : editParty} onValueChange={setEditParty} />
          <TimeField label={i5.t('widget.voice-booking.i5.editTime')} value={editTime ?? selected.time} onValueChange={value => setEditTime(value)} />
          <Textarea label={i5.t('widget.voice-booking.i5.request')} value={editRequest ?? resolveDataText(t.t, selected.request)} onValueChange={setEditRequest} />
          {tableLayoutEnabled && <label className="ui-field">{i5.t('widget.voice-booking.i5.table')}
            <select className="ui-text-input" value={editTable ?? (selected.assignmentMode === 'manual' ? selected.tableId ?? 'auto' : 'auto')} onChange={event => setEditTable(event.target.value)}>
              <option value="auto">{i5.t('widget.voice-booking.i5.auto')}</option>
              {selectShopSettings(store.getSnapshot()).tableLayout?.tables.map(table => <option key={table.tableId} value={table.tableId}>T{table.number} · {table.seats}석</option>)}
            </select>
          </label>}
        </div>
        {editError && <p role="alert">{editError}</p>}
        <div className="mc-actions">
          <ActionButton type="submit" disabled={busy}>{i5.t('widget.voice-booking.i5.editSaveAction')}</ActionButton>
          {editDuplicate ? <ActionButton variant="secondary" disabled={busy} onClick={() => submitEdit(true)}>{i5.t('widget.voice-booking.i5.editAnyway')}</ActionButton> : null}
        </div>
      </form>
      <div className="mc-actions">
        {selected.canConfirm ? <ActionButton variant="secondary" disabled={busy} aria-label={t.t('widget.voice-booking.confirmFor', { name: bookingName(selected), time: t.format.time(selected.time) })} onClick={() => { run({ type: 'booking.confirm', reservationId: selected.reservationId }); }}>{t.t('common.confirm')}</ActionButton> : null}
        {selected.canPropose ? <ActionButton variant="secondary" aria-expanded={proposing === selected.reservationId} aria-label={t.t('widget.voice-booking.proposeFor', { name: bookingName(selected), time: t.format.time(selected.time) })} onClick={() => { setProposing(selected.reservationId); setTime(null); }}>{t.t('common.suggestOtherTime')}</ActionButton> : null}
        {selected.canMarkNoShow ? <ActionButton variant="secondary" onClick={() => run({ type:'booking.markCompleted', reservationId:selected.reservationId })}>{i5.t('widget.voice-booking.i5.complete')}</ActionButton> : null}
        {selected.status === 'confirmed' ? <ActionButton variant="secondary" disabled={!selected.canMarkNoShow || busy} aria-label={t.t('widget.voice-booking.noShowFor', { name: bookingName(selected), time: t.format.time(selected.time) })} onClick={() => { run({ type: 'booking.markNoShow', reservationId: selected.reservationId }); }}>{i5.t('widget.voice-booking.i5.noShowAction')}</ActionButton> : null}
      </div>
      {selected.status === 'confirmed' && !selected.canMarkNoShow ? <p className="mc-caption">{t.t('data.error.notYetTime')}</p> : null}
      {proposing === selected.reservationId && selected.canPropose ? (
        <div className="mc-propose">
          <h4 className="mc-h3">{t.t('widget.voice-booking.proposeTitle')}</h4>
          <TimeChips times={[...new Set([...proposalTimes(selected.time), ...(entry.suggestion ? [entry.suggestion] : [])])].sort()} value={time} onChange={setTime} label={t.t('widget.voice-booking.proposeChips')} />
          <div className="mc-actions">
            <ActionButton variant="secondary" disabled={!time || busy} onClick={() => { if (time) { const result = run({ type: 'booking.propose', reservationId: selected.reservationId, time }); if (result?.ok) setProposing(null); } }}>{t.t('common.sendSuggestion')}</ActionButton>
            <ActionButton variant="ghost" onClick={() => setProposing(null)}>{t.t('common.close')}</ActionButton>
          </div>
        </div>
      ) : null}
      <p className="mc-done" role="status" aria-live="polite">{done}</p>
      <section className="mc-call" aria-label={t.t('widget.voice-booking.callTitle')}>
        <h4 className="mc-h3">{t.t('widget.voice-booking.callTitle')}</h4>
        {call ? (
          <>
            <IntegrationBadge label={t.t('widget.voice-booking.callConnected')} state={m.connected ? 'connected' : 'needed'} />
            <p className="mc-call__summary">{resolveDataText((key, params) => t.t(key, params), call.summary)}</p>
            <dl className="mc-extracted" aria-label={t.t('widget.voice-booking.extracted')}>
              <div><dt>{t.t('widget.voice-booking.extDate')}</dt><dd>{t.format.date(call.extracted.date, 'short')}</dd></div>
              <div><dt>{t.t('widget.voice-booking.extTime')}</dt><dd>{t.format.time(call.extracted.time)}</dd></div>
              <div><dt>{t.t('widget.voice-booking.extParty')}</dt><dd>{t.t('widget.voice-booking.party', { n: call.extracted.party })}</dd></div>
              <div><dt>{t.t('widget.voice-booking.extRequest')}</dt><dd>{call.extracted.requestKey ? t.t(call.extracted.requestKey) : t.t('widget.voice-booking.noRequest')}</dd></div>
            </dl>
            <p className="mc-caption">{t.t('widget.voice-booking.noRecording')}</p>
          </>
        ) : <p className="mc-caption">{t.t('widget.voice-booking.noCall')}</p>}
      </section>
    </div>
  ) : null;
  // DS 12.2: the destructive action is the last item of the panel body (nothing after it).
  const danger = selected && selected.status !== 'canceled'
    ? <ActionButton variant="ghost" disabled={busy} onClick={() => run({ type:'booking.cancel', reservationId:selected.reservationId })}>{i5.t('widget.voice-booking.i5.cancel')}</ActionButton>
    : undefined;
  /** Count chips (read only), 예약 대기 first: the same words and icons as the status cells. */
  const statusCounts = (['needs-check', 'confirmed', 'completed', 'canceled', 'no-show', 'proposed'] as const)
    .map(status => ({ status, count: reservations.rows.filter(r => r.status === status).length }))
    .filter(({ status, count }) => count > 0 || ['needs-check', 'confirmed', 'completed', 'canceled'].includes(status));
  const labelOf = (status: BookingStatus) => i5.t(status === 'confirmed' ? 'widget.voice-booking.i5.confirmed' : status === 'needs-check' ? 'widget.voice-booking.i5.pending' : status === 'completed' ? 'widget.voice-booking.i5.completed' : status === 'canceled' ? 'widget.voice-booking.i5.canceled' : status === 'proposed' ? 'widget.voice-booking.i5.proposed' : 'widget.voice-booking.i5.noShow');
  const isToday = selectedDate === TODAY;
  const openAdd = () => { selectBooking(null); setDate(selectedDate); setAdding(true); };
  return (
    <div className="mc-detail mc-workspace" data-widget={ID} data-adding={adding || undefined} lang="ko">
      <div className="mc-tools mc-booking-toolbar">
        <DateStepper text={t.format.date(selectedDate,'long')} onPrevious={()=>changeDate(-1)} onNext={()=>changeDate(1)}/>
        <ActionButton variant="secondary" onClick={openAdd}>{i5.t('widget.voice-booking.i5.add')}</ActionButton>
      </div>
      {adding ? <InlineForm title={i5.t('widget.voice-booking.i5.add')} saveLabel={i5.t('widget.voice-booking.i5.save')} onClose={()=>setAdding(false)} onSave={()=>submitBooking(false)}>
        <div className="mc-booking-add">
          <label className="ui-field">{i5.t('widget.voice-booking.i5.member')}<select className="ui-text-input" value={memberId} onChange={e=>setMemberId(e.target.value)}><option value="">{i5.t('widget.voice-booking.i5.direct')}</option>{selectMembers(store.getSnapshot(),{}).rows.map(r=><option key={r.memberId} value={r.memberId}>{typeof r.name==='string'?r.name:resolveDataText(t.t,r.name)} · {r.phone}</option>)}</select></label>
          {!memberId ? <><TextField label={i5.t('widget.voice-booking.i5.name')} value={guest} onValueChange={setGuest}/><TextField label={i5.t('widget.voice-booking.i5.phone')} value={phone} onValueChange={setPhone}/></> : null}
          <DateField label={i5.t('widget.voice-booking.i5.date')} value={date} today={TODAY} onValueChange={value=>setDate(value ?? selectedDate)}/>
          <TimeField label={i5.t('widget.voice-booking.i5.time')} value={bookingTime} onValueChange={value=>setBookingTime(value ?? bookingTime)}/>
          <NumberField label={i5.t('widget.voice-booking.i5.party')} value={party} onValueChange={setParty}/>
          {reservations.tableLayoutEnabled ? <label className="ui-field">{i5.t('widget.voice-booking.i5.table')}<select className="ui-text-input" value={tableChoice} onChange={e=>setTableChoice(e.target.value)}><option value="auto">{i5.t('widget.voice-booking.i5.auto')}</option>{selectShopSettings(store.getSnapshot()).tableLayout?.tables.map(table=><option key={table.tableId} value={table.tableId}>T{table.number} · {table.seats}석</option>)}</select></label> : null}
          <Textarea label={i5.t('widget.voice-booking.i5.request')} value={request} onValueChange={setRequest}/>
        </div>
        {formAllocation ? <p className="mc-flag" role="status" data-slot="voice-booking.allocationPreview"><span aria-hidden="true">△ </span>{i5.t(formAllocation==='NO_MATCHING_TABLE'?'widget.voice-booking.i5.noTable':'widget.voice-booking.i5.over',{n:totalSeats})} · {i5.t('widget.voice-booking.i5.previewPending')}</p> : null}
        {formError ? <p role="alert">{formError}</p> : null}
        {askDuplicate ? <div><ActionButton variant="secondary" onClick={()=>submitBooking(true)}>{i5.t('widget.voice-booking.i5.bookAnyway')}</ActionButton></div> : null}
      </InlineForm> : <>
        <section className="mc-booking-summary" aria-label={i5.t('widget.voice-booking.i5.summary')}>
          <p className="mc-booking-summary__total"><span>{i5.t(isToday ? 'widget.voice-booking.i5.dayTotalToday' : 'widget.voice-booking.i5.dayTotal')}</span> <strong data-slot={`${ID}.metric.value`}>{countText(t, reservations.count)}</strong></p>
          <ul className="mc-booking-summary__chips">{statusCounts.map(({ status, count }) => <li key={status}>{statusChip(status, i5.t('widget.voice-booking.i5.statusCount', { label: labelOf(status), count }))}</li>)}</ul>
          <p className="mc-booking-summary__free">{i5.t(reservations.availability.kind === 'tables' ? 'widget.voice-booking.i5.tables' : 'widget.voice-booking.i5.seats', { n: reservations.availability.value })}</p>
        </section>
        <div className="mc-booking-band">
          <BookingTimeTable groups={reservations.timeGroups} />
          <BookingPickups date={selectedDate} host={host} />
        </div>
      </>}
      <DataGrid
        id="booking-grid" label={i5.t('widget.voice-booking.i5.list')} rows={rows} columns={columns}
        getRowId={row => row.reservationId} getRowLabel={row => `${bookingName(row)}, ${row.time}`}
        sort={gridSort} onSortChange={setGridSort} selectedRowId={selected?.reservationId ?? null} onSelectionChange={selectBooking}
        expandedRowIds={new Set()} focus={gridFocus} onFocusChange={setGridFocus} ref={grid}
        emptyContent={<div className="mc-booking-empty"><p>{i5.t(isToday ? 'widget.voice-booking.i5.emptyToday' : 'widget.voice-booking.i5.emptyDay')}</p><ActionButton variant="secondary" onClick={openAdd}>{i5.t('widget.voice-booking.i5.add')}</ActionButton></div>}
      />
      <DetailSidePanel
        open={!!selected}
        selectedRowId={selected?.reservationId ?? null}
        title={selected ? `${t.format.time(selected.time)} · ${bookingName(selected)}` : ''}
        onClose={() => selectBooking(null)}
        returnFocusKey={selected?.reservationId ?? ''}
        onRestoreFocus={id => restoreGrid(grid, id, 'guest', rows.map(row => row.reservationId))}
        danger={danger}
      >
        {detail}
      </DetailSidePanel>
    </div>
  );
}

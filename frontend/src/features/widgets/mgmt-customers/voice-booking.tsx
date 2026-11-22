/** 음성 예약확정 (F-34, AC-227·256·257): today's phone reservations, confirm / suggest / no-show. SmartCall is shown as daily aggregates only (AC-1600): no call content exists. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetPanelProps } from '../../../contracts';
import { useBundle, type MessageBundle, type Translator } from '../../../i18n';
import { LEGACY_BOOKING_VIEW_TIME, TODAY, resolveDataText, dataBundles, selectMembers, selectShopSettings } from '../../../data/widget-data';
import { useDomainState, useRealRetry, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { commandFailureText } from '../../../data/commands/failure-copy';
import { allocateReservation, selectReservations } from '../../../data/derive/reservations';
import { isIsoDate, isTime } from '../../../data/db/time';
import type { DataSnapshot, Reservation } from '../../../data/db/types';
import { UUID, naverRules, type BookingMeta, type BookingProductDto, type CallDayDto } from '../../../data/reality/06/dto';
import { bookingCancelCopy } from '../../../data/reality/06/messages';
import { notifySuccess, useBookingCommand } from './voice-booking.commands';
import './booking-cancel.css';
import type { VoiceBookingModel } from '../../../data/models/types';
import { bookingDetailSeed } from '../../assistant/domains/booking';
import { ActionButton, Badge, DateField, RadioGroup, TimeChips, TimeField, TextField, NumberField, Textarea, DataGrid, DateStepper, DetailSidePanel, InlineForm, Table, addIsoDays, layoutTokens, renderStatusChip, type GridColumn, type GridFocus, type GridSort, type DataGridHandle } from '../../../ui';
import { customersBundle } from './messages';
import { Bars, Body, DetailState, Kpi, ListBlock, PanelFrame, Row, StatePanel, reportResult, splitUnit, useT, type BarItem } from './shared';

import { FitMiniTable, restoreGrid } from './workspace';
import { PickupReservations, PickupSummary } from '../i7-custom/pickup';
import { usePickupCount } from '../i7-custom/use-custom';
import { kstLocal } from '../../../data/reality/02/clock';

const ID = 'voice-booking' as const;
const bookingCopy: MessageBundle<string> = {id:'widget.booking.i5',en:{},'zh-Hans':{},'zh-Hant':{},ko:{'widget.voice-booking.i5.list':'예약 목록','widget.voice-booking.i5.previewPending':'이대로 저장하면 예약 대기로 들어가요','widget.voice-booking.i5.bookAnyway':'그래도 예약하기','widget.voice-booking.i5.dateTime':'예약 일시','widget.voice-booking.i5.guest':'예약자 정보','widget.voice-booking.i5.path':'경로','widget.voice-booking.i5.status':'상태','widget.voice-booking.i5.table':'테이블','widget.voice-booking.i5.auto':'자동 추천','widget.voice-booking.i5.member':'회원에서 찾기','widget.voice-booking.i5.direct':'이름으로 예약','widget.voice-booking.i5.editParty':'인원','widget.voice-booking.i5.editTime':'시각','widget.voice-booking.i5.editSave':'예약 고치기','widget.voice-booking.i5.noTable':'맞는 테이블이 없어요','widget.voice-booking.i5.over':'좌석 {n}석을 넘어요','widget.voice-booking.i5.confirmed':'예약 확정','widget.voice-booking.i5.pending':'예약 대기','widget.voice-booking.i5.completed':'방문 완료','widget.voice-booking.i5.canceled':'취소','widget.voice-booking.i5.noShow':'오지 않음','widget.voice-booking.i5.proposed':'제안함','widget.voice-booking.i5.seats':'좌석 여유 {n}석','widget.voice-booking.i5.tables':'빈 테이블 {n}개','widget.voice-booking.i5.waiting':'대기 {count}건','widget.voice-booking.i5.waitingLabel':'예약 대기','widget.voice-booking.i5.add':'예약 추가하기','widget.voice-booking.i5.name':'예약자 이름','widget.voice-booking.i5.phone':'연락처','widget.voice-booking.i5.date':'예약 날짜','widget.voice-booking.i5.time':'예약 시각','widget.voice-booking.i5.party':'예약 인원','widget.voice-booking.i5.request':'요청사항','widget.voice-booking.i5.save':'저장하기','widget.voice-booking.i5.close':'닫기','widget.voice-booking.i5.cancel':'예약 취소하기','widget.voice-booking.i5.complete':'방문 완료로 바꾸기','widget.voice-booking.i5.noShowAction':'오지 않음으로 바꾸기','widget.voice-booking.i5.editSaveAction':'예약 저장하기','widget.voice-booking.i5.editAnyway':'그래도 저장하기','widget.voice-booking.i5.kind':'종류','widget.voice-booking.i5.visitKind':'방문 예약','widget.voice-booking.i5.check':'확인할 점','widget.voice-booking.i5.dayTotalToday':'오늘 예약','widget.voice-booking.i5.dayTotal':'이 날 예약','widget.voice-booking.i5.emptyToday':'오늘 예약이 없어요','widget.voice-booking.i5.emptyDay':'이 날은 예약이 없어요','widget.voice-booking.i5.summary':'예약 현황','widget.voice-booking.i5.error.guestName':'예약자 이름을 넣어 주세요','widget.voice-booking.i5.error.guestPhone':'연락처를 숫자 10~11자리로 넣어 주세요','widget.voice-booking.i5.statusCount':'{label} {count}건','widget.voice-booking.i5.unitParty':'명'}};

/** REAL-PLAN F06 (D-347 PN02·PN08, AC-1596·1597·1600·1602·1608): the words of NAVER bookings, phone requests, the Npay lock, NAVER cancel terms and SmartCall aggregates. Used only over HTTP. */
const realCopy: MessageBundle<string> = { id: 'widget.booking.real', en: {}, 'zh-Hans': {}, 'zh-Hant': {}, ko: {
  'widget.voice-booking.real.search': '예약 찾기', 'widget.voice-booking.real.searchHint': '예약번호·이름·연락처·날짜·상태',
  'widget.voice-booking.real.number': '예약번호', 'widget.voice-booking.real.product': '상품', 'widget.voice-booking.real.npay': 'Npay', 'widget.voice-booking.real.npayLinked': 'Npay 결제',
  'widget.voice-booking.real.pathNaver': '네이버 예약', 'widget.voice-booking.real.pathCall': '전화 예약 요청', 'widget.voice-booking.real.partyUnknown': '인원 정보 없음',
  'widget.voice-booking.real.export': '네이버 예약 엑셀 내보내기', 'widget.voice-booking.real.exportNote': '네이버 사장님 메뉴에서 내려받아요 · 연락처는 가려지고 최대 5,000행이에요 · 홍보나 회원과 합치지 않아요',
  'widget.voice-booking.real.npayLocked': 'Npay로 결제한 예약은 앱에서 바꿀 수 없어요',
  'widget.voice-booking.real.naverEdit': '이용 일시 바꾸기', 'widget.voice-booking.real.naverOnly': '네이버 예약은 이용 일시만 고칠 수 있어요',
  'widget.voice-booking.real.candidate': '전화로 받은 예약 요청', 'widget.voice-booking.real.candidateAt': '받은 시각', 'widget.voice-booking.real.candidateNote': '확정하기를 눌러야 예약이 돼요',
  'widget.voice-booking.real.decline': '요청 거절하기', 'widget.voice-booking.real.declineAsk': '이 전화 예약 요청을 거절할까요?', 'widget.voice-booking.real.declineYes': '네, 거절할게요',
  'widget.voice-booking.real.declined': '전화 예약 요청을 거절했어요', 'widget.voice-booking.real.proposedRecorded': '다른 시간 제안을 기록했어요',
  'widget.voice-booking.real.cancelAsk': '이 예약을 취소할까요?', 'widget.voice-booking.real.cancelYes': '네, 취소할게요', 'widget.voice-booking.real.keep': '그대로 두기',
  // The NAVER cancel flow (reason, refund terms, the second confirmation, its result and refusals) is in `data/reality/06/messages.ts` in four languages.
  'widget.voice-booking.real.providerPending': '이 예약의 이전 요청이 아직 처리 중이에요. 잠시 뒤 다시 눌러 주세요',
  'widget.voice-booking.real.providerUnavailable': '지금은 네이버 예약에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요',
  // SmartCall: daily aggregates of a period, nothing per call (no recording, summary or number exists).
  'widget.voice-booking.real.calls': '스마트콜 통화', 'widget.voice-booking.real.callsSource': '스마트콜', 'widget.voice-booking.real.callsTotal': '통화 {total}건 · 부재중 {missed}건',
  'widget.voice-booking.real.callsRange': '{start} ~ {end}', 'widget.voice-booking.real.callsNote': '하루 단위 집계만 보여요. 통화 내용은 없어요',
  'widget.voice-booking.real.callDate': '날짜', 'widget.voice-booking.real.callTotal': '전체', 'widget.voice-booking.real.callConnected': '연결', 'widget.voice-booking.real.callArs': 'ARS',
  'widget.voice-booking.real.callMissed': '부재중', 'widget.voice-booking.real.callBusy': '통화 중', 'widget.voice-booking.real.callAverage': '평균 통화', 'widget.voice-booking.real.callTen': '10초 이상', 'widget.voice-booking.real.seconds': '{n}초',
  'widget.voice-booking.real.products': '예약 상품',
  'widget.voice-booking.real.partial': '일부 정보를 불러오지 못했어요',
  'widget.voice-booking.real.naverPartial': '네이버 예약 일부를 불러오지 못했어요. 보이는 예약이 전부가 아닐 수 있어요', 'widget.voice-booking.real.naverUnavailable': '지금은 네이버 예약을 불러올 수 없어요. 보이는 예약에 네이버 예약은 없어요',
} };

/**
 * While a NAVER cancel step is open, Esc steps back inside it first (confirmation → input → closed) instead of dismissing the whole side panel: the grid's document-level
 * Escape handler (`registerGridLayer`) takes the key unless it was already handled, so this runs earlier, in the window's capture phase. It renders nothing.
 */
function EscapeStep({ onEscape }: { onEscape: () => void }) {
  const latest = useRef(onEscape);
  useEffect(() => { latest.current = onEscape; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return null;
}

/** The refund option the owner picked in a NAVER cancel; `''` is "none yet" (money is on the line, so nothing is pre-selected) and keeps the radio group controlled. */
type RefundPick = '' | 'full' | 'rate' | 'amount';

const countText = (t: Translator, n: number): string => t.t('widget.voice-booking.bookingCount', { n });
/** The facts the booking API adds to a row (NAVER booking number, product, Npay, candidate), by reservation id. Absent in fixture mode. */
const metaOf = (snapshot: DataSnapshot, id: string): BookingMeta | undefined => snapshot.tables.realBooking?.meta[id];
/** The table the owner reads: the POS label over HTTP, the layout id in the fixture, and never the service's table UUID. */
const tableText = (meta: BookingMeta | undefined, tableId: string | null | undefined): string => meta?.tableLabel ?? (tableId && !UUID.test(tableId) ? tableId : '—');
/** 'https://help.naver.com/…' — the owner's own export menu; the app never downloads or reads the file. */
export const NAVER_BOOKING_EXPORT_URL = 'https://help.naver.com/service/30026/contents/20635?lang=ko';
const digits = (value: string) => value.replace(/\D/gu, '');
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
  const real = useBundle(realCopy);
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
  const todayRows = selectReservations(store.getSnapshot(), { date: m.date, variant: view.variant }).rows;
  type TodayRow = typeof todayRows[number];
  /** D-333: the 4-wide table of 3 rows and up also shows the request and the way each booking came in, the columns the detail grid has (the request column only when a booking has one). */
  const requestOf = (r: TodayRow): string => resolveDataText(t.t, r.request) || (r.requestKey ? t.t(r.requestKey) : '');
  const extraColumns = props.width >= 4 && props.height >= 3 ? [
    ...(todayRows.some((r) => requestOf(r)) ? [{ id: 'request', label: i5.t('widget.voice-booking.i5.request'), render: (r: TodayRow) => requestOf(r) || '—' }] : []),
    { id: 'path', label: i5.t('widget.voice-booking.i5.path'), render: (r: TodayRow) => metaOf(store.getSnapshot(), r.reservationId)?.origin === 'naver' ? real.t('widget.voice-booking.real.pathNaver') : t.t(r.source === 'phone_ai' ? 'widget.voice-booking.sourcePhone' : 'widget.voice-booking.sourceDirect') },
  ] : [];
  const bars: BarItem[] = m.slots.map((s) => ({ key: s.time, value: s.people, label: t.format.time(s.time), display: String(s.people), sub: seatNote(t, s), marker: s.seatsFree < 0 ? 'below' : null, tone: s.seatsFree < 0 ? 'b' : 'a', name: `${t.format.time(s.time)} ${slotValue(t, s)}, ${seatNote(t, s)}` }));
  return (
    <PanelFrame id={ID}>
      <Body
        props={props}
        primary={<><Kpi id={ID} label={t.t('widget.voice-booking.today')} value={value} unit={unit} longest="888" sub={i5.t('widget.voice-booking.i5.waiting', { count: m.needsCheckCount })} subLang="ko" /><PickupSummary date={m.date} /></>}
        chart={props.height === 1 ? undefined : <Bars items={bars} max={Math.max(...bars.map((b) => b.value ?? 0), 1)} label={t.t('widget.voice-booking.slotsHeading')} />}
        list={props.width>=3&&props.height>=2?<FitMiniTable rows={todayRows} columns={[{id:'time',label:i5.t('widget.voice-booking.i5.dateTime'),render:r=>r.time},{id:'name',label:i5.t('widget.voice-booking.i5.guest'),render:r=>typeof r.name==='string'?r.name:resolveDataText(t.t,r.name)},{id:'party',label:i5.t('widget.voice-booking.i5.party'),numeric:true,render:r=>metaOf(store.getSnapshot(),r.reservationId)?.partyKnown===false?'—':r.partySize},{id:'table',label:i5.t('widget.voice-booking.i5.table'),render:r=>tableText(metaOf(store.getSnapshot(),r.reservationId),r.tableId)},...extraColumns,{id:'status',label:i5.t('widget.voice-booking.i5.status'),render:r=>i5.t(r.status==='needs-check'?'widget.voice-booking.i5.pending':r.status==='confirmed'?'widget.voice-booking.i5.confirmed':r.status==='completed'?'widget.voice-booking.i5.completed':r.status==='canceled'?'widget.voice-booking.i5.canceled':r.status==='proposed'?'widget.voice-booking.i5.proposed':'widget.voice-booking.i5.noShow')}]} getRowId={r=>r.reservationId} label={i5.t('widget.voice-booking.i5.list')} dropColumns={['name','table','request','path']}/>:list}
      />
    </PanelFrame>
  );
}

function BookingPickups({ date, host }: { date: string; host: WidgetDetailProps['host'] }) {
  const count = usePickupCount(date);
  return count === null ? null : <div className="mc-booking-pickups"><PickupReservations date={date} host={host} /></div>;
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

/** The call's time in store-local `{M}/{D}({요일}) {HH:MM}` (DS G-25), not the browser's "11. 22. 10:00". */
const stampOf = (t: Translator, iso: string) => t.format.dateTime(kstLocal(iso));

/** PN08 SmartCall daily aggregates of the period the service answered for. No recording, summary, number or per-call row exists, and none is invented. */
function CallAggregates({ calls, period, channels, copy, t }: { readonly calls: readonly CallDayDto[]; readonly period: { readonly startDate: string; readonly endDate: string } | null; readonly channels: readonly string[]; readonly copy: Translator; readonly t: Translator }) {
  const total = calls.reduce((sum, day) => sum + day.totalCalls, 0), missed = calls.reduce((sum, day) => sum + day.missedCalls, 0);
  const range = period ?? { startDate: calls[0].date, endDate: calls[calls.length - 1].date };
  const seconds = (value: number | null) => value === null ? '—' : copy.t('widget.voice-booking.real.seconds', { n: Math.round(value) });
  return <section className="mc-booking-calls" aria-label={copy.t('widget.voice-booking.real.calls')} data-slot="voice-booking.calls">
    <details>
      <summary>
        <span className="mc-h3">{copy.t('widget.voice-booking.real.calls')}</span>
        <span className="mc-booking-calls__total">{copy.t('widget.voice-booking.real.callsTotal', { total, missed })}</span>
        <span className="mc-caption">{[copy.t('widget.voice-booking.real.callsSource'), ...channels].join(' · ')} · {copy.t('widget.voice-booking.real.callsRange', { start: t.format.date(range.startDate, 'short'), end: t.format.date(range.endDate, 'short') })}</span>
      </summary>
      <div className="mc-booking-calls__wrap">
        <Table className="mc-booking-calls__table">
          <thead><tr>
            <th scope="col">{copy.t('widget.voice-booking.real.callDate')}</th>
            {(['callTotal', 'callConnected', 'callArs', 'callMissed', 'callBusy', 'callAverage', 'callTen'] as const).map(key => <th key={key} scope="col" className="mc-booking-calls__number">{copy.t(`widget.voice-booking.real.${key}`)}</th>)}
          </tr></thead>
          <tbody>{calls.map(day => <tr key={day.date}>
            <th scope="row">{t.format.date(day.date, 'short')}</th>
            <td className="mc-booking-calls__number">{day.totalCalls}</td><td className="mc-booking-calls__number">{day.connectedCalls}</td><td className="mc-booking-calls__number">{day.arsCalls}</td>
            <td className="mc-booking-calls__number">{day.missedCalls}</td><td className="mc-booking-calls__number">{day.busyCalls}</td>
            <td className="mc-booking-calls__number">{seconds(day.averageDurationSeconds)}</td><td className="mc-booking-calls__number">{day.callsAtLeastTenSeconds}</td>
          </tr>)}</tbody>
        </Table>
      </div>
      <p className="mc-caption">{copy.t('widget.voice-booking.real.callsNote')}</p>
    </details>
  </section>;
}

/** PN02 booking products: the provider gives a name and nothing else, so a name is all that is shown. */
function BookingProducts({ products, copy }: { readonly products: readonly BookingProductDto[]; readonly copy: Translator }) {
  return <details className="mc-booking-products" data-slot="voice-booking.products">
    <summary>{copy.t('widget.voice-booking.real.products')} · {products.length}</summary>
    <ul>{products.map(product => <li key={product.name}>{product.name}</li>)}</ul>
  </details>;
}

export function VoiceBookingDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const { http: real, pending: busy, run: runCommand } = useBookingCommand();
  const domain = useDomainState('booking'), retry = useRealRetry('booking');
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
  const [done, setDone] = useState<string>('');
  const [adding, setAdding] = useState(detailRef.view==='register');
  const [guest, setGuest] = useState(formGuest && 'name' in formGuest && typeof formGuest.name === 'string' ? formGuest.name : '');
  const [phone, setPhone] = useState(formGuest && 'phone' in formGuest && typeof formGuest.phone === 'string' ? formGuest.phone : '');
  const [date, setDate] = useState(isIsoDate(form?.date) ? form.date : entryDate);
  const [bookingTime, setBookingTime] = useState(isTime(form?.time) ? form.time : isTime(detailRef.time) && adding ? detailRef.time : '17:00');
  const [party, setParty] = useState<number|null>(typeof form?.partySize === 'number' ? form.partySize : 1);
  const [request, setRequest] = useState(typeof form?.request === 'string' ? form.request : '');
  const [formError, setFormError] = useState(''), [askDuplicate, setAskDuplicate] = useState(false), [editError, setEditError] = useState(''), [editDuplicate, setEditDuplicate] = useState(false);
  /** The extra question before a cancel or a declined phone request (HTTP only: the fixture store keeps its one-press cancel). */
  const [confirming, setConfirming] = useState<'cancel' | 'decline' | null>(null);
  /** NAVER cancel terms (D-347 PN02): the owner's own reason, and the refund terms of a confirmed or completed Npay booking (none is pre-selected: money is on the line). */
  const [cancelReason, setCancelReason] = useState(''), [refundType, setRefundType] = useState<RefundPick>(''), [refundValue, setRefundValue] = useState<number | null>(null), [cancelError, setCancelError] = useState('');
  /** NAVER cancel has two steps in the side panel: the input (reason, refund terms), then the extra confirmation that says it cannot be undone (SCR-225, AC-1618). */
  const [cancelStep, setCancelStep] = useState<'input' | 'confirm'>('input');
  const confirmRef = useRef<HTMLDivElement>(null);
  /** The sentence after a NAVER cancel that says it cannot be undone (the service reports `cancelUndoable: false`). */
  const [doneNote, setDoneNote] = useState('');
  // The extra confirmation takes focus on its safe choice (the owner presses the destructive one on purpose).
  useEffect(() => { if (cancelStep === 'confirm') confirmRef.current?.querySelector<HTMLElement>('button')?.focus(); }, [cancelStep, confirming]);
  const [query, setQuery] = useState('');
  const i5 = useBundle(bookingCopy, ...dataBundles);
  const rl = useBundle(realCopy, bookingCancelCopy);
  const snapshot = store.getSnapshot();
  const reservations=selectReservations(snapshot,{date:selectedDate,variant:view.variant});
  type Booking=typeof reservations.rows[number];
  const tableLayoutEnabled = reservations.tableLayoutEnabled;
  const hasWarning = reservations.rows.some(r => r.allocationWarning);
  const totalSeats = reservations.totalSeats;
  const realMeta = snapshot.tables.realBooking?.meta;
  const hasNaver = real && reservations.rows.some(r => realMeta?.[r.reservationId]?.origin === 'naver');
  const { columns, bookingName, warning, statusText } = useMemo(() => {
    const bookingName=(r:Booking)=>typeof r.name==='string'?r.name:resolveDataText(t.t,r.name);
    const warning=(r:Booking)=>r.allocationWarning?i5.t(r.allocationWarning==='NO_MATCHING_TABLE'?'widget.voice-booking.i5.noTable':'widget.voice-booking.i5.over',{n:totalSeats}):'';
    const statusText=(r:Booking)=>i5.t(r.status==='confirmed'?'widget.voice-booking.i5.confirmed':r.status==='needs-check'?'widget.voice-booking.i5.pending':r.status==='completed'?'widget.voice-booking.i5.completed':r.status==='canceled'?'widget.voice-booking.i5.canceled':r.status==='proposed'?'widget.voice-booking.i5.proposed':'widget.voice-booking.i5.noShow');
    const unknownParty=(r:Booking)=>real&&realMeta?.[r.reservationId]?.partyKnown===false;
    const pathText=(r:Booking)=>{const origin=real?realMeta?.[r.reservationId]?.origin:undefined;return origin==='naver'?rl.t('widget.voice-booking.real.pathNaver'):origin==='call'?rl.t('widget.voice-booking.real.pathCall'):t.t(r.source==='phone_ai'?'widget.voice-booking.sourcePhone':'widget.voice-booking.sourceDirect');};
    // DS 12.1 column widths follow the content: chips, numbers and paths keep a fixed track, the free width goes to time, guest and request.
    // Beside the side panel the columns drop in this order (the panel shows all of them): 경로 → 테이블 → 요청사항 → 확인할 점.
    const columns: GridColumn<Booking>[] = [
       {id:'kind',header:i5.t('widget.voice-booking.i5.kind'),kind:'text',minWidth:layoutTokens.targetDefault*3,fixedWidth:true,value:()=>i5.t('widget.voice-booking.i5.visitKind'),render:()=>renderStatusChip(i5.t('widget.voice-booking.i5.visitKind'),'none')},
       ...(hasNaver?[
         {id:'number',header:rl.t('widget.voice-booking.real.number'),kind:'text' as const,value:(r:Booking)=>realMeta?.[r.reservationId]?.bookingNumber??'—',minWidth:130,fixedWidth:true,dropOrder:5},
         {id:'product',header:rl.t('widget.voice-booking.real.product'),kind:'text' as const,value:(r:Booking)=>realMeta?.[r.reservationId]?.product??'—',minWidth:150,dropOrder:6},
       ]:[]),
       {id:'time',header:i5.t('widget.voice-booking.i5.dateTime'),kind:'text',value:r=>r.time,minWidth:170,sortable:true},
       {id:'guest',header:i5.t('widget.voice-booking.i5.guest'),kind:'text',value:bookingName,minWidth:170},
       {id:'party',header:i5.t('widget.voice-booking.i5.party'),kind:'number',unit:i5.t('widget.voice-booking.i5.unitParty'),value:r=>r.partySize,render:r=>unknownParty(r)?<span aria-label={rl.t('widget.voice-booking.real.partyUnknown')}>—</span>:undefined,minWidth:140,fixedWidth:true,sortable:true},
       ...(tableLayoutEnabled?[{id:'table',header:i5.t('widget.voice-booking.i5.table'),kind:'text' as const,value:(r:Booking)=>tableText(realMeta?.[r.reservationId],r.tableId),minWidth:110,fixedWidth:true,dropOrder:2}]:[]),
       {id:'request',header:i5.t('widget.voice-booking.i5.request'),kind:'text',value:r=>resolveDataText(t.t,r.request)||(r.requestKey?t.t(r.requestKey):''),minWidth:220,dropOrder:3},
       {id:'path',header:i5.t('widget.voice-booking.i5.path'),kind:'text',value:pathText,minWidth:130,fixedWidth:true,dropOrder:1},
       {id:'status',header:i5.t('widget.voice-booking.i5.status'),kind:'status',value:statusText,render:r=>statusChip(r.status,statusText(r)),minWidth:170,fixedWidth:true},
       ...(hasNaver?[{id:'npay',header:rl.t('widget.voice-booking.real.npay'),kind:'status' as const,value:(r:Booking)=>realMeta?.[r.reservationId]?.npayLinked?rl.t('widget.voice-booking.real.npayLinked'):'',render:(r:Booking)=>realMeta?.[r.reservationId]?.npayLinked?renderStatusChip(rl.t('widget.voice-booking.real.npayLinked'),'none','neutral'):null,minWidth:130,fixedWidth:true,dropOrder:7}]:[]),
       ...(hasWarning?[{id:'check',header:i5.t('widget.voice-booking.i5.check'),kind:'status' as const,value:(r:Booking)=>warning(r),render:(r:Booking)=>warning(r)?renderStatusChip(warning(r),'warning'):null,minWidth:230,fixedWidth:true,dropOrder:4}]:[]),
      ];
    return { columns, bookingName, warning, statusText };
  }, [t, i5, rl, real, realMeta, hasNaver, tableLayoutEnabled, hasWarning, totalSeats]);
  if (view.status !== 'ready') return <div className="mc-detail" data-widget={ID}>{real && view.status === 'error'
    ? <div className="mc-detail-state" data-slot={`${ID}.state.message`} data-tone="error"><p role="alert">{t.t(view.messageKey)}</p><ActionButton variant="secondary" onClick={retry}>{t.t('data.action.retry')}</ActionButton></div>
    : <DetailState id={ID} view={view} t={t} host={host} />}</div>;
  const selected = adding ? null : reservations.rows.find(row => row.reservationId === picked) ?? null;
  const selectedMeta = selected && real ? realMeta?.[selected.reservationId] : undefined;
  const isNaver = selectedMeta?.origin === 'naver', isNpay = isNaver && selectedMeta.npayLinked === true, isCandidate = !!selectedMeta?.candidate;
  /** What the service lets the owner do with this NAVER booking (its `actions`): the screen draws only that. */
  const rules = selected && isNaver ? naverRules(selectedMeta, selected.status) : null;
  const needle = real ? query.trim().toLowerCase() : '';
  const matches = (row: Booking) => !needle || [bookingName(row), realMeta?.[row.reservationId]?.bookingNumber, row.date,
    t.format.date(row.date, 'long'), t.format.date(row.date, 'short'), statusText(row)].some(value => value?.toLowerCase().includes(needle))
    || (/^[0-9\s()+-]+$/u.test(needle) && !isIsoDate(needle) && digits(needle).length >= 2 && digits(resolveDataText(t.t, row.phone)).includes(digits(needle)));
  const rows = [...reservations.rows].filter(matches).sort((a, b) => {
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
    setConfirming(null);
    setCancelStep('input');
    setCancelReason('');
    setRefundType('');
    setRefundValue(null);
    setCancelError('');
  };
  const selectBooking = (id: string | null) => {
    setPicked(id);
    resetEdit();
    setProposing(null);
    setTime(null);
    setDone('');
    setDoneNote('');
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
  const providerKeys: Readonly<Record<string, string>> = { BOOKING_PROVIDER_REFUSED: 'widget.voice-booking.real.providerRefused', BOOKING_PROVIDER_OUTCOME_UNKNOWN: 'widget.voice-booking.real.providerUnknown',
    BOOKING_PROVIDER_PENDING: 'widget.voice-booking.real.providerPending', BOOKING_PROVIDER_UNAVAILABLE: 'widget.voice-booking.real.providerUnavailable', UNAVAILABLE: 'widget.voice-booking.real.providerUnavailable',
    CANCEL_REASON_REQUIRED: 'widget.voice-booking.real.cancelReasonNeeded', REFUND_TERMS_REQUIRED: 'widget.voice-booking.real.refundNeeded' };
  const refusalText = (result: { reason?: string; messageKey: string }, guestName: string) =>
    result.reason === 'NPAY_LINKED_BOOKING' ? rl.t('widget.voice-booking.real.npayLocked')
      : real && result.reason && providerKeys[result.reason] ? rl.t(providerKeys[result.reason])
      : i5.t(result.reason === 'GUEST_INVALID' ? (guestName.trim() === '' ? 'widget.voice-booking.i5.error.guestName' : 'widget.voice-booking.i5.error.guestPhone') : result.messageKey);
  /** A command result for the form that caused it: `ok` closes the form, a refusal stays in it. */
  type Settled = Parameters<Parameters<typeof runCommand>[1]>[0];
  /** Success notices say what was done (ko). `inline` keeps a refusal in the form that caused it instead of also raising a toast. */
  const noticeKeys: Readonly<Record<string, string>> = { 'booking.cancel': 'data.management.notice.bookingCanceled', 'booking.markNoShow': 'data.management.notice.bookingNoShow', 'booking.markCompleted': 'data.management.notice.visitCompleted', 'booking.create': 'data.management.notice.bookingAdded', 'booking.update': 'data.management.notice.bookingEdited', 'booking.confirm': 'data.management.notice.bookingConfirmed' };
  /** Over HTTP nothing is sent to the guest: the notices say what was recorded, never "text sent". */
  const recorded: Readonly<Record<string, string>> = { 'booking.propose': 'widget.voice-booking.real.proposedRecorded', 'booking.declineSuggestion': 'widget.voice-booking.real.declined' };
  const run = (command: Parameters<typeof runCommand>[0], inline = false, settled?: (result: Settled) => void) => {
    // A NAVER cancel (it carries the owner's reason) words its own result in `confirmCancel`: what NAVER was asked to do, never "refunded", and no undo.
    const naverCancelCommand = command.type === 'booking.cancel' && command.cancelReason !== undefined;
    runCommand(command, result => {
      const noticeKey = t.locale === 'ko' ? noticeKeys[command.type] : undefined;
      if (result.ok && naverCancelCommand) { /* announced by the caller */ }
      else if (result.ok && real && recorded[command.type]) { notifySuccess(host, 'data.management.notice.saved', result); setDone(rl.t(recorded[command.type])); }
      else if (result.ok && noticeKey) { notifySuccess(host, noticeKey, result); if (!real) setDone(i5.t(noticeKey)); }
      else if (inline && !result.ok) { /* the form shows it */ }
      else if (reportResult(host, result) && !real && result.ok && result.noticeKey) setDone(t.t(result.noticeKey, result.params));
      settled?.(result);
    });
  };
  const submitBooking = (confirmDuplicate: boolean) => {
    run({ type: 'booking.create', ...(memberId ? { memberId } : { guest: { name: guest, ...(phone ? { phone } : {}) } }), date, time: bookingTime, partySize: party ?? 0, request, tableChoice: tableChoice === 'auto' ? 'auto' : { tableId: tableChoice }, idempotencyKey: `booking-create-${crypto.randomUUID()}`, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }, true, result => {
      if (result.ok) { setAdding(false); setFormError(''); setAskDuplicate(false); setPicked(null); setSelectedDate(date); }
      else { setFormError(refusalText(result, guest)); setAskDuplicate(result.reason === 'BOOKING_DUPLICATE'); }
    });
  };
  const submitEdit = (confirmDuplicate: boolean) => {
    if (!selected || isCandidate || isNpay) return;
    // A NAVER booking only moves its usage time: its party, name and contact are NAVER's, and nothing is invented for them.
    const patch = isNaver ? { ...(editDate !== null ? { date: editDate } : {}), ...(editTime !== null ? { time: editTime } : {}) } : {
      partySize: editParty === undefined ? selected.partySize : editParty ?? 0,
      time: editTime ?? selected.time,
      ...(editDate !== null ? { date: editDate } : {}),
      ...(editGuest !== null || editPhone !== null ? { guest: { name: editGuest ?? bookingName(selected), ...(editPhone ? { phone: editPhone } : {}) } } : {}),
      // Only a typed request is sent: an untouched request (or seeded request key) stays as it is, and a cleared one clears both.
      ...(editRequest !== null ? { request: editRequest } : {}),
      ...(editTable !== null ? { tableChoice: editTable === 'auto' ? 'auto' as const : { tableId: editTable } } : {}),
    };
    if (isNaver && !Object.keys(patch).length) return;
    run({ type: 'booking.update', reservationId: selected.reservationId, patch, ...(confirmDuplicate ? { confirmDuplicate: true } : {}) }, true, result => {
      if (result.ok) {
        if (editDate) setSelectedDate(editDate);
        resetEdit();
      } else { setEditError(refusalText(result, editGuest ?? bookingName(selected))); setEditDuplicate(result.reason === 'BOOKING_DUPLICATE'); }
    });
  };
  const confirmBooking = (id: string) => run({ type: 'booking.confirm', reservationId: id });
  const detail = selected ? (
    <div className="mc-booking" data-slot={`${ID}.card`}>
      <div className="mc-badges">
        {selectedMeta?.partyKnown === false ? <Badge>{rl.t('widget.voice-booking.real.partyUnknown')}</Badge> : <Badge>{t.t('widget.voice-booking.party', { n: selected.partySize })}</Badge>}
        {statusChip(selected.status, statusText(selected))}
        <Badge>{isNaver ? rl.t('widget.voice-booking.real.pathNaver') : selectedMeta?.origin === 'call' ? rl.t('widget.voice-booking.real.pathCall') : t.t(selected.source === 'phone_ai' ? 'widget.voice-booking.sourcePhone' : 'widget.voice-booking.sourceDirect')}</Badge>
        {isNpay ? <Badge>{rl.t('widget.voice-booking.real.npayLinked')}</Badge> : null}
        {selected.confirmedBy ? <Badge>{t.t(selected.confirmedBy === 'auto' ? 'widget.voice-booking.autoConfirmed' : 'widget.voice-booking.personConfirmed')}</Badge> : null}
        {selected.proposedTime ? <Badge>{t.t('widget.voice-booking.proposedAt', { time: t.format.time(selected.proposedTime) })}</Badge> : null}
      </div>
      {isNaver ? <dl className="mc-extracted" aria-label={rl.t('widget.voice-booking.real.pathNaver')}>
        <div><dt>{rl.t('widget.voice-booking.real.number')}</dt><dd>{selectedMeta.bookingNumber}</dd></div>
        <div><dt>{rl.t('widget.voice-booking.real.product')}</dt><dd>{selectedMeta.product}</dd></div>
      </dl> : null}
      {resolveDataText(t.t, selected.request) || selected.requestKey ? <p>{t.t('widget.voice-booking.extRequest')}: {resolveDataText(t.t, selected.request) || t.t(selected.requestKey!)}</p> : null}
      {selected.allocationWarning ? <p className="mc-flag"><span aria-hidden="true">△ </span>{warning(selected)}</p> : null}
      {isCandidate ? null : isNaver && !rules?.change ? (
        // The service lists no change for this NAVER booking: an open Npay booking says why (it cannot be changed here); a finished or cancelled one has nothing to edit.
        isNpay && (selected.status === 'needs-check' || selected.status === 'confirmed') ? (
          <div className="mc-booking-edit" data-slot="voice-booking.npayLocked">
            <p className="mc-flag" role="note"><span aria-hidden="true">△ </span>{rl.t('widget.voice-booking.real.npayLocked')}</p>
            <div className="mc-actions"><ActionButton disabled aria-disabled="true" variant="secondary">{i5.t('widget.voice-booking.i5.editSaveAction')}</ActionButton></div>
          </div>
        ) : null
      ) : (
      <form className="mc-booking-edit" aria-labelledby={editTitleId} onSubmit={event => { event.preventDefault(); submitEdit(false); }}>
        <h4 className="mc-h3" id={editTitleId}>{isNaver ? rl.t('widget.voice-booking.real.naverEdit') : i5.t('widget.voice-booking.i5.editSave')}</h4>
        <div className="mc-booking-edit__fields">
          {isNaver ? null : <>
            <TextField label={i5.t('widget.voice-booking.i5.name')} value={editGuest ?? bookingName(selected)} onValueChange={setEditGuest} />
            <TextField label={i5.t('widget.voice-booking.i5.phone')} value={editPhone ?? ''} hint={resolveDataText(t.t, selected.phone)} onValueChange={setEditPhone} />
          </>}
          <DateField label={i5.t('widget.voice-booking.i5.date')} value={editDate ?? selected.date} today={TODAY} onValueChange={value => setEditDate(value)} />
          {isNaver ? null : <NumberField label={i5.t('widget.voice-booking.i5.editParty')} value={editParty === undefined ? selected.partySize : editParty} onValueChange={setEditParty} />}
          <TimeField label={i5.t('widget.voice-booking.i5.editTime')} value={editTime ?? selected.time} onValueChange={value => setEditTime(value)} />
          {isNaver ? null : <Textarea label={i5.t('widget.voice-booking.i5.request')} value={editRequest ?? resolveDataText(t.t, selected.request)} onValueChange={setEditRequest} />}
          {tableLayoutEnabled && !isNaver && <label className="ui-field">{i5.t('widget.voice-booking.i5.table')}
            <select className="ui-text-input" value={editTable ?? (selected.assignmentMode === 'manual' ? selected.tableId ?? 'auto' : 'auto')} onChange={event => setEditTable(event.target.value)}>
              <option value="auto">{i5.t('widget.voice-booking.i5.auto')}</option>
              {selectShopSettings(store.getSnapshot()).tableLayout?.tables.map(table => <option key={table.tableId} value={table.tableId}>T{table.number} · {table.seats}석</option>)}
            </select>
          </label>}
        </div>
        {editError && <p role="alert">{editError}</p>}
        <div className="mc-actions">
          <ActionButton type="submit" loading={busy && real} disabled={busy || (isNaver && editDate === null && editTime === null)}>{i5.t('widget.voice-booking.i5.editSaveAction')}</ActionButton>
          {editDuplicate ? <ActionButton variant="secondary" disabled={busy} onClick={() => submitEdit(true)}>{i5.t('widget.voice-booking.i5.editAnyway')}</ActionButton> : null}
        </div>
      </form>
      )}
      <div className="mc-actions">
        {selected.canConfirm ? <ActionButton variant="secondary" disabled={busy} aria-label={t.t('widget.voice-booking.confirmFor', { name: bookingName(selected), time: t.format.time(selected.time) })} onClick={() => confirmBooking(selected.reservationId)}>{t.t('common.confirm')}</ActionButton> : null}
        {selected.canPropose && !isNaver ? <ActionButton variant="secondary" aria-expanded={proposing === selected.reservationId} aria-label={t.t('widget.voice-booking.proposeFor', { name: bookingName(selected), time: t.format.time(selected.time) })} onClick={() => { setProposing(selected.reservationId); setTime(null); }}>{t.t('common.suggestOtherTime')}</ActionButton> : null}
        {selected.canMarkNoShow ? <ActionButton variant="secondary" disabled={busy} onClick={() => run({ type:'booking.markCompleted', reservationId:selected.reservationId })}>{i5.t('widget.voice-booking.i5.complete')}</ActionButton> : null}
        {selected.status === 'confirmed' ? <ActionButton variant="secondary" disabled={!selected.canMarkNoShow || busy} aria-label={t.t('widget.voice-booking.noShowFor', { name: bookingName(selected), time: t.format.time(selected.time) })} onClick={() => { run({ type: 'booking.markNoShow', reservationId: selected.reservationId }); }}>{i5.t('widget.voice-booking.i5.noShowAction')}</ActionButton> : null}
      </div>
      {selected.status === 'confirmed' && !selected.canMarkNoShow ? <p className="mc-caption">{t.t('data.error.notYetTime')}</p> : null}
      {proposing === selected.reservationId && selected.canPropose && !isNaver ? (
        <div className="mc-propose">
          <h4 className="mc-h3">{t.t('widget.voice-booking.proposeTitle')}</h4>
          <TimeChips times={[...new Set([...proposalTimes(selected.time), ...(entry.suggestion ? [entry.suggestion] : [])])].sort()} value={time} onChange={setTime} label={t.t('widget.voice-booking.proposeChips')} />
          <div className="mc-actions">
            <ActionButton variant="secondary" disabled={!time || busy} onClick={() => { if (time) run({ type: 'booking.propose', reservationId: selected.reservationId, time }, false, result => { if (result.ok) setProposing(null); }); }}>{t.t('common.sendSuggestion')}</ActionButton>
            <ActionButton variant="ghost" onClick={() => setProposing(null)}>{t.t('common.close')}</ActionButton>
          </div>
        </div>
      ) : null}
      {isNaver && selected.status === 'completed' && rules?.cancel ? <p className="mc-caption" role="note" data-slot="voice-booking.completedNote">{rl.t('widget.voice-booking.real.completedNote')}</p> : null}
      {done || doneNote ? <p className="mc-done" role="status">{done}{doneNote ? <span className="mc-done__note" data-slot="voice-booking.noUndo">{doneNote}</span> : null}</p> : null}
      {real ? (isCandidate ? (
        <section className="mc-call" aria-label={rl.t('widget.voice-booking.real.candidate')} data-slot="voice-booking.candidate">
          <h4 className="mc-h3">{rl.t('widget.voice-booking.real.candidate')}</h4>
          <dl className="mc-extracted">
            <div><dt>{rl.t('widget.voice-booking.real.candidateAt')}</dt><dd>{stampOf(t, selectedMeta.candidate!.callAt)}</dd></div>
            <div><dt>{t.t('widget.voice-booking.extDate')}</dt><dd>{t.format.date(selected.date, 'short')}</dd></div>
            <div><dt>{t.t('widget.voice-booking.extTime')}</dt><dd>{t.format.time(selected.time)}</dd></div>
            <div><dt>{t.t('widget.voice-booking.extParty')}</dt><dd>{t.t('widget.voice-booking.party', { n: selected.partySize })}</dd></div>
            <div><dt>{i5.t('widget.voice-booking.i5.phone')}</dt><dd>{selectedMeta.candidate!.phoneMasked ?? '—'}</dd></div>
            <div><dt>{t.t('widget.voice-booking.extRequest')}</dt><dd>{resolveDataText(t.t, selected.request) || t.t('widget.voice-booking.noRequest')}</dd></div>
          </dl>
          <p className="mc-caption">{rl.t('widget.voice-booking.real.candidateNote')}</p>
        </section>
      ) : null) : null}
    </div>
  ) : null;
  // DS 12.2: the destructive action is the last item of the panel body (nothing after it).
  const kind = isCandidate ? 'decline' as const : 'cancel' as const;
  /** A NAVER booking is cancellable exactly when the service lists it: an open one, or a completed Npay booking that can still be refunded. A local one is until it is cancelled. */
  const cancellable = !!selected && (isNaver ? rules?.cancel === true : selected.status !== 'canceled');
  /** Refund terms are due when the service says so (`cancelRequiresRefund`: a confirmed or completed Npay booking, owner help 18720 and 19427); any other NAVER cancel takes the reason alone. */
  const refundDue = isNaver && rules?.requiresRefund === true;
  /** The payment amount the provider showed, when it did: an amount refund may not exceed it, and without it no amount refund is offered. */
  const paymentAmount = isNaver ? selectedMeta?.paymentAmount : undefined;
  const naverCancel = isNaver && kind === 'cancel';
  const rateOk = refundValue !== null && refundValue >= 0 && refundValue <= 100;
  const amountOk = refundValue !== null && paymentAmount !== undefined && Number.isSafeInteger(refundValue) && refundValue >= 0 && refundValue <= paymentAmount;
  const refundOk = refundType === 'full' || (refundType === 'rate' && rateOk) || (refundType === 'amount' && amountOk);
  const cancelReady = !naverCancel || (cancelReason.trim() !== '' && (!refundDue || refundOk));
  const refundTerms = refundDue && refundOk ? (refundType === 'rate' ? { type: 'rate' as const, value: refundValue! } : refundType === 'amount' ? { type: 'amount' as const, value: refundValue! } : { type: 'full' as const }) : undefined;
  const money = (n: number) => n.toLocaleString('ko-KR');
  /** The line that says why the review button is off (one reason at a time): the field errors speak for themselves. */
  const cancelBlock = !naverCancel ? '' : cancelReason.trim() === '' ? rl.t('widget.voice-booking.real.cancelReasonNeeded') : refundDue && refundType === '' ? rl.t('widget.voice-booking.real.refundPick') : '';
  const refundText = !refundTerms ? '' : refundTerms.type === 'full' ? rl.t('widget.voice-booking.real.refundFull')
    : rl.t(refundTerms.type === 'rate' ? 'widget.voice-booking.real.summaryRefundRate' : 'widget.voice-booking.real.summaryRefundAmount', { n: money(refundTerms.value) });
  const closeCancel = () => { setConfirming(null); setCancelStep('input'); setCancelError(''); };
  /** A refusal of the cancel press, in words the owner can act on; the screen goes back to the input with everything typed kept. */
  const cancelFailure = (result: { reason?: string; messageKey: string }) => {
    const reason = result.reason ?? '';
    if (reason === 'CANCEL_REASON_REQUIRED') return rl.t('widget.voice-booking.real.cancelReasonNeeded');
    if (reason === 'REFUND_TERMS_REQUIRED' || reason === 'REFUND_REQUIRED') return rl.t('widget.voice-booking.real.refundNeeded');
    if (reason === 'INVALID_REFUND_TERMS') return paymentAmount === undefined ? rl.t('widget.voice-booking.real.refundAmountBad') : rl.t('widget.voice-booking.real.refundLimit', { n: money(paymentAmount) });
    if (reason === 'BOOKING_TRANSITION' || reason === 'REFUND_NOT_APPLICABLE') return rl.t('widget.voice-booking.real.cancelRefused');
    return refusalText(result, '');
  };
  const confirmCancel = () => {
    if (!selected || !cancelReady || busy) return;
    const command = kind === 'decline' ? { type: 'booking.declineSuggestion' as const, reservationId: selected.reservationId }
      : { type: 'booking.cancel' as const, reservationId: selected.reservationId, ...(naverCancel ? { cancelReason: cancelReason.trim(), ...(refundTerms ? { refund: refundTerms } : {}) } : {}) };
    const refunded = refundTerms !== undefined, noUndo = rules?.undoable === false;
    setDone('');
    setDoneNote('');
    run(command, naverCancel, result => {
      if (result.ok) {
        if (naverCancel) {
          notifySuccess(host, refunded ? 'data.real.booking.canceledRefund' : 'data.real.booking.canceled', result, { undo: !noUndo });
          setDoneNote(noUndo ? rl.t('widget.voice-booking.real.canceledNoUndo') : '');
        }
        resetEdit();
        return;
      }
      if (naverCancel) {
        const reason = cancelFailure(result);
        setCancelError(commandFailureText(t.t, result, reason === result.messageKey || result.messageKey.startsWith('data.real.commandFailure.') ? {} : { reason, next: '' }));
        setCancelStep('input');
        // The booking changed on NAVER since the last read (its state or its payment) or the outcome is unknown: read again so the terms asked for match it before the next press.
        if (['BOOKING_PROVIDER_REFUSED', 'BOOKING_PROVIDER_OUTCOME_UNKNOWN', 'BOOKING_TRANSITION', 'REFUND_REQUIRED'].includes(result.reason ?? '')) retry();
      }
    });
  };
  const askKey = kind === 'decline' ? 'widget.voice-booking.real.declineAsk' : 'widget.voice-booking.real.cancelAsk';
  /** Step 1 of a NAVER cancel (SCR-225): the owner's reason (the customer reads it) and, when the service says it is due, the refund terms. Nothing is sent from here. */
  const naverCancelForm = (
    <InlineForm title={rl.t('widget.voice-booking.real.cancelTitle')} saveLabel={rl.t('widget.voice-booking.real.cancelReview')} closeLabel={rl.t('widget.voice-booking.real.cancelClose')}
      saveDisabled={!cancelReady || busy} onSave={() => { setCancelError(''); setCancelStep('confirm'); }} onClose={closeCancel}>
      <div className="mc-booking-cancel" data-slot="voice-booking.naverCancel">
        <Textarea label={rl.t('widget.voice-booking.real.cancelReason')} hint={rl.t('widget.voice-booking.real.cancelReasonHint')} rows={4} value={cancelReason} onValueChange={setCancelReason} disabled={busy} />
        {refundDue ? <div className="mc-booking-refund" data-slot="voice-booking.refund">
          <p className="mc-flag" role="note"><span aria-hidden="true">△ </span>{rl.t('widget.voice-booking.real.refundNeeded')}</p>
          {paymentAmount === undefined ? null : <p className="mc-booking-refund__paid">{rl.t('widget.voice-booking.real.paymentAmount', { n: money(paymentAmount) })}</p>}
          <RadioGroup label={rl.t('widget.voice-booking.real.refund')} value={refundType} onValueChange={value => { setRefundType(value); setRefundValue(null); }} disabled={busy}
            options={[{ value: 'full', label: rl.t('widget.voice-booking.real.refundFull') }, { value: 'rate', label: rl.t('widget.voice-booking.real.refundRate') },
              ...(paymentAmount === undefined ? [] : [{ value: 'amount' as const, label: rl.t('widget.voice-booking.real.refundAmount') }])]} />
          {refundType === 'rate' || refundType === 'amount' ? <NumberField label={rl.t(refundType === 'rate' ? 'widget.voice-booking.real.refundRateValue' : 'widget.voice-booking.real.refundAmountValue')} unit={refundType === 'rate' ? '%' : '원'}
            value={refundValue} onValueChange={setRefundValue} min={0} max={refundType === 'rate' ? 100 : paymentAmount} step={1} disabled={busy}
            hint={refundType === 'amount' && paymentAmount !== undefined ? rl.t('widget.voice-booking.real.refundLimit', { n: money(paymentAmount) }) : undefined}
            error={refundValue !== null && !refundOk ? (refundType === 'rate' ? rl.t('widget.voice-booking.real.refundRateBad')
              : paymentAmount !== undefined && refundValue > paymentAmount ? rl.t('widget.voice-booking.real.refundLimit', { n: money(paymentAmount) }) : rl.t('widget.voice-booking.real.refundAmountBad')) : undefined} /> : null}
        </div> : null}
        {cancelBlock ? <p className="mc-caption" role="note" data-slot="voice-booking.cancelBlock">{cancelBlock}</p> : null}
        {cancelError ? <p role="alert">{cancelError}</p> : null}
      </div>
    </InlineForm>
  );
  /** Step 2 (AC-1618): the extra confirmation. It says first that the cancel cannot be undone, then shows exactly what will be sent; only its destructive button sends the command (with `confirmed:true`). */
  const naverCancelConfirm = selected && selectedMeta ? (
    <div className="mc-booking-confirm mc-booking-confirm--final" role="group" aria-label={rl.t('widget.voice-booking.real.confirmBadge')} data-slot="voice-booking.confirm" ref={confirmRef}>
      <Badge tone="down">{rl.t('widget.voice-booking.real.confirmBadge')}</Badge>
      <p className="mc-booking-confirm__lead">{rl.t('widget.voice-booking.real.irreversible')}</p>
      <dl className="mc-extracted mc-booking-confirm__rows">
        <div><dt>{rl.t('widget.voice-booking.real.summaryNumber')}</dt><dd>{selectedMeta.bookingNumber}</dd></div>
        <div><dt>{rl.t('widget.voice-booking.real.summaryProduct')}</dt><dd>{selectedMeta.product}</dd></div>
        <div><dt>{rl.t('widget.voice-booking.real.summaryUsage')}</dt><dd>{t.format.date(selected.date, 'short')} {t.format.time(selected.time)}</dd></div>
        <div><dt>{rl.t('widget.voice-booking.real.summaryReason')}</dt><dd className="mc-booking-confirm__quote">{cancelReason.trim()}</dd></div>
        {refundTerms ? <div><dt>{rl.t('widget.voice-booking.real.summaryRefund')}</dt><dd>{refundText}</dd></div> : null}
      </dl>
      {cancelError ? <p role="alert">{cancelError}</p> : null}
      <div className="mc-actions">
        <ActionButton variant="secondary" disabled={busy} onClick={closeCancel}>{rl.t('widget.voice-booking.real.dropCancel')}</ActionButton>
        <ActionButton variant="destructive" loading={busy} disabled={!cancelReady || busy} onClick={confirmCancel}>{rl.t('widget.voice-booking.real.cancelNaver', { number: selectedMeta.bookingNumber ?? '' })}</ActionButton>
      </div>
      {busy ? <p className="mc-caption" role="status">{rl.t('widget.voice-booking.real.cancelling')}</p> : null}
    </div>
  ) : null;
  const naverCancelLabel = selected?.status === 'completed' && refundDue ? 'widget.voice-booking.real.cancelCompletedNpay' : 'widget.voice-booking.real.cancelOpen';
  const danger = cancellable && selected
    ? (real ? <>
      <ActionButton variant="ghost" aria-expanded={confirming === kind} disabled={busy} onClick={() => { setCancelError(''); setCancelStep('input'); setConfirming(kind); }}>{kind === 'decline' ? rl.t('widget.voice-booking.real.decline') : naverCancel ? rl.t(naverCancelLabel) : i5.t('widget.voice-booking.i5.cancel')}</ActionButton>
      {confirming === kind ? (naverCancel ? <>
          <EscapeStep onEscape={() => { if (busy) return; if (cancelStep === 'confirm') setCancelStep('input'); else closeCancel(); }} />
          {cancelStep === 'confirm' ? naverCancelConfirm : naverCancelForm}
        </>
        : <div className="mc-booking-confirm" role="group" aria-label={rl.t(askKey)} data-slot="voice-booking.confirm">
          <p>{rl.t(askKey)}</p>
          {cancelError ? <p role="alert">{cancelError}</p> : null}
          <div className="mc-actions">
            <ActionButton variant="destructive" loading={busy} onClick={confirmCancel}>{rl.t(kind === 'decline' ? 'widget.voice-booking.real.declineYes' : 'widget.voice-booking.real.cancelYes')}</ActionButton>
            <ActionButton variant="ghost" disabled={busy} onClick={closeCancel}>{rl.t('widget.voice-booking.real.keep')}</ActionButton>
          </div>
        </div>) : null}
    </> : <ActionButton variant="ghost" disabled={busy} onClick={() => run({ type:'booking.cancel', reservationId:selected.reservationId })}>{i5.t('widget.voice-booking.i5.cancel')}</ActionButton>)
    : undefined;
  /** Count chips (read only), 예약 대기 first: the same words and icons as the status cells. */
  const statusCounts = (['needs-check', 'confirmed', 'completed', 'canceled', 'no-show', 'proposed'] as const)
    .map(status => ({ status, count: reservations.rows.filter(r => r.status === status).length }))
    .filter(({ status, count }) => count > 0 || ['needs-check', 'confirmed', 'completed', 'canceled'].includes(status));
  const labelOf = (status: BookingStatus) => i5.t(status === 'confirmed' ? 'widget.voice-booking.i5.confirmed' : status === 'needs-check' ? 'widget.voice-booking.i5.pending' : status === 'completed' ? 'widget.voice-booking.i5.completed' : status === 'canceled' ? 'widget.voice-booking.i5.canceled' : status === 'proposed' ? 'widget.voice-booking.i5.proposed' : 'widget.voice-booking.i5.noShow');
  const isToday = selectedDate === TODAY;
  const openAdd = () => { selectBooking(null); setDate(selectedDate); setAdding(true); };
  const naverStatus = real ? snapshot.tables.realBooking?.sourceStatus.naver ?? 'ready' : 'ready';
  const calls = real ? snapshot.tables.realBooking?.calls ?? [] : [];
  const callPeriod = real ? snapshot.tables.realBooking?.callPeriod ?? null : null;
  const callChannels = real ? snapshot.tables.realBooking?.callChannels ?? [] : [];
  const products = real ? snapshot.tables.realBooking?.products ?? [] : [];
  return (
    <div className="mc-detail mc-workspace" data-widget={ID} data-adding={adding || undefined} data-command-pending={real && busy || undefined} lang="ko">
      <div className="mc-booking-content">
      <div className="mc-tools mc-booking-toolbar">
        <DateStepper text={t.format.date(selectedDate,'long')} onPrevious={()=>changeDate(-1)} onNext={()=>changeDate(1)}/>
        <ActionButton variant="secondary" onClick={openAdd}>{i5.t('widget.voice-booking.i5.add')}</ActionButton>
        {real ? <a className="ui-button ui-button--secondary ui-button--default" href={NAVER_BOOKING_EXPORT_URL} target="_blank" rel="noopener noreferrer" data-slot="voice-booking.export"><span className="ui-press-surface">{rl.t('widget.voice-booking.real.export')}</span></a> : null}
      </div>
      {real ? <p className="mc-caption" data-slot="voice-booking.exportNote">{rl.t('widget.voice-booking.real.exportNote')}</p> : null}
      {real && naverStatus !== 'ready' ? <p className="mc-flag" role="status" data-slot="voice-booking.naverStatus"><span aria-hidden="true">△ </span>{rl.t(naverStatus === 'unavailable' ? 'widget.voice-booking.real.naverUnavailable' : 'widget.voice-booking.real.naverPartial')}</p>
        : real && domain.complete === false ? <p className="mc-caption" role="status">{rl.t('widget.voice-booking.real.partial')}</p> : null}
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
        {askDuplicate ? <div><ActionButton variant="secondary" disabled={busy} onClick={()=>submitBooking(true)}>{i5.t('widget.voice-booking.i5.bookAnyway')}</ActionButton></div> : null}
      </InlineForm> : <>
        <section className="mc-booking-summary" aria-label={i5.t('widget.voice-booking.i5.summary')}>
          <p className="mc-booking-summary__total"><span>{i5.t(isToday ? 'widget.voice-booking.i5.dayTotalToday' : 'widget.voice-booking.i5.dayTotal')}</span> <strong data-slot={`${ID}.metric.value`}>{countText(t, reservations.count)}</strong></p>
          <ul className="mc-booking-summary__chips">{statusCounts.map(({ status, count }) => <li key={status}>{statusChip(status, i5.t('widget.voice-booking.i5.statusCount', { label: labelOf(status), count }))}</li>)}</ul>
          <p className="mc-booking-summary__free">{i5.t(reservations.availability.kind === 'tables' ? 'widget.voice-booking.i5.tables' : 'widget.voice-booking.i5.seats', { n: reservations.availability.value })}</p>
        </section>
        <BookingPickups date={selectedDate} host={host} />
        {reservations.timeGroups.length > 0 && <details className="mc-booking-by-time">
          <summary>{t.t('widget.voice-booking.byTime')}</summary>
          <BookingTimeTable groups={reservations.timeGroups} />
        </details>}
        {calls.length ? <CallAggregates calls={calls} period={callPeriod} channels={callChannels} copy={rl} t={t} /> : null}
        {products.length ? <BookingProducts products={products} copy={rl} /> : null}
      </>}
      <DataGrid
        id="booking-grid" label={i5.t('widget.voice-booking.i5.list')} rows={rows} columns={columns}
        getRowId={row => row.reservationId} getRowLabel={row => `${bookingName(row)}, ${row.time}`}
        {...(real ? { query, onQueryChange: setQuery, searchLabel: rl.t('widget.voice-booking.real.search'), searchPlaceholder: rl.t('widget.voice-booking.real.searchHint') } : {})}
        sort={gridSort} onSortChange={setGridSort} selectedRowId={selected?.reservationId ?? null} onSelectionChange={selectBooking}
        expandedRowIds={new Set()} focus={gridFocus} onFocusChange={setGridFocus} ref={grid}
        emptyContent={<div className="mc-booking-empty"><p>{i5.t(isToday ? 'widget.voice-booking.i5.emptyToday' : 'widget.voice-booking.i5.emptyDay')}</p><ActionButton variant="secondary" onClick={openAdd}>{i5.t('widget.voice-booking.i5.add')}</ActionButton></div>}
      />
      </div>
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

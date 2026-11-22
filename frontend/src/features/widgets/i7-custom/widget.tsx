import { useEffect, useRef, useState } from 'react';
import type { WidgetDetailProps, WidgetPanelProps } from '../../../contracts';
import type { CustomOrderCommand } from '../../../data/iteration7/custom-orders';
import { NOW, TODAY } from '../../../data/db/time';
import { useBundle, type CommonKey, type KeysOf, type Translator } from '../../../i18n';
import { ActionButton, DataGrid, DetailSidePanel, DetailTabs, InlineForm, MetricFit, NumberField, PanelAction, PanelState, SegmentedControl, addIsoDays, layoutTokens, renderStatusChip, useUi, type GridFocus } from '../../../ui';
import { FitProbe } from '../mgmt-money/fit';
import { channelLabels, commandError, customOrderListBundle, isPastPickup, maskName, maskPhone, money, orderNumber, paymentLabels, requestKey, stageLabels } from './copy';
import { DateTimeField } from './date-time-field';
import { useCustomOrderModel } from './use-custom';
import type { CustomOrderPort, CustomUiResult } from './port';
import { useCustomRun } from './use-custom-run';
import { CustomMoneyDialog, type CustomMoneyAction } from './real-money';
import { ReferencePhotos } from './reference-photos';
import { ReceiptForm, TemplateManager } from './templates';
import { PickupReservations } from './pickup';
import { customReceiptPrefill } from '../../assistant/domains/custom';
import { PanelRemainder } from '../i7-staff/panel-remainder';
import './custom.css';

type Model = NonNullable<ReturnType<typeof useCustomOrderModel>['model']>;
export type CustomOrderRow = Model['orders'][number];
type Stage = CustomOrderRow['stage'];
type Translate = Translator<KeysOf<typeof customOrderListBundle> | CommonKey>;
const NO_EXPANDED: ReadonlySet<string> = new Set();
const customer = (row: CustomOrderRow, port: CustomOrderPort | null) => maskName(row.guest?.name ?? port?.members?.find(member => member.memberId === row.memberId)?.label ?? row.memberId ?? '—');

/** DS 17.1 CustomOrderStageChip: waiting stages ◷ on the warning face, done stages ✓, 취소 on the danger face, the first and the in-production stages words only. */
const stageSemantic = { received: 'none', quote_pending: 'none', approval_pending: 'waiting', revision_requested: 'waiting', payment_pending: 'waiting', in_production: 'none', production_complete: 'done', received_by_customer: 'done', canceled: 'none' } as const satisfies Record<Stage, 'none' | 'waiting' | 'done'>;
const stageTone = (stage: Stage) => stageSemantic[stage] === 'waiting' ? 'warning' : stageSemantic[stage] === 'done' ? 'success' : stage === 'canceled' ? 'danger' : 'neutral';
export function CustomOrderStageChip({ stage }: { stage: Stage }) { return renderStatusChip(stageLabels[stage], stageSemantic[stage], stageTone(stage)); }
/** DS 17.1 PaymentStatusChip, a column of its own beside the stage. */
function PaymentChip({ status }: { status: CustomOrderRow['payment']['status'] }) {
  return status === 'paid' ? renderStatusChip(paymentLabels[status], 'done', 'success') : status === 'unpaid' ? renderStatusChip(paymentLabels[status], 'waiting', 'neutral') : renderStatusChip(paymentLabels[status], 'none', 'warning');
}

/** `오늘 17:00`, `내일 14:00`, else `10/26(월) 17:00`, always from the store clock. */
function pickupLabel(tr: Translate, at: string, today: string | undefined) {
  if (today && at.slice(0, 10) === addIsoDays(today, 1)) return tr.t('widget.custom-order.tomorrowAt', { time: at.slice(11, 16) });
  return tr.format.dateTime(at, { today });
}
const pickupOf = (row: CustomOrderRow) => row.confirmedPickupAt ?? row.desiredPickupAt;
/** History lines carry data codes (`60000`, `approved`, `production_complete`): turn each into the sentence a person reads. */
function historyText(tr: Translate, entry: CustomOrderRow['history'][number], today: string | undefined) {
  const amount = (value: string) => money(Number(value));
  const key = <K extends string>(name: K) => `widget.custom-order.history.${name}` as const;
  switch (entry.kind) {
    case 'quoted': return tr.t(key('quoted'), { amount: amount(entry.detail) });
    case 'settled': return tr.t(key('settled'), { amount: amount(entry.detail) });
    case 'received': return tr.t(key('received'), { amount: amount(entry.detail) });
    case 'refunded': return tr.t(key('refunded'), { amount: /^\d+$/.test(entry.detail) ? amount(entry.detail) : '' }).trim();
    case 'decision': return tr.t(key(entry.detail === 'approved' ? 'approved' : entry.detail === 'rejected' ? 'rejected' : 'revision_requested'));
    case 'stage': return tr.t(key('stage'), { stage: stageLabels[entry.detail as Stage] ?? entry.detail });
    case 'rescheduled': return tr.t(key('rescheduled'), { value: pickupLabel(tr, entry.detail, today) });
    case 'canceled': return tr.t(key('canceled'));
    case 'updated': return tr.t(key('updated'));
    default: return tr.t(key('created'));
  }
}

const SHORT_FIT = [{ selector: '.custom-extra-row' }, { selector: '.custom-stage-counts' }, { selector: '.custom-quote-column' }, { selector: '.custom-payment-column' }, { selector: '.custom-order-row', last: true }, { selector: '.custom-panel-table tbody tr', last: true }] as const;
/** D-333: on the tall card whole rows go before the number, request note, stage counts and the payment and quote columns (the reverse of the short cards' order). */
const TALL_FIT = [{ selector: '.custom-panel-table tbody tr', last: true }, { selector: '.custom-request' }, { selector: '.custom-number-column' }, { selector: '.custom-stage-counts' }, { selector: '.custom-quote-column' }, { selector: '.custom-payment-column' }] as const;
const TALL_ROWS = 10;
export function CustomOrderPanel(props: WidgetPanelProps) {
  const tr = useBundle(customOrderListBundle);
  const { model, rows, state, port, read } = useCustomOrderModel();
  const compactState = props.height === 1 && props.width <= 2;
  if (state === 'error' || !model) return <CustomError onRetry={props.host.resetPreview} compact={compactState} />;
  const openRegister = () => props.host.openDetail({ featureId: props.featureId, view: 'register' });
  if (state === 'empty' || !rows.length) return <div lang="ko"><PanelState tone="info" message={tr.t('widget.custom-order.empty')} action={{ label: '주문 접수하기', widgetName: '주문제작', onPress: openRegister }} /></div>;
  const m = model.summary;
  const today = read?.businessDate ?? read?.now?.slice(0, 10) ?? TODAY;
  const pickupText = (row: CustomOrderRow) => pickupLabel(tr, pickupOf(row), today);
  const compact = props.width === 1 && props.height === 1;
  const wide = props.width >= 3 && props.height >= 2;
  // D-333: a wide card 4 rows high has room for what the short ones drop: the stage counts, the order number column, the customer's request and more orders. Nothing is added that the order does not hold.
  const tall = wide && props.height >= 4;
  const stageChip = (row: CustomOrderRow) => <CustomOrderStageChip stage={row.stage} />;
  const action = <PanelAction label="주문 접수하기" widgetName="주문제작" onPress={openRegister} />;
  const counts = [{ label: '승인 대기', value: m.approvalPending }, { label: '결제 대기', value: rows.filter(row => row.stage === 'payment_pending').length }, { label: '제작 중', value: rows.filter(row => row.stage === 'in_production').length }, { label: '제작 완료', value: rows.filter(row => row.stage === 'production_complete').length }];
  return <div className="custom-panel" data-width={props.width} data-height={props.height} lang="ko">
    <div className="custom-panel-summary"><div className="custom-primary"><MetricFit value={String(m.inProgress)} unit="건" longest="999" stacked={false} /><p className="custom-label">진행 중</p></div>
      {(props.width === 2 && props.height >= 2 || tall) && <div className="custom-stage-counts">{counts.map(item => <div key={item.label}><strong>{item.value}</strong><p>{item.label}</p></div>)}</div>}
    </div>
    {!compact && (props.height === 1 ? <div className="custom-panel-list"><div className="custom-value-row"><span>승인 대기</span><strong>{m.approvalPending}건</strong></div><div className="custom-value-row"><span>오늘 픽업</span><strong>{m.todayPickup}건</strong></div>{props.width >= 3 && rows[0] && <div className="custom-value-row custom-extra-row"><span>{orderNumber(rows[0].customOrderId)}</span>{stageChip(rows[0])}</div>}</div>
      : wide ? <div className="custom-panel-table"><table><thead><tr>{tall && <th className="custom-number-column">주문 번호</th>}<th className="custom-pickup-column">픽업 일시</th><th>손님</th><th>상품</th><th className="custom-quote-column">견적</th><th className="custom-payment-column">결제 상태</th><th>제작 상태</th></tr></thead><tbody>{rows.slice(0, tall ? TALL_ROWS : props.height >= 3 ? 6 : 3).map(row => <tr key={row.customOrderId}>{tall && <td className="custom-number-column">{orderNumber(row.customOrderId, row.orderNo)}</td>}<td className="custom-pickup-column">{pickupText(row)}</td><td>{customer(row, port)}</td><td>{row.productLabel}{tall && row.request.trim() ? <p className="custom-request">{row.request.trim()}</p> : null}</td><td className="custom-quote-column">{row.quoteAmount === null ? '—' : money(row.quoteAmount)}</td><td className="custom-payment-column"><PaymentChip status={row.payment.status} /></td><td>{stageChip(row)}</td></tr>)}</tbody></table></div>
      : <div className="custom-panel-list">{rows.slice(0, props.height > 2 ? 4 : 2).map(row => <div className="custom-order-row" key={row.customOrderId}><strong className="custom-order-name">{customer(row, port)} · {row.productLabel}</strong><div className="custom-order-meta"><span>{pickupText(row)}</span>{props.width === 1 && stageChip(row)}</div>{props.width > 1 && stageChip(row)}</div>)}{props.width === 1 && <PanelRemainder total={rows.length} rowSelector=".custom-order-row" unit="건" />}</div>)}
    {props.width >= 2 && props.height >= 2 && action}
    <FitProbe order={tall ? TALL_FIT : SHORT_FIT} deps={[props.width, props.height, m.inProgress, m.todayPickup]} />
  </div>;
}

function CustomError({ onRetry, compact = false }: { onRetry: () => void; compact?: boolean }) {
  return <PanelState tone="error" message="주문제작 내역을 불러오지 못했어요" shortMessage={compact ? '불러오지 못했어요' : undefined} action={{ label: '다시 시도하기', widgetName: '주문제작', onPress: onRetry }} />;
}

export function CustomOrderDetail({ host, detailRef }: WidgetDetailProps) {
  const tr = useBundle(customOrderListBundle);
  const { t } = tr;
  const [tab, setTab] = useState<'orders' | 'templates'>(detailRef.view === 'templates' ? 'templates' : 'orders'), [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(detailRef.view === 'templates' ? null : detailRef.itemId ?? null), [adding, setAdding] = useState(detailRef.view === 'register');
  const [focus, setFocus] = useState<GridFocus>(null);
  const [recording, setRecording] = useState<{ readonly action: CustomMoneyAction; readonly row: CustomOrderRow } | null>(null);
  // Column minimums are what the longest value needs at the current text size, so the kit drops the low-priority columns beside the panel before any text runs into its neighbour (DS 12.1).
  const { textScale } = useUi();
  const need = (px: number) => Math.ceil(px * (textScale === 125 ? 1.25 : 1));
  const { model, rows: allRows, port, state, read } = useCustomOrderModel();
  if (state === 'error' || !model || !port) return <CustomError onRetry={host.resetPreview} />;
  const today = read?.businessDate ?? read?.now?.slice(0, 10) ?? TODAY, now = read?.now ?? NOW;
  if (detailRef.view === 'pickup') {
    const pickup = allRows.find(row => row.pickup?.reservationId === detailRef.itemId)?.pickup;
    return <PickupReservations date={pickup?.date ?? today} reservationId={pickup?.reservationId} host={host} />;
  }
  const text = query.trim().toLocaleLowerCase();
  const rows = !text ? allRows : allRows.filter(row => [row.customOrderId, orderNumber(row.customOrderId, row.orderNo), row.productLabel, customer(row, port), row.guest?.name, row.guest?.phone, row.request].join(' ').toLocaleLowerCase().includes(text));
  const current = rows.find(row => row.customOrderId === selected);
  const notify = (result: CustomUiResult) => { if (result.ok && result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, params: result.params, undoToken: result.undoToken, ...(result.undoUntil ? { undoUntil: result.undoUntil } : {}) }); };
  return <div className="custom-detail" data-widget="custom-order" lang="ko">
    <DetailTabs value={tab} onValueChange={setTab} label="주문제작 보기" tabs={[{ value: 'orders', label: '주문제작 목록' }, { value: 'templates', label: '템플릿 관리' }]} />
    {tab === 'templates' ? <TemplateManager port={port} templates={model.templates} notify={notify} initialTemplateId={detailRef.view === 'templates' ? detailRef.itemId : undefined} /> : <div className="custom-workspace" data-short-list={rows.length < 3 || undefined}>
      <DataGrid id="custom-orders" label="주문제작 목록" rows={rows} getRowId={row => row.customOrderId} getRowLabel={row => `${orderNumber(row.customOrderId, row.orderNo)} ${row.productLabel}`} columns={[
        { id: 'order', header: '주문', kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: row => orderNumber(row.customOrderId, row.orderNo), render: row => <ActionButton id={`custom-${row.customOrderId}`} variant="ghost" aria-label={`${orderNumber(row.customOrderId, row.orderNo)} ${row.productLabel}`} onClick={() => setSelected(row.customOrderId)}>{orderNumber(row.customOrderId, row.orderNo)}</ActionButton> },
        { id: 'pickup', header: '픽업 일시', kind: 'text', minWidth: need(152), value: row => pickupLabel(tr, pickupOf(row), today) },
        { id: 'customer', header: '손님', kind: 'text', minWidth: need(128), dropOrder: 3, value: row => customer(row, port) },
        { id: 'product', header: '상품', kind: 'text', minWidth: need(184), value: row => row.productLabel },
        { id: 'quote', header: '견적 금액', kind: 'number', minWidth: need(112), dropOrder: 2, value: row => row.quoteAmount === null ? '—' : money(row.quoteAmount) },
        { id: 'payment', header: '결제 상태', kind: 'status', minWidth: need(136), dropOrder: 1, value: row => paymentLabels[row.payment.status], render: row => <PaymentChip status={row.payment.status} /> },
        { id: 'stage', header: '진행 상태', kind: 'status', minWidth: need(144), value: row => stageLabels[row.stage], render: row => <CustomOrderStageChip stage={row.stage} /> },
      ]} query={query} onQueryChange={setQuery} searchLabel={t('widget.custom-order.search')} searchPlaceholder={t('widget.custom-order.searchPlaceholder')} noResultsContent={t('widget.custom-order.noResults')} emptyContent={t('widget.custom-order.empty')}
      addAction={{ id: 'add', label: '주문 접수하기', onPress: () => { setAdding(true); setSelected(null); } }}
      renderAddRow={() => adding ? <ReceiptForm port={port} templates={model.templates} prefill={customReceiptPrefill(detailRef)} focusProduct={detailRef.view === 'register'} today={today} now={now} onClose={() => setAdding(false)} onSaved={result => { notify(result); setAdding(false); }} /> : null}
      sort={null} onSortChange={() => {}} focus={focus} onFocusChange={setFocus} selectedRowId={selected} onSelectionChange={setSelected} expandedRowIds={NO_EXPANDED} />
      <OrderSidePanel row={current} selected={selected} onClose={() => setSelected(null)} port={port} detailRef={detailRef} notify={notify} onMoney={(action, order) => setRecording({ action, row: order })} tr={tr} today={today} now={now} />
    </div>}
    {/* The record dialog lives here, not in the side panel: recording a cancellation changes the order row, and the owner must still see the confirmation. */}
    {recording && <CustomMoneyDialog action={recording.action} row={recording.row} port={port} returnFocusRef={orderButtonRef(recording.row.customOrderId)} close={() => setRecording(null)} onDone={notify} />}
  </div>;
}

/** Focus goes back to the order's button in the list (the panel's own button may be gone once the order changed). */
const orderButtonRef = (customOrderId: string) => ({ get current() { return document.getElementById(`custom-${customOrderId}`); } });
type OpenMoney = (action: CustomMoneyAction, row: CustomOrderRow) => void;

/** The kit DetailSidePanel: top aligned, 24 padding, only its own body scrolls; the cancel/refund action sits in the `danger` slot so nothing follows it. */
function OrderSidePanel({ row, selected, onClose, port, detailRef, notify, onMoney, tr, today, now }: { row: CustomOrderRow | undefined; selected: string | null; onClose: () => void; port: CustomOrderPort; detailRef: WidgetDetailProps['detailRef']; notify: (result: CustomUiResult) => void; onMoney: OpenMoney; tr: Translate; today: string | undefined; now: string | undefined }) {
  return <DetailSidePanel open={!!row} selectedRowId={selected} title={row ? `${orderNumber(row.customOrderId, row.orderNo)} · ${stageLabels[row.stage]}` : '주문제작'} onClose={onClose} returnFocusKey={`custom-${selected}`} onRestoreFocus={key => document.getElementById(key)?.focus({ preventScroll: true })}
    danger={row && hasDanger(row) ? <OrderDanger key={row.customOrderId} row={row} port={port} detailRef={detailRef} notify={notify} onMoney={onMoney} /> : undefined}>
    {row && <OrderEditor key={`${row.customOrderId}:${row.quoteRevision}`} row={row} port={port} detailRef={detailRef} notify={notify} onMoney={onMoney} tr={tr} today={today} now={now} />}
  </DetailSidePanel>;
}

const isActive = (row: CustomOrderRow) => row.stage !== 'canceled' && row.stage !== 'received_by_customer';
const isRefundable = (row: CustomOrderRow) => row.payment.amountSettled > row.payment.amountReturned;
const hasDanger = (row: CustomOrderRow) => isActive(row) || isRefundable(row);
/** Cancel an active order, or refund a finished one: the last item of the panel body. */
function OrderDanger({ row, port, detailRef, notify, onMoney }: { row: CustomOrderRow; port: CustomOrderPort; detailRef: WidgetDetailProps['detailRef']; notify: (result: CustomUiResult) => void; onMoney: OpenMoney }) {
  const [confirmCancel, setConfirmCancel] = useState(false), [error, setError] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const { pending, run } = useCustomRun(port);
  const refundFocus = detailRef.view === 'refund' && detailRef.itemId === row.customOrderId;
  useEffect(() => { if (refundFocus) button.current?.focus(); }, [refundFocus]);
  const active = isActive(row), refundable = isRefundable(row);
  const cancel = () => run({ type: 'customOrder.cancel', customOrderId: row.customOrderId, idempotencyKey: requestKey() }, result => { if (!result.ok) setError(commandError(result.reason)); else { setError(''); notify(result); setConfirmCancel(false); } });
  /** HTTP builds record the cancellation or refund through the service from this widget; the fixture build opens the simulated terminal of the POS host. */
  const reverse = (cancelOrder: boolean) => port.real ? onMoney({ kind: 'reversal', customOrderId: row.customOrderId, cancelOrder }, row)
    : port.openReversal({ customOrderId: row.customOrderId, cancelOrder }, { detailRef, selectedId: row.customOrderId, returnFocusRef: button });
  return <>
    {active
      ? <ActionButton variant="ghost" ref={button} onClick={() => { if (refundable) reverse(true); else setConfirmCancel(true); }}>주문 취소하기</ActionButton>
      : <ActionButton variant="ghost" ref={button} onClick={() => reverse(false)}>환불하기</ActionButton>}
    {confirmCancel && <InlineForm title="주문 취소하기" saveLabel="취소 확정하기" saving={pending} onClose={() => setConfirmCancel(false)} onSave={cancel}><p>연결된 픽업 예약도 함께 취소해요</p></InlineForm>}
    {error && <p role="alert" className="custom-error">{error}</p>}
  </>;
}

function OrderEditor({ row, port, detailRef, notify, onMoney, tr, today, now }: { row: CustomOrderRow; port: CustomOrderPort; detailRef: WidgetDetailProps['detailRef']; notify: (result: CustomUiResult) => void; onMoney: OpenMoney; tr: Translate; today: string | undefined; now: string | undefined }) {
  const initialPickup = row.confirmedPickupAt ?? row.proposedPickupAt ?? row.desiredPickupAt;
  const [quoteAmount, setQuoteAmount] = useState<number | null>(row.quoteAmount), [pickupAt, setPickupAt] = useState(initialPickup);
  const [productionAt, setProductionAt] = useState(row.productionAt ?? ''), [timing, setTiming] = useState(row.paymentTiming), [error, setError] = useState(''), [done, setDone] = useState('');
  const [edit, setEdit] = useState(false);
  const paymentButton = useRef<HTMLButtonElement>(null), receiptButton = useRef<HTMLButtonElement>(null);
  const { pending, run: runCommand } = useCustomRun(port);
  const focus = detailRef.itemId === row.customOrderId ? detailRef.view : undefined;
  useEffect(() => {
    if (focus === 'payment') paymentButton.current?.focus();
    if (focus === 'receive') receiptButton.current?.focus();
  }, [focus]);
  const approved = row.customerDecision === 'approved' && row.approvedQuoteRevision === row.quoteRevision;
  const active = isActive(row);
  const run = (command: CustomOrderCommand) => runCommand(command, result => {
    if (!result.ok) setError(commandError(result.reason)); else { setError(''); setDone('기록했어요'); notify(result); }
  });
  /** GD-1: a pickup time that has already passed is refused, but only when the person changed it (an old, unchanged time never blocks other edits). */
  const pickupRefused = (value: string, original: string | null) => {
    if (!value) { setError(commandError('REQUIRED_FIELD')); return true; }
    if (value !== original && isPastPickup(value, now)) { setError(tr.t('widget.custom-order.pickupPast')); return true; }
    return false;
  };
  const decision = (value: 'approved' | 'rejected' | 'revision_requested') => run({ type: 'customOrder.recordDecision', customOrderId: row.customOrderId, quoteRevision: row.quoteRevision, decision: value, paymentTiming: timing, idempotencyKey: requestKey() });
  return <div className="custom-editor">
    <div className="custom-toolbar"><CustomOrderStageChip stage={row.stage} /><PaymentChip status={row.payment.status} /></div>
    <h4>{row.productLabel}</h4><p>{customer(row, port)} {row.guest?.phone ? maskPhone(row.guest.phone) : ''} · {channelLabels[row.channel]}</p><p>{[...row.options, `${row.quantity}개`].join(' · ')}</p><p>{row.request}</p>
    {port.real && row.referencePhotoKeys.length > 0 && <ReferencePhotos files={port.real.files} ids={row.referencePhotoKeys} />}
    <dl className="custom-facts"><div><dt>희망 픽업 일시</dt><dd>{pickupLabel(tr, row.desiredPickupAt, today)}</dd></div><div><dt>확정 픽업 일시</dt><dd>{row.confirmedPickupAt ? pickupLabel(tr, row.confirmedPickupAt, today) : '—'}</dd></div><div><dt>결제 시점</dt><dd>{row.paymentTiming === 'advance' ? '미리 결제' : '받을 때 결제'}</dd></div><div><dt>결제 상태</dt><dd>{paymentLabels[row.payment.status]} · {money(row.payment.amountSettled)}</dd></div>{row.payment.chargeApplied > 0 && <div><dt>충전금 사용</dt><dd>{money(row.payment.chargeApplied)}</dd></div>}{row.payment.receivableAmount > 0 && <div><dt>외상</dt><dd>{money(row.payment.receivableAmount)}</dd></div>}</dl>
    {active && <ActionButton variant="secondary" onClick={() => setEdit(!edit)}>주문 고치기</ActionButton>}
    {edit && <ReceiptForm port={port} templates={[]} order={row} today={today} now={now} onClose={() => setEdit(false)} onSaved={result => { notify(result); setEdit(false); }} />}
    {active && <>
      <InlineForm title="견적·승인" saveLabel="견적 저장하기" saving={pending} onClose={() => { setQuoteAmount(row.quoteAmount); setError(''); }} onSave={() => {
        if (quoteAmount === null || !Number.isSafeInteger(quoteAmount) || quoteAmount <= 0) { setError('견적 금액을 1원 이상 넣어 주세요'); return; }
        if (pickupRefused(pickupAt, initialPickup)) return;
        run({ type: 'customOrder.quote', customOrderId: row.customOrderId, quoteAmount, proposedPickupAt: pickupAt, productionAt: productionAt || null, idempotencyKey: requestKey() });
      }}><NumberField label="견적 금액" value={quoteAmount} onValueChange={setQuoteAmount} unit="원" /><DateTimeField label="확정 픽업 일시" dateLabel="확정 픽업 날짜" timeLabel="확정 픽업 시각" today={today} value={pickupAt} onValueChange={setPickupAt} /><DateTimeField label="내부 제작 일정(선택)" dateLabel="내부 제작 날짜(선택)" timeLabel="내부 제작 시각(선택)" today={today} clearable value={productionAt} onValueChange={setProductionAt} /><SegmentedControl label="결제 시점" value={timing} onChange={setTiming} options={[{ value: 'advance', label: '미리 결제' }, { value: 'on_pickup', label: '받을 때 결제' }]} /></InlineForm>
      {/* SCR-276 names these buttons "{상태}로 바꾸기"; DS 7 N-4 lists that wording as banned. Kept as SCR-276/LOCALES spell it (reported for R4). */}
      <div className="custom-toolbar"><ActionButton variant="secondary" disabled={row.quoteAmount === null} onClick={() => decision('approved')}>승인으로 바꾸기</ActionButton><ActionButton variant="secondary" disabled={row.quoteAmount === null} onClick={() => decision('rejected')}>거절로 바꾸기</ActionButton><ActionButton variant="secondary" disabled={row.quoteAmount === null} onClick={() => decision('revision_requested')}>수정 요청으로 바꾸기</ActionButton></div>
      {row.pickup && <InlineForm title="픽업 일시 고치기" saveLabel="픽업 일시 고치기" saving={pending} onClose={() => setPickupAt(row.confirmedPickupAt ?? '')} onSave={() => { if (row.pickup && !pickupRefused(pickupAt, row.confirmedPickupAt)) run({ type: 'pickup.reschedule', reservationId: row.pickup.reservationId, date: pickupAt.slice(0, 10), time: pickupAt.slice(11, 16), idempotencyKey: requestKey() }); }}><DateTimeField label="픽업 일시" dateLabel="픽업 날짜" timeLabel="픽업 시각" today={today} value={pickupAt} onValueChange={setPickupAt} /></InlineForm>}
      <div className="custom-toolbar"><ActionButton ref={paymentButton} disabled={!approved || row.payment.status === 'paid'} onClick={() => port.real ? onMoney({ kind: 'payment', customOrderId: row.customOrderId }, row) : port.openSettlement({ purpose: 'custom_order', customOrderId: row.customOrderId }, { detailRef, selectedId: row.customOrderId, returnFocusRef: paymentButton })}>결제 받기</ActionButton>
        {row.stage === 'payment_pending' && <ActionButton variant="secondary" disabled={!approved || row.payment.status !== 'paid'} onClick={() => run({ type: 'customOrder.setStage', customOrderId: row.customOrderId, nextStage: 'in_production', idempotencyKey: requestKey() })}>제작 시작으로 바꾸기</ActionButton>}
        {row.stage === 'in_production' && <ActionButton disabled={!approved} onClick={() => run({ type: 'customOrder.setStage', customOrderId: row.customOrderId, nextStage: 'production_complete', idempotencyKey: requestKey() })}>제작 완료로 바꾸기</ActionButton>}
        {row.stage === 'production_complete' && <ActionButton ref={receiptButton} disabled={!approved || row.payment.status !== 'paid'} onClick={() => run({ type: 'customOrder.receive', customOrderId: row.customOrderId, idempotencyKey: requestKey() })}>수령 완료로 바꾸기</ActionButton>}
      </div>{!approved && <p>손님 승인을 먼저 기록해 주세요</p>}    </>}
    {error && <p role="alert" className="custom-error">{error}</p>}<p role="status" aria-live="polite">{done}</p>
    <section aria-label="변경 이력"><h4>변경 이력</h4><ul>{row.history.map(entry => <li key={entry.historyId}>{tr.format.dateTime(entry.at, { today })} · {historyText(tr, entry, today)}</li>)}</ul></section>
  </div>;
}

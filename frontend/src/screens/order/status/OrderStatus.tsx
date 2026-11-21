import { useEffect, useMemo, useRef, useState } from 'react';
import type { PosOrder } from '../../../contracts/pos';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { ordersBundle } from '../../../i18n/messages/pos-legacy';
import { POS_NOW, POS_NOW_TIME } from '../../../pos/clock';
import { dataBundles, resolveDataText, selectMembers } from '../../../data/widget-data';
import { useWidgetDataStore } from '../../../data/react';
import { usePosStatusSession, usePosSnapshot } from '../../../pos/react';
import { ActionButton, CategoryChips, MetricFit, DataGrid, DetailSidePanel, ErrorPanel, InlineEmpty, PosMoney, PosStatusChip, layoutTokens, posClasses, posLayoutTokens, type GridColumn, type GridFocus, type GridSort } from '../../../ui';
import { selectOrderDetail } from '../read';
import { selectOrderSummary, type OrderFilter, type OrderStatusRow } from '../../../pos/status';
import type { ComposerNotice } from '../Composer';
import { Icon, timePolicy, type DataGridHandle } from '../../../ui';
import { useStatusMotion } from './motion';
import { useUi } from '../../../ui';
import { selectPaymentRemaining, selectReceipt } from '../../../pos/reversals';
import type { ReversalReceiptEntry } from '../ReversalReceipt';
import { receiptBundle, loyaltyBundle } from '../messages';
import { formatPosMoney } from '../../../ui';
import './status.css';

export function OrderStatus({ onRetry, onNotice, onOpenReceipt }: { onRetry: () => void; onNotice: (notice: ComposerNotice) => void; onOpenReceipt: (entry: ReversalReceiptEntry) => void }) {
  const runtime = usePosStatusSession(), read = usePosSnapshot(), { t, format } = useBundle(posBundle, ordersBundle, loyaltyBundle, receiptBundle, ...dataBundles);
  const filter: OrderFilter = read.posUi.statusFilter ?? 'open', selected = read.posUi.selectedOrderId ?? null;
  const setSelected = (id: string | null) => runtime.selectStatus(filter, id);
  const serial = useRef(0), grid = useRef<DataGridHandle>(null);
  const [highlight, setHighlight] = useState(read.posUi.orderHighlight?.token);
  useEffect(() => { const token = read.posUi.orderHighlight?.token; setHighlight(token); if (!token) return; const timer = window.setTimeout(() => setHighlight(undefined), timePolicy.existingHighlightMs); return () => window.clearTimeout(timer); }, [read.posUi.orderHighlight?.token]);
  const [sort, setSort] = useState<GridSort>(null), [focus, setFocus] = useState<GridFocus>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const summary = selectOrderSummary(read, { filter }), { counts, rows: source } = summary;
  const rows = useMemo(() => !sort ? source : [...source].sort((a, b) => {
    const av = sort.columnId === 'amount' ? selectOrderDetail(read, a).gross : sort.columnId === 'number' ? a.orderNo : a.orderedAt;
    const bv = sort.columnId === 'amount' ? selectOrderDetail(read, b).gross : sort.columnId === 'number' ? b.orderNo : b.orderedAt;
    return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * (sort.direction === 'asc' ? 1 : -1);
  }), [source, sort, read]);
  const selectedOrder = selectOrderSummary(read, { filter: 'all' }).rows.find(order => order.orderId === selected);
  const detail = selectedOrder ? selectOrderDetail(read, selectedOrder) : null;
  const payments = selectedOrder ? read.pos.payments.filter(payment => selectedOrder.billIds.includes(payment.billId)).flatMap(payment => {
    const receipt = selectReceipt(read, { paymentId: payment.paymentId });
    if (!receipt) return [];
    const bill = read.pos.bills.find(candidate => candidate.billId === payment.billId);
    const partIndex = bill?.splitPlan?.parts.findIndex(part => part.partId === payment.partId) ?? -1;
    const label = partIndex >= 0 ? t('pay.shareNumber', { n: partIndex + 1 }) : receipt.transactionNo;
    return [{ payment, receipt, balance: selectPaymentRemaining(read.pos, payment.paymentId), label }];
  }) : [];
  const data = useWidgetDataStore();
  const memberId = read.pos.bills.find(bill => selectedOrder?.billIds.includes(bill.billId) && bill.memberId)?.memberId;
  const member = memberId ? selectMembers(data.getSnapshot(), {}).rows.find(member => member.memberId === memberId) : null;
  const baseStatus = (order: PosOrder) => t(order.preparation === 'completed' ? 'widget.order-status.complete' : order.preparation === 'preparing' ? 'widget.order-status.open' : `pos.${order.preparation}`);
  const status = (order: OrderStatusRow) => `${order.isMissing ? `⚠ ${t('widget.order-status.missing')} · ` : order.isSlow ? `⏱ ${t('widget.order-status.slow')} · ` : ''}${baseStatus(order)}`;
  const { reducedMotion } = useUi();
  const captureMotion = useStatusMotion(root, rows.map(row => row.id), reducedMotion);
  const process = (order: OrderStatusRow, type: 'order.start' | 'order.complete' | 'order.reopen' | 'order.cancelUnpaid') => {
    if ((type === 'order.complete' || type === 'order.cancelUnpaid') && filter === 'open' || type === 'order.reopen' && filter === 'done') captureMotion(order.id);
    const result = runtime.execute({ type, orderId: order.id, meta: { runId: read.runId, idempotencyKey: `status:${++serial.current}:${read.posRevision}` } });
    if (!result.ok) { onNotice({ message: t('pos.stateConflict') }); return; }
    if (result.status === 'unchanged' || result.duplicate) return;
    onNotice({ message: t(type === 'order.start' ? 'pos.startedPreparing' : type === 'order.complete' ? 'pos.completedOrder' : type === 'order.cancelUnpaid' ? 'pos.canceledOrder' : 'pos.changed', { n: order.no }), undoToken: result.undoToken });
    if (type === 'order.complete' || type === 'order.cancelUnpaid') {
      setSelected(null); const next = rows[rows.findIndex(row => row.id === order.id) + 1];
      requestAnimationFrame(() => { if (!next || !grid.current?.focusRowAction(next.id, 'order.complete')) root.current?.querySelector<HTMLElement>('[role=radio][aria-checked=true]')?.focus(); });
    }
  };
  const actions = (order: OrderStatusRow) => [
    ...(order.preparation === 'accepted' ? [{ id: 'order.start' as const, label: t('pos.startPreparing'), onPress: () => process(order, 'order.start') }] : []),
    ...(order.preparation === 'accepted' || order.preparation === 'preparing' ? [{ id: 'order.complete' as const, label: t('widget.order-status.complete'), onPress: () => process(order, 'order.complete') }] : []),
    ...(order.canReopen ? [{ id: 'order.reopen' as const, label: t('pos.backToPreparing'), onPress: () => process(order, 'order.reopen') }] : []),
  ];
  const type = (order: PosOrder) => t(order.type === 'dine_in' ? 'pos.dineIn' : 'pos.takeout');
  const content = (order: PosOrder) => order.lines.map(line => `${line.nameAtOrder} ${line.qty}`).join(' · ');
  const elapsed = (order: PosOrder) => Math.max(0, Math.round((Date.parse(order.completedAt ?? POS_NOW) - Date.parse(order.orderedAt)) / 60000));
  const time = (order: PosOrder) => t(order.preparation === 'completed' ? 'widget.order-status.row.doneTime' : 'widget.order-status.row.time', { time: order.orderedAt.slice(11), n: elapsed(order) });
  const columns: readonly GridColumn<OrderStatusRow>[] = [
    { id: 'number', header: t('pos.orderNo'), kind: 'number', value: order => order.orderNo, render: order => <strong data-highlighted={highlight && read.posUi.orderHighlight?.orderId === order.id || undefined}>#{order.orderNo}</strong>, minWidth: posLayoutTokens.common.orderNumberWidth, sortable: true },
    { id: 'time', header: t('pos.orderedAt'), kind: 'text', value: order => order.orderedAt, render: time, minWidth: posLayoutTokens.common.orderTimeWidth, sortable: true },
    { id: 'type', header: t('pos.type'), kind: 'text', value: type, minWidth: layoutTokens.railWidth },
    ...(read.settings.tableLayout && read.settings.paymentStyle === 'postpaid' ? [{ id: 'tables', header: t('pos.tables'), kind: 'text' as const, value: (order: OrderStatusRow) => order.tableIds.join(' · '), minWidth: layoutTokens.railWidth }] : []),
    { id: 'content', header: t('pos.content'), kind: 'text', value: content, minWidth: posLayoutTokens.common.orderProcessWidth },
    { id: 'amount', header: t('pos.amount'), kind: 'number', value: order => selectOrderDetail(read, order).gross, render: order => <PosMoney amount={selectOrderDetail(read, order).gross}/>, minWidth: posLayoutTokens.common.prepareWidth, sortable: true },
    { id: 'status', header: t('pos.preparation'), kind: 'status', value: status, render: order => <PosStatusChip tone={order.isMissing ? 'warning' : order.preparation === 'completed' ? 'success' : 'neutral'}>{status(order).replace(/^[⚠⏱] /u, '')}</PosStatusChip>, minWidth: posLayoutTokens.common.menuCardHeight },
    { id: 'payment', header: t('pos.paymentStatus'), kind: 'status', value: order => t(`pos.${order.paymentStatus}`), minWidth: posLayoutTokens.common.prepareWidth },
  ];
  const restore = () => {
    const node = root.current?.querySelector<HTMLElement>(`[data-grid-row-id="${CSS.escape(selected ?? '')}"][data-grid-column-id="number"]`) ?? root.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    node?.focus({ preventScroll: true });
  };
  if (read.scenario === 'error') return <div className="order-status"><ErrorPanel title={t('pos.errorOrders')} actions={<ActionButton onClick={onRetry}>{t('pos.retry')}</ActionButton>}/></div>;
  return <div ref={root} lang="ko" className="order-status" data-side-panel={!!selectedOrder||undefined}>
    <div className="order-status__summary order-status__summary--m2">{[
      { key: 'pos.todayCount', value: t('widget.order-status.count', { n: summary.todayCount }) },
      { key: 'widget.order-status.open', value: t('widget.order-status.count', { n: summary.openCount }) },
      { key: 'widget.order-status.avgWait', value: summary.avgWaitMin === null ? t('widget.order-status.avgWait.none') : t('widget.order-status.avgWait.value', { n: summary.avgWaitMin }) },
      { key: 'widget.order-status.slow', value: t('widget.order-status.count', { n: summary.slowCount }), tone: summary.slowCount ? 'warning' : undefined },
      { key: 'widget.order-status.missing', value: t('widget.order-status.count', { n: summary.missingCount }), tone: summary.missingCount ? 'missing' : undefined },
      { key: 'pos.orderRush', value: t(summary.rush ? 'pos.rushing' : 'widget.order-status.rush.normal'), tone: summary.rush ? 'warning' : undefined },
    ].map(item => {
      const parts=item.value.match(/^([\d,.]+)(.*)$/u);
      return <section className="ui-glass-tile" key={item.key} aria-label={t(item.key)} data-tone={item.tone}><strong>{item.tone ? <Icon name={item.tone === 'missing' ? 'warning' : 'clock'}/> : null}<MetricFit value={parts?.[1]??item.value} unit={parts?.[2]||undefined} presentation="hero"/></strong><h2>{t(item.key)}</h2></section>;
    })}</div>
    <div className="order-status__tools"><CategoryChips label={t('pos.statusFilter')} value={filter} options={(['open', 'done', 'canceled', 'all'] as const).map(value => ({ value, label: `${t(value === 'open' ? 'widget.order-status.open' : value === 'done' ? 'widget.order-status.complete' : value === 'canceled' ? 'pos.canceled' : 'pos.all')} ${counts[value]}` }))} onChange={value => { runtime.selectStatus(value, null); setSort(null); }}/><span>{t('widget.order-status.basis', { date: format.date(read.pos.businessDate, 'long'), time: POS_NOW_TIME })}</span></div>
    {summary.rush ? <div className="order-status__rush" role="status"><Icon name="warning"/>{t('widget.order-status.rush.notice')}</div> : null}
    <div className={`${posClasses.orderGrid} order-status__grid`}>
      <DataGrid ref={grid} id="pos-orders" label={t('pos.status')} rows={rows} getRowId={order => order.orderId} getRowLabel={order => t('widget.order-status.aria.row', { no: order.orderNo, item: content(order), time: order.orderedAt.slice(11), n: elapsed(order), status: status(order) })} columns={columns} rowActionsLabel={t('pos.processing')} getRowActions={actions} renderRowActions={(order, items) => <div className={posClasses.orderActions} data-status={order.isMissing ? 'missing' : order.isSlow ? 'slow' : undefined}>{items.map(action => <ActionButton key={action.id} className={action.id === 'order.start' ? posClasses.prepare : action.id === 'order.complete' ? posClasses.complete : undefined} variant={action.id === 'order.complete' ? 'default' : 'secondary'} onClick={action.onPress}>{action.label}</ActionButton>)}</div>} sort={sort} onSortChange={setSort} selectedRowId={selectedOrder?.orderId ?? null} onSelectionChange={setSelected} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} obscuredCells={selectedOrder ? new Set(rows.flatMap(order => ['amount', 'status', 'payment', '$actions'].map(column => `${order.orderId}:${column}`))) : undefined} emptyContent={<InlineEmpty title={t(!counts.all ? 'pos.emptyOrders' : filter === 'open' ? 'widget.order-status.empty.open' : 'pos.emptyFilter')}/>}/>
    </div>
    <DetailSidePanel open={!!selectedOrder} selectedRowId={selectedOrder?.orderId ?? null} title={selectedOrder ? `#${selectedOrder.orderNo} · ${status(selectedOrder)}` : t('pos.status')} onClose={() => setSelected(null)} returnFocusKey={selected ?? 'pos-orders'} onRestoreFocus={restore} footer={selectedOrder ? <div className="order-status__detail-actions">{actions(selectedOrder).map(action => <ActionButton key={action.id} variant={action.id === 'order.complete' ? 'default' : 'secondary'} onClick={action.onPress}>{action.label}</ActionButton>)}{selectedOrder.paymentStatus === 'unpaid' && selectedOrder.preparation !== 'canceled' ? <ActionButton variant="ghost" onClick={() => process(selectedOrder, 'order.cancelUnpaid')}>{t('pos.cancelUnpaid')}</ActionButton> : null}</div> : undefined}>
      {selectedOrder && detail ? <div lang="ko" className="order-status__detail"><p>{time(selectedOrder)} · {type(selectedOrder)}{selectedOrder.tableIds.length ? ` · ${selectedOrder.tableIds.join(' · ')}` : ''}</p><section><h4>{t('pos.menu')}</h4>{selectedOrder.lines.map(line => <div key={line.orderLineId}><strong>{line.nameAtOrder} · {line.qty}</strong><p>{line.optionsAtOrder.map(option => option.name).join(' · ')}</p>{line.request ? <p>{t('pos.request', { text: line.request })}</p> : null}<PosMoney amount={line.unitPriceAtOrder * line.qty}/></div>)}</section>{selectedOrder.memo ? <section><h4>{t('pos.memo')}</h4><p>{selectedOrder.memo}</p></section> : null}<section><h4>{t('pos.payment')}</h4><dl><div><dt>{t('pos.goodsAmount')}</dt><dd><PosMoney amount={detail.gross}/></dd></div><div><dt>{t('pos.discount')}</dt><dd><PosMoney amount={detail.discount}/></dd></div><div><dt>{t('pos.payable')}</dt><dd><PosMoney amount={detail.payable} size="control"/></dd></div></dl>{payments.map(({ payment, receipt, balance, label }) => {
          const view = selectedOrder.preparation === 'accepted' ? 'cancel' : 'refund';
          const summary = receipt.splits.map(split => `${t(`pos.${split.method}`)} ${formatPosMoney(split.amount)}`).join(' + ');
          return <div key={payment.paymentId} role="group" aria-label={`${label} · ${summary}`} data-payment-id={payment.paymentId} className={posClasses.summary}>
            <strong>{label} · {summary}</strong><p>{t('pos.discountComposition', { membership: format.money(receipt.discounts.find(d => d.source === 'membership')?.amount ?? 0, 'full'), coupon: format.money(receipt.discounts.find(d => d.source === 'coupon')?.amount ?? 0, 'full'), direct: format.money(receipt.discounts.find(d => d.source === 'direct')?.amount ?? 0, 'full') })}</p>
            <dl className={posClasses.receipt}>{receipt.splits.map(split => <div key={split.method} data-payment-method={split.method}><dt>{t(`pos.${split.method}`)}</dt><dd><PosMoney amount={split.amount}/></dd></div>)}</dl>
            <div className={posClasses.summaryRow}>
              <ActionButton variant="secondary" onClick={() => onOpenReceipt({ paymentId: payment.paymentId, view: 'receipt' })}>{t('receipt.receipt')}</ActionButton>
              {payment.recognizedAt && balance && balance.remaining > 0 && selectedOrder.preparation !== 'canceled' ? <ActionButton variant="destructive" disabled={read.data.dayClosed} onClick={() => onOpenReceipt({ paymentId: payment.paymentId, view })}>{t(view === 'cancel' ? 'receipt.cancel' : 'receipt.refund')}</ActionButton> : null}
            </div>
            {read.data.dayClosed && balance && balance.remaining > 0 ? <p>{t('order.reversal.DAY_CLOSED')}</p> : null}
          </div>;
        })}<p>{t(`pos.${selectedOrder.paymentStatus}`)}</p>{member ? <p>{t('pos.member')}: {typeof member.name === 'string' ? member.name : resolveDataText(t, member.name)} · {member.phone}</p> : null}</section><section><h4>{t('pos.history')}</h4><p>{t('pos.acceptedAt', { time: selectedOrder.orderedAt.slice(11) })}</p>{selectedOrder.preparedAt ? <p>{t('pos.preparedAt', { time: selectedOrder.preparedAt.slice(11) })}</p> : null}{selectedOrder.completedAt ? <p>{t('pos.completedAt', { time: selectedOrder.completedAt.slice(11) })}</p> : null}{selectedOrder.statusHistory?.map(event => <p key={event.eventId}>{t(event.kind === 'separate' ? 'pos.transferSeparate' : event.kind === 'move' ? 'pos.transferMove' : 'pos.transferMerge', { table: event.toTableId, time: event.at.slice(11, 16) })}</p>)}</section></div> : null}
    </DetailSidePanel>
  </div>;
}

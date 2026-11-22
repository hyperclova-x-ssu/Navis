import { useEffect, useMemo, useRef, useState } from 'react';
import type { PosOrder } from '../../../contracts/pos';
import type { PosProviderLinks } from '../../../data/reality/02/dto';
import type { NaverOrderStatusRow } from '../../../data/reality/02/naver';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { ordersBundle } from '../../../i18n/messages/pos-legacy';
import { POS_NOW, POS_NOW_TIME } from '../../../pos/clock';
import { dataBundles, resolveDataText, selectMembers } from '../../../data/widget-data';
import { formatMaskedCustomer } from '../../../data/customer-display';
import { useWidgetDataStore } from '../../../data/react';
import { usePosStatusSession, usePosSnapshot } from '../../../pos/react';
import { usePosBridge } from '../../../pos/remote-context';
import { ActionButton, CategoryChips, MetricFit, DataGrid, DetailSidePanel, ErrorPanel, InlineEmpty, PosMoney, PosStatusChip, layoutTokens, posClasses, posLayoutTokens, type GridAction, type GridColumn, type GridFocus, type GridSort } from '../../../ui';
import { selectOrderDetail } from '../read';
import { CONNECT_SOURCE, connectOrigin } from '../../../connect-kiosk/channel';
import { selectOrderSummary, type OrderFilter, type OrderStatusRow } from '../../../pos/status';
import type { ComposerNotice } from '../Composer';
import { Icon, timePolicy, type DataGridHandle } from '../../../ui';
import { useStatusMotion } from './motion';
import { useUi } from '../../../ui';
import { selectPaymentRemaining, selectReceipt } from '../../../pos/reversals';
import type { ReversalReceiptEntry } from '../ReversalReceipt';
import { receiptBundle, loyaltyBundle } from '../messages';
import { lineLabel, lineOptionCaption } from '../option-text';
import { rushBundle } from './rush-copy';
import { naverBundle } from './naver-copy';
import { naverRowBundle } from './naver-row-copy';
import { NaverOrderDetails } from './NaverOrderDetails';
import type { useNaverOrders } from './useNaverOrders';
import { formatPosMoney } from '../../../ui';
import './status.css';

type StatusRow = OrderStatusRow | NaverOrderStatusRow;

export function OrderStatus({ naver, openCount, onRetry, onNotice, onOpenReceipt }: {
  naver: ReturnType<typeof useNaverOrders>; openCount: number;
  onRetry: () => void; onNotice: (notice: ComposerNotice) => void;
  onOpenReceipt: (entry: ReversalReceiptEntry) => void;
}) {
  const runtime = usePosStatusSession(), read = usePosSnapshot(), { t, format } = useBundle(posBundle, ordersBundle, loyaltyBundle, receiptBundle, rushBundle, naverBundle, naverRowBundle, ...dataBundles);
  // REAL-PLAN F02: over HTTP the service moves an order through preparation (forward only; the service has no reopen).
  const bridge = usePosBridge(), moving = useRef(new Set<string>());
  const naverRemote = bridge?.remote.naver;
  const filter: OrderFilter = read.posUi.statusFilter ?? 'open', selected = read.posUi.selectedOrderId ?? null;
  const setSelected = (id: string | null) => runtime.selectStatus(filter, id);
  const serial = useRef(0), grid = useRef<DataGridHandle>(null);
  const [highlight, setHighlight] = useState(read.posUi.orderHighlight?.token);
  useEffect(() => { const token = read.posUi.orderHighlight?.token; setHighlight(token); if (!token) return; const timer = window.setTimeout(() => setHighlight(undefined), timePolicy.existingHighlightMs); return () => window.clearTimeout(timer); }, [read.posUi.orderHighlight?.token]);
  const [sort, setSort] = useState<GridSort>(null), [focus, setFocus] = useState<GridFocus>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const summary = selectOrderSummary(read, { filter }), source = summary.rows;
  const counts = { open: openCount, done: summary.counts.done + naver.rows.done.length, canceled: summary.counts.canceled, all: summary.counts.all + naver.rows.all.length };
  const posRows = useMemo(() => !sort ? source : [...source].sort((a, b) => {
    const av = sort.columnId === 'amount' ? selectOrderDetail(read, a).gross : sort.columnId === 'number' ? a.orderNo : a.orderedAt;
    const bv = sort.columnId === 'amount' ? selectOrderDetail(read, b).gross : sort.columnId === 'number' ? b.orderNo : b.orderedAt;
    return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * (sort.direction === 'asc' ? 1 : -1);
  }), [source, sort, read]);
  const naverRows = naver.rows[filter];
  const providerRows = sort?.columnId === 'number' ? [...naverRows].sort((a, b) => {
    const order = (a.publicOrderNumber ?? String(a.ordinal)).localeCompare(
      b.publicOrderNumber ?? String(b.ordinal), undefined, { numeric: true });
    return order * (sort.direction === 'asc' ? 1 : -1);
  }) : naverRows;
  const rows: readonly StatusRow[] = providerRows.length ? [...posRows, ...providerRows] : posRows;
  const selectedOrder = selectOrderSummary(read, { filter: 'all' }).rows.find(order => order.orderId === selected);
  const selectedNaver = naver.rows.all.find(row => row.id === selected);
  const detail = selectedOrder ? selectOrderDetail(read, selectedOrder) : null;
  const detailMemo = bridge && selectedOrder?.memo === CONNECT_SOURCE ? '' : selectedOrder?.memo;
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
  const processReal = async (order: OrderStatusRow, type: 'order.start' | 'order.complete') => {
    if (moving.current.has(order.id)) return;
    moving.current.add(order.id);
    if (type === 'order.complete' && filter === 'open') captureMotion(order.id);
    const result = await bridge!.setPreparation(order.id, type === 'order.start' ? 'preparing' : 'completed');
    moving.current.delete(order.id);
    if (!result.ok) { onNotice({ message: t('pos.stateConflict') }); return; }
    onNotice({ message: t(type === 'order.start' ? 'pos.startedPreparing' : 'pos.completedOrder', { n: order.no }) });
    if (type === 'order.complete') {
      setSelected(null); const next = rows[rows.findIndex(row => row.id === order.id) + 1];
      requestAnimationFrame(() => { if (!next || !grid.current?.focusRowAction(next.id, 'order.complete')) root.current?.querySelector<HTMLElement>('[role=radio][aria-checked=true]')?.focus(); });
    }
  };
  const process = (order: OrderStatusRow, type: 'order.start' | 'order.complete' | 'order.reopen' | 'order.cancelUnpaid') => {
    if (bridge) { if (type === 'order.start' || type === 'order.complete') void processReal(order, type); return; }
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
    ...(!bridge && order.canReopen ? [{ id: 'order.reopen' as const, label: t('pos.backToPreparing'), onPress: () => process(order, 'order.reopen') }] : []),
  ];
  // The service projects the source marker, while fixture orders carry the kiosk's payment memo.
  const type = (order: PosOrder) => {
    const isConnect = bridge ? order.memo === CONNECT_SOURCE : Boolean(connectOrigin(order));
    return `${t(order.type === 'dine_in' ? 'pos.dineIn' : 'pos.takeout')}${isConnect ? ` · ${CONNECT_SOURCE}` : ''}`;
  };
  const content = (order: PosOrder) => order.lines.map(line => lineLabel(read.data.catalog.items, line.menuId, line.nameAtOrder, line.optionsAtOrder, line.qty)).join(' · ');
  const elapsed = (order: PosOrder) => Math.max(0, Math.round((Date.parse(order.completedAt ?? POS_NOW) - Date.parse(order.orderedAt)) / 60000));
  const time = (order: PosOrder) => order.preparation === 'completed'
    ? `${order.orderedAt.slice(11, 16)} 주문`
    : t('widget.order-status.row.time', { time: order.orderedAt.slice(11, 16), n: elapsed(order) });
  const naverNumber = naver.label;
  const naverTime = (row: NaverOrderStatusRow) => row.naver.preparationMinutes == null ? '—' : t('naver.prep', { n: row.naver.preparationMinutes });
  const approval = (row: NaverOrderStatusRow) => {
    const payment = naver.settlement(row);
    return payment?.status === 'ready' ? payment.data.items.find(item => item.kind === 'approval') : undefined;
  };
  const paymentTime = (row: NaverOrderStatusRow) => {
    const raw = approval(row)?.payDate ?? '';
    const match = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}:\d{2}))?/u.exec(raw);
    return match ? `결제 ${match[4] ? format.time(match[4]) : format.date(match.slice(1, 4).join('-'), 'short')}` : '—';
  };
  const columns: readonly GridColumn<StatusRow>[] = [
    { id: 'number', header: t('pos.orderNo'), kind: 'number', value: order => 'naver' in order ? naverNumber(order) : order.orderNo, render: order => 'naver' in order
      ? <strong className="order-status__naver-number">{naverNumber(order)}</strong>
      : <strong data-highlighted={highlight && read.posUi.orderHighlight?.orderId === order.id || undefined}>#{order.orderNo}</strong>, minWidth: posLayoutTokens.common.orderNumberWidth, sortable: true },
    { id: 'time', header: t('pos.orderedAt'), kind: 'text', value: order => 'naver' in order ? approval(order)?.payDate ?? '' : order.orderedAt, render: order => 'naver' in order ? paymentTime(order) : time(order), minWidth: posLayoutTokens.common.orderTimeWidth, sortable: true },
    { id: 'type', header: t('pos.type'), kind: 'text', value: order => 'naver' in order ? t('orders') : type(order), render: order => 'naver' in order ? <PosStatusChip semantic="none">{t('orders')}</PosStatusChip> : type(order), minWidth: layoutTokens.railWidth },
    ...(read.settings.tableLayout && read.settings.paymentStyle === 'postpaid' ? [{ id: 'tables', header: t('pos.tables'), kind: 'text' as const, value: (order: StatusRow) => 'naver' in order ? '—' : order.tableIds.join(' · '), minWidth: layoutTokens.railWidth }] : []),
    { id: 'content', header: t('pos.content'), kind: 'text', value: order => 'naver' in order ? '—' : content(order), render: order => 'naver' in order ? '—' : <span className="order-status__content">{order.lines.map(line => <span key={line.orderLineId}>{lineLabel(read.data.catalog.items, line.menuId, line.nameAtOrder, line.optionsAtOrder, line.qty)}</span>)}</span>, minWidth: posLayoutTokens.common.orderProcessWidth },
    { id: 'amount', header: t('pos.amount'), kind: 'number', value: order => 'naver' in order ? approval(order)?.paySettleAmount ?? '—' : selectOrderDetail(read, order).gross, render: order => { const amount = 'naver' in order ? approval(order)?.paySettleAmount : selectOrderDetail(read, order).gross; return amount === undefined ? '—' : <PosMoney amount={amount}/>; }, minWidth: posLayoutTokens.common.prepareWidth, sortable: true },
    { id: 'status', header: t('pos.preparation'), kind: 'status', value: order => 'naver' in order ? t(order.naver.status) : status(order), render: order => 'naver' in order ? <PosStatusChip tone={order.naver.status === 'picked-up' ? 'success' : 'neutral'}>{t(order.naver.status)}</PosStatusChip> : <PosStatusChip tone={order.isMissing ? 'warning' : order.preparation === 'completed' ? 'success' : 'neutral'}>{status(order).replace(/^[⚠⏱] /u, '')}</PosStatusChip>, minWidth: posLayoutTokens.common.menuCardHeight },
    { id: 'payment', header: t('pos.paymentStatus'), kind: 'status', value: order => 'naver' in order ? approval(order) ? t('paymentApproved') : '—' : t(`pos.${order.paymentStatus}`), minWidth: posLayoutTokens.common.prepareWidth },
  ];
  const rowActions = (order: StatusRow) => 'naver' in order ? naver.actions(order) : actions(order);
  const selectedRow = selectedNaver ?? selectedOrder;
  const renderActions = (items: readonly GridAction[]) => items.map(action => {
    const prepare = action.id === 'order.start' || action.id === 'naver.prepare';
    const complete = action.id === 'order.complete' || action.id === 'naver.pickup';
    return <ActionButton key={action.id} className={prepare ? posClasses.prepare : complete ? posClasses.complete : undefined}
      variant={complete ? 'default' : 'secondary'} aria-disabled={action.disabled || undefined} onClick={event => {
        if (action.disabled) return;
        if (action.id === 'naver.prepare') naver.anchor.current = event.currentTarget;
        action.onPress();
      }}>{action.label}</ActionButton>;
  });
  const restore = () => {
    const node = root.current?.querySelector<HTMLElement>(`[data-grid-row-id="${CSS.escape(selected ?? '')}"][data-grid-column-id="number"]`) ?? root.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    node?.focus({ preventScroll: true });
  };
  if (read.scenario === 'error') return <div className="order-status"><ErrorPanel title={t('pos.errorOrders')} actions={<ActionButton onClick={onRetry}>{t('pos.retry')}</ActionButton>}/></div>;
  return <div ref={root} lang="ko" className="order-status" data-side-panel={!!selectedRow||undefined}>
    <div className="order-status__summary order-status__summary--m2">{[
      { key: 'pos.todayCount', value: t('widget.order-status.count', { n: summary.todayCount + naver.rows.open.length }) },
      { key: 'widget.order-status.open', value: t('widget.order-status.count', { n: counts.open }) },
      { key: 'widget.order-status.avgWait', value: summary.avgWaitMin === null ? '—' : summary.avgWaitMin < 1 ? `${Math.round(summary.avgWaitMin * 60)}초` : t('widget.order-status.avgWait.value', { n: summary.avgWaitMin }) },
      { key: 'widget.order-status.slow', value: t('widget.order-status.count', { n: summary.slowCount }), tone: summary.slowCount ? 'warning' : undefined },
      { key: 'widget.order-status.missing', value: t('widget.order-status.count', { n: summary.missingCount }), tone: summary.missingCount ? 'missing' : undefined },
      { key: 'pos.recentOrders', value: t('widget.order-status.count', { n: summary.recent10 }), tone: summary.rush ? 'warning' : undefined },
    ].map(item => {
      const parts=item.value.match(/^([\d,.]+)(.*)$/u);
      return <section className="ui-glass-tile" key={item.key} aria-label={t(item.key)} data-tone={item.tone}><strong>{item.tone ? <Icon name={item.tone === 'missing' || item.key === 'pos.recentOrders' ? 'warning' : 'clock'}/> : null}<MetricFit value={parts?.[1]??item.value} unit={parts?.[2]||undefined} presentation="hero"/></strong><h2>{t(item.key)}</h2></section>;
    })}</div>
    <div className="order-status__tools"><CategoryChips label={t('pos.statusFilter')} value={filter} options={(['open', 'done', 'canceled', 'all'] as const).map(value => ({ value, label: `${t(value === 'open' ? 'widget.order-status.open' : value === 'done' ? 'widget.order-status.complete' : value === 'canceled' ? 'pos.canceled' : 'pos.all')} ${counts[value]}` }))} onChange={value => { runtime.selectStatus(value, null); setSort(null); }}/><span>{t('widget.order-status.basis', { date: format.date(read.pos.businessDate, 'long'), time: POS_NOW_TIME })}</span></div>
    {summary.rush ? <div className="order-status__rush" role="status"><Icon name="warning"/>{t('widget.order-status.rush.notice')}</div> : null}
    {naver.feedback}
    <div className={`${posClasses.orderGrid} order-status__grid`}>
      <DataGrid ref={grid} id="pos-orders" label={t('pos.status')} rows={rows} getRowId={order => order.id}
        getRowLabel={order => 'naver' in order ? `${naverNumber(order)}, ${t(order.naver.status)}` :
          t('widget.order-status.aria.row', { no: order.orderNo, item: content(order), time: order.orderedAt.slice(11), n: elapsed(order), status: status(order) })}
        columns={columns} rowActionsLabel={t('pos.processing')} getRowActions={rowActions}
        renderRowActions={(order, items) => <div className={posClasses.orderActions} data-status={'naver' in order ? undefined : order.isMissing ? 'missing' : order.isSlow ? 'slow' : undefined}>{renderActions(items)}</div>}
        sort={sort} onSortChange={setSort} selectedRowId={selectedRow?.id ?? null} onSelectionChange={setSelected}
        expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus}
        obscuredCells={selectedRow ? new Set(rows.flatMap(order => ['amount', 'status', 'payment', '$actions'].map(column => `${order.id}:${column}`))) : undefined}
        emptyContent={<InlineEmpty title={t(!counts.all ? 'pos.emptyOrders' : filter === 'open' ? 'widget.order-status.empty.open' : 'pos.emptyFilter')}/>}/>
    </div>
    {naver.paging}
    {naver.popover}
    <DetailSidePanel open={!!selectedRow} selectedRowId={selectedRow?.id ?? null}
      title={selectedNaver ? `${naverNumber(selectedNaver)} · ${t(selectedNaver.naver.status)}` : selectedOrder ? `#${selectedOrder.orderNo} · ${status(selectedOrder)}` : t('pos.status')}
      onClose={() => setSelected(null)} returnFocusKey={selected ?? 'pos-orders'} onRestoreFocus={restore}
      footer={selectedOrder ? <div className="order-status__detail-actions">{actions(selectedOrder).map(action => <ActionButton key={action.id} variant={action.id === 'order.complete' ? 'default' : 'secondary'} onClick={action.onPress}>{action.label}</ActionButton>)}{!bridge && selectedOrder.paymentStatus === 'unpaid' && selectedOrder.preparation !== 'canceled' ? <ActionButton variant="ghost" onClick={() => process(selectedOrder, 'order.cancelUnpaid')}>{t('pos.cancelUnpaid')}</ActionButton> : null}</div> :
        selectedNaver ? <div className="order-status__detail-actions">{renderActions(naver.actions(selectedNaver))}</div> : undefined}>
      {selectedNaver && <div className="order-status__detail">
        <p>{t('orders')}{selectedNaver.naver.preparationMinutes != null ? ` · ${naverTime(selectedNaver)}` : ''}</p>
        <NaverOrderDetails key={selectedNaver.id} remote={naverRemote} settlement={naver.settlement(selectedNaver)}
          links={{ ...selectedNaver.naver, source: selectedNaver.naver.source ?? 'naver' }}/>
      </div>}
      {selectedOrder && detail ? <div lang="ko" className="order-status__detail"><p>{time(selectedOrder)} · {type(selectedOrder)}{selectedOrder.tableIds.length ? ` · ${selectedOrder.tableIds.join(' · ')}` : ''}</p><section><h4>{t('pos.menu')}</h4>{selectedOrder.lines.map(line => <div key={line.orderLineId}><strong>{line.nameAtOrder} ×{line.qty}</strong>{line.optionsAtOrder.length ? <p>{lineOptionCaption(read.data.catalog.items, line.menuId, line.optionsAtOrder)}</p> : null}{line.request ? <p>{t('pos.request', { text: line.request })}</p> : null}<PosMoney amount={line.unitPriceAtOrder * line.qty}/></div>)}</section>{detailMemo ? <section><h4>{t('pos.memo')}</h4><p>{detailMemo}</p></section> : null}<section><h4>{t('pos.payment')}</h4><dl><div><dt>{t('pos.goodsAmount')}</dt><dd><PosMoney amount={detail.gross}/></dd></div><div><dt>{t('pos.discount')}</dt><dd><PosMoney amount={detail.discount}/></dd></div><div><dt>{t('pos.payable')}</dt><dd><PosMoney amount={detail.payable} size="control"/></dd></div></dl>{payments.map(({ payment, receipt, balance, label }) => {
          const view = selectedOrder.preparation === 'accepted' ? 'cancel' : 'refund';
          const loadedReceipt = bridge?.loadedReceipt(payment.paymentId);
          const links: PosProviderLinks | undefined = loadedReceipt ?? bridge?.bill(payment.billId)
            ?? (!bridge && connectOrigin(selectedOrder) ? { source: 'connect' } : undefined);
          const canCorrect = !links?.naverPayPaymentId && !loadedReceipt?.containsMemberValue
            && payment.recognizedAt && balance && balance.remaining > 0 && selectedOrder.preparation !== 'canceled';
          const summary = receipt.splits.map(split => `${t(`pos.${split.method}`)} ${formatPosMoney(split.amount)}`).join(' + ');
          const paymentLabel = [label, summary].filter(Boolean).join(' · ') || '회원 결제';
          return <div key={payment.paymentId} role="group" aria-label={paymentLabel} data-payment-id={payment.paymentId} className={posClasses.summary}>
            <strong>{paymentLabel}</strong>{receipt.discounts.some(discount => discount.amount > 0) ? <p>{receipt.discounts.filter(discount => discount.amount > 0).map(discount => `${t(`pay.${discount.source}`)} ${format.money(discount.amount, 'full')}`).join(' · ')}</p> : null}
            <dl className={posClasses.receipt}>{receipt.splits.map(split => <div key={split.method} data-payment-method={split.method}><dt>{t(`pos.${split.method}`)}</dt><dd><PosMoney amount={split.amount}/></dd></div>)}</dl>
            <div className={posClasses.summaryRow}>
              <ActionButton variant="secondary" onClick={() => onOpenReceipt({ paymentId: payment.paymentId, view: 'receipt' })}>{t('receipt.receipt')}</ActionButton>
              {canCorrect ? <ActionButton variant="destructive" disabled={read.data.dayClosed} onClick={() => onOpenReceipt({ paymentId: payment.paymentId, view })}>{t(view === 'cancel' ? 'receipt.cancel' : 'receipt.refund')}</ActionButton> : null}
            </div>
            {read.data.dayClosed && !links?.naverPayPaymentId && balance && balance.remaining > 0 ? <p>{t('order.reversal.DAY_CLOSED')}</p> : null}
            {links && <NaverOrderDetails key={selectedOrder.id} links={links} remote={naverRemote}/>}
          </div>;
        })}<p>{t(`pos.${selectedOrder.paymentStatus}`)}</p>{member ? <p>{t('pos.member')}: {formatMaskedCustomer(typeof member.name === 'string' ? member.name : resolveDataText(t, member.name), member.memberId, member.memberCode)} · {member.phone}</p> : null}</section><section><h4>{t('pos.history')}</h4><p>{t('pos.acceptedAt', { time: selectedOrder.orderedAt.slice(11) })}</p>{selectedOrder.preparedAt ? <p>{t('pos.preparedAt', { time: selectedOrder.preparedAt.slice(11) })}</p> : null}{selectedOrder.completedAt ? <p>{t('pos.completedAt', { time: selectedOrder.completedAt.slice(11) })}</p> : null}{selectedOrder.statusHistory?.map(event => <p key={event.eventId}>{t(event.kind === 'separate' ? 'pos.transferSeparate' : event.kind === 'move' ? 'pos.transferMove' : 'pos.transferMerge', { table: event.toTableId, time: event.at.slice(11, 16) })}</p>)}</section></div> : null}
    </DetailSidePanel>
  </div>;
}

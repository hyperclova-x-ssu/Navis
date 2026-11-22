import type { LinkedTableDisplay } from '../../features/cctv/zones/linked-ui';
import { useRef, useState } from 'react';
import type { RunStore } from '../../contracts';
import type { PosBillQuote, PosCartQuote, PosTableView, PosTab } from '../../contracts/pos';
import { useBundle } from '../../i18n';
import { posBundle } from '../../i18n/messages/pos';
import { POS_NOW_TIME } from '../../pos/clock';
import { quoteCart } from '../../pos/domain';
import { quotePaymentBill, getPaymentBillId } from '../../pos/loyalty';
import { LoyaltyCheckout } from './loyalty/Checkout';
import { usePayText } from './loyalty/Tools';
import { usePosSession, usePosSnapshot } from '../../pos/react';
import { usePosBridge, usePosSyncState } from '../../pos/remote-context';
import { firstOrderFor, seatNote } from '../../data/reality/06/seat';
import type { FirstOrderReservation } from '../../data/reality/06/first-order';
import { useWidgetDataStore } from '../../data/react';
import { TODAY, selectClosing } from '../../data/widget-data';
import { ActionButton, AnchoredPopover, CountBadge, Icon, PosMoney, SkipLink, Spinner, formatPosMoney, posClasses } from '../../ui';
import { useShellT } from '../settings/use-shell-t';
import { LayerHeader } from '../layer-header/LayerHeader';
import { Composer, type ComposerNotice } from './Composer';
import { lineLabel } from './option-text';
import { PaymentDialog } from './payment';
import { OrderStatus } from './status/OrderStatus';
import { selectOrderSummary } from '../../pos/status';
import { selectPosPreferences, selectTableMap, selectUnpaidBills, tablesEnabled, tableTransferReason, transferredDiscountsMatch, type TableTransferKind } from '../../pos/tables';
import { dataBundles } from '../../data/widget-data';
import { openSettingsAt } from '../settings/start-view';
import { TableMap, type TableSelection } from './tables/TableMap';
import { TableDetail } from './tables/TableDetail';
import { BillPaymentDialog } from './tables/BillPayment';
import type { OpenReversalReceipt } from '../../app/pos-host';
import { VisitPrompt } from './tables/VisitPrompt';
import { useTableCommands, tableFailureKey } from './tables/actions';
import { SeparateDialog } from './tables/SeparateDialog';
import { tableTransferBundle } from './tables/messages';
import './order.css';

export function OrderScreen({ run, onOpenReceipt, linkedTables }: { readonly run: RunStore; readonly onOpenReceipt: OpenReversalReceipt; readonly linkedTables?: readonly LinkedTableDisplay[] }) {
  const runtime = usePosSession(), read = usePosSnapshot(), store = useWidgetDataStore();
  const { t } = useBundle(posBundle, tableTransferBundle, ...dataBundles), shell = useShellT();
  const payText = usePayText();
  const bridge = usePosBridge(), sync = usePosSyncState();
  const [cancelPartial, setCancelPartial] = useState(false);
  const [checkout, setCheckout] = useState<{ id: number; quote: PosCartQuote | PosBillQuote; summary: string; open: boolean } | null>(null);
  const [target, setTarget] = useState<{ tableId?: string; billId?: string }>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [tableSelection, setTableSelection] = useState<TableSelection | null>(null);
  const [separateBillId, setSeparateBillId] = useState<string | null>(null);
  const transferPending = useRef(false);
  const [picker, setPicker] = useState(false), [billList, setBillList] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false), pendingOrder = useRef<{ key: string; table?: PosTableView; billId?: string; reservation?: FirstOrderReservation }>(undefined);
  const [orderUncertain, setOrderUncertain] = useState(false);
  const billAnchor = useRef<HTMLButtonElement | null>(null);
  const map = selectTableMap(read), preferences = selectPosPreferences(read.settings), unpaid = selectUnpaidBills(read);
  const postpaid = read.settings.paymentStyle === 'postpaid', deferred = postpaid && read.pos.cart.type === 'dine_in';
  const selectedTable = map.tables.find(table => table.tableId === target.tableId);
  const selectedBill = read.pos.bills.find(bill => bill.billId === target.billId && (bill.status === 'open' || bill.status === 'partial'));
  const existing = selectedBill ? quotePaymentBill(read, selectedBill.billId) : null;
  const cartPayment = quotePaymentBill(read, getPaymentBillId(read));
  const opener = useRef<HTMLElement | null>(null), serial = useRef(0);
  const tab = read.posUi.tab === 'tables' && (!map.enabled || !preferences.showTables) || read.posUi.tab === 'status' && !preferences.showStatus && !read.posUi.forceStatusVisible ? 'order' : read.posUi.tab;
  const summary = selectOrderSummary(read), counts = summary.counts;
  const closed = read.data.dayClosed;
  const returnFocus = { get current() {
    return opener.current?.isConnected && !opener.current.matches('[disabled],[aria-disabled="true"]') && runtime.read().pos.cart.lines.length
      ? opener.current : document.querySelector<HTMLElement>('[data-menu-card]:not([aria-disabled="true"])') ?? document.getElementById('pos-order-panel');
  } };
  const notice = ({ message, undoToken }: ComposerNotice) => run.actions.showNotice({ kind: 'complete', messageKey: 'pos.notice', params: { message }, ...(undoToken ? { undo: { target: 'pos', token: undoToken } } : {}) });
  const retry = () => run.actions.setPosPreview('normal');
  const openPayment = () => {
    if (checkout?.open) return;
    const current = runtime.read(), paymentQuote = quotePaymentBill(current);
    if (!paymentQuote.canSubmit) return;
    const quote = quoteCart(current);
    runtime.dismissApproval();
    // UXP-4: the "담기 · 되돌리기" toast belongs to the cart; it must not hang over the payment window.
    run.actions.clearNotice();
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // "라떼 (ICE · 오트 +600원) ×1 · 아메리카노 ×2": options in brackets, group order, price deltas, quantity last.
    const lines = quote.lines.slice(0, 3).map(line => lineLabel(current.data.catalog.items, line.menuId, line.name, line.options, line.qty)).join(' · ');
    setCheckout({ id: ++serial.current, quote, summary: `${lines} · ${t(current.pos.cart.type === 'dine_in' ? 'pos.dineIn' : 'pos.takeout')}`, open: true });
  };
  const reopen = () => {
    const closing = selectClosing(store.getSnapshot(), { date: TODAY, scenario: 'normal' });
    if (!closing.closingId) return;
    const result = store.dispatch({ type: 'closing.undoDay', date: TODAY, scenario: 'normal', closingId: closing.closingId, idempotencyKey: `${closing.closingId}:undo` });
    if (!result.ok) run.actions.showNotice({ kind: 'error', messageKey: result.messageKey });
    else if (!result.duplicate) run.actions.showNotice({ kind: 'complete', messageKey: result.noticeKey ?? 'data.management.notice.reopened' });
  };
  const execute = useTableCommands(notice);
  const startTransfer = (kind: TableTransferKind, billId: string) => {
    const current = runtime.read(), tables = selectTableMap(current).tables;
    const blocked = tables.map(table => tableTransferReason(current, kind, billId, table.tableId));
    if (!blocked.includes(null)) {
      notice({ message: t(blocked.includes('PARTIAL_BILL_LOCKED') ? 'table.partialLocked' : blocked.includes('BILL_LOCKED') ? 'pos.lockedBill' : kind === 'merge' ? 'pos.stateConflict' : 'table.noDestination') });
      return;
    }
    setDetailId(null); transferPending.current = false;
    if (kind === 'separate') setSeparateBillId(billId); else setTableSelection({ kind, billId });
  };
  const selectTransferTarget = (table: PosTableView) => {
    if (!tableSelection || transferPending.current) return false;
    const current = runtime.read(), { kind, billId, lines } = tableSelection;
    const reason = tableTransferReason(current, kind, billId, table.tableId);
    if (reason) { notice({ message: t(tableFailureKey({ reason })) }); return false; }
    transferPending.current = true;
    const message = t(kind === 'move' ? 'table.moved' : kind === 'merge' ? 'table.merged' : 'table.separated', { n: table.number, table: `T${table.number}` });
    const result = kind === 'merge' ? execute({ type: 'bill.mergeTables', sourceBillId: billId, targetBillId: table.billIds[0] }, message)
      : kind === 'separate' ? execute({ type: 'bill.separateTable', billId, targetTableId: table.tableId, lines: lines ?? [] }, message)
        : execute({ type: 'bill.moveTable', billId, targetTableId: table.tableId }, message);
    if (!result.ok) { transferPending.current = false; return false; }
    setTableSelection(null);
    if (target.billId === billId) setTarget({});
    return true;
  };
  const editTables = () => openSettingsAt(run, 'tables');
  const startOrder = (table: PosTableView) => { setTarget({ tableId: table.tableId, billId: table.billIds[0] }); setDetailId(null); runtime.setTab('order'); };
  const openBillPayment = (billId: string) => {
    if (checkout?.open || submittingRef.current || pendingOrder.current) return;
    const current = runtime.read(), quote = quotePaymentBill(current, billId);
    if (!bridge && !transferredDiscountsMatch(current, billId)) { notice({ message: t('pos.quoteChanged') }); return; }
    if (bridge ? bridge.bill(billId)?.status !== 'open' : !quote.canSubmit) { notice({ message: t(tableFailureKey({ reason: quote.issues[0]?.reason ?? 'STATE_CONFLICT' })) }); return; }
    if (!runtime.dismissApproval()) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const bill = current.pos.bills.find(b => b.billId === billId)!;
    const label = bill.tableId ?? t('pos.billNumber', { n: bill.originOrderNo });
    setCheckout({ id: ++serial.current, quote, summary: `${quote.lines.slice(0, 3).map(line => lineLabel(current.data.catalog.items, line.menuId, line.name, line.options, line.qty)).join(' · ')} · ${label}`, open: true });
  };
  const submitOrder = (tableId = target.tableId) => {
    if (bridge) {
      if (submittingRef.current) return;
      const table = map.tables.find(row => row.tableId === tableId);
      // R1-F06-2: a table whose booking is due claims that booking with its first order (B06 seam); a table that already has a bill does not.
      const reservation = firstOrderFor(store.getSnapshot(), table, !!selectedBill || !!table?.billIds.length);
      const request = pendingOrder.current ?? { key: `order:${crypto.randomUUID()}`, table, billId: selectedBill?.billId, ...(reservation ? { reservation } : {}) };
      pendingOrder.current = request;
      submittingRef.current = true;
      setSubmitting(true);
      setPicker(false);
      void bridge.submitOrder(request).then(result => {
        submittingRef.current = false;
        setSubmitting(false);
        if (!result.ok) {
          if (!result.outcomeUnknown) pendingOrder.current = undefined;
          setOrderUncertain(result.outcomeUnknown);
          if (result.reason === 'SESSION_ENDED') return;
          run.actions.showNotice({ kind: 'error', messageKey: 'pos.notice', params: { message: result.outcomeUnknown ? '주문 결과를 다시 확인해 주세요' : '주문을 넣지 못했어요. 계산서를 확인하고 다시 시도해 주세요' } });
          return;
        }
        setOrderUncertain(false);
        pendingOrder.current = undefined;
        setTarget({ tableId: request.table?.tableId, billId: result.receipt.resourceId });
        if (request.table) {
          setDetailId(null);
          if (runtime.read().posUi.tab === 'order') runtime.setTab('tables');
        }
        const bill = runtime.read().pos.bills.find(row => row.billId === result.receipt.resourceId);
        const note = seatNote(result.receipt, !!request.reservation);
        notice({ message: `${request.table ? t('pos.submittedTable', { n: request.table.number }) : t('pos.billCreated', { n: bill?.originOrderNo ?? '' })}${note ? ` · ${note}` : ''}` });
      });
      return;
    }
    const current = runtime.read();
    const result = execute({ type: 'bill.submitOrder', cartId: current.pos.cart.cartId, ...(tableId ? { tableId } : {}), ...(selectedBill ? { billId: selectedBill.billId } : {}) }, undefined, false);
    if (!result.ok) return;
    if (result.value && 'orderIds' in result.value) {
      const value = result.value;
      const bill = runtime.read().pos.bills.find(b => b.billId === value.billId)!;
      setTarget({ tableId: bill.tableId ?? undefined, billId: bill.billId });
      const hasPrompt = runtime.read().pos.reservationPrompts.some(prompt => prompt.billId === bill.billId && prompt.decision === 'pending');
      if (hasPrompt) run.actions.clearNotice();
      else notice({ message: bill.tableId ? t('pos.submittedTable', { n: map.tables.find(table => table.tableId === bill.tableId)?.number ?? '' }) : t('pos.billCreated', { n: bill.originOrderNo }) });
      setPicker(false); setDetailId(null);
    }
  };
  const checkoutAction = () => {
    if (pendingOrder.current) { submitOrder(); return; }
    if (!deferred) { openPayment(); return; }
    if (!read.pos.cart.lines.length && existing) { openBillPayment(existing.billId); return; }
    if (map.enabled && !target.tableId) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      notice({ message: t('pos.pickTable') }); setPicker(true); return;
    }
    submitOrder();
  };
  const heading = deferred && selectedTable ? t('pos.tableOrder', { n: selectedTable.number }) : deferred && selectedBill ? t('pos.billNumber', { n: selectedBill.originOrderNo }) : undefined;
  const reservation = deferred ? selectedTable?.reservation : null;
  const context = <>{read.pos.cart.lock ? <div className="pay-tools__paying" role="status"><Icon name="warning"/><strong>{payText.t('pay.paying', { amount:formatPosMoney(cartPayment.remaining) })}</strong><ActionButton variant="ghost" onClick={() => { opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null; setCancelPartial(true); }}>{payText.t('pay.cancelPartial')}</ActionButton></div> : null}{!deferred ? cartPayment.discounts.map(d=><div key={d.discountId} className={posClasses.summaryRow}><span>{payText.t(`pay.${d.source}`)}</span><PosMoney amount={d.amount} sign="minus"/></div>) : null}{reservation ? <p className={posClasses.lineDetail}>{t('pos.reservationHeader', { time: reservation.time, name: typeof reservation.name === 'string' ? reservation.name : t(reservation.name.key), n: reservation.partySize })}</p> : null}{deferred && existing ? <details className="pos-existing-orders"><summary>{t('pos.existingOrders', { n: existing.orderIds.length, amount: formatPosMoney(existing.remaining) })}</summary>{existing.lines.map(line => <div key={line.lineId}>{line.name} {line.options.map(option => option.name).join(' · ')} {line.qty} · <PosMoney amount={line.gross}/></div>)}</details> : null}</>;
  const tabs: readonly PosTab[] = ['order', ...(preferences.showStatus || read.posUi.forceStatusVisible ? ['status' as const] : []), ...(map.enabled && preferences.showTables ? ['tables' as const] : [])];
  const registerMember = () => {
    setCheckout(null);
    run.actions.openDetailRef({ featureId: 'members', view: 'register', focus: 'action' }, 'pos-tab-order');
  };
  const checkoutLabel = submitting ? '주문 넣는 중…' : orderUncertain ? '주문 결과 다시 확인' : deferred ? !read.pos.cart.lines.length && existing ? t('pos.calculate') : t('pos.submitOrder') : t('pos.checkout');
  const checkoutBlockedReason = closed ? t('pos.closedHelp') : submitting ? checkoutLabel : bridge && sync?.status !== 'ready' ? payText.t('pay.real.loading') : read.pos.cart.lock ? '' : undefined;
  return <main className="order-screen">
    <SkipLink targetId={`pos-${tab}-panel`}/>
    <LayerHeader labelKey="app.layer.orders"><ActionButton data-focus-key="settings" variant="outline" disabled={read.posUi.approval?.status === 'pending'} onClick={run.actions.openSettings}>{shell.t('common.settings')}</ActionButton></LayerHeader>
    <div lang="ko" className={posClasses.content}>
      <div className={posClasses.tabs} role="tablist" aria-label={t('pos.tabs')}>{tabs.map((value, index) => <ActionButton id={`pos-tab-${value}`} key={value} variant="ghost" role="tab" aria-controls={`pos-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} aria-label={value === 'status' ? t('pos.statusTab', { n: counts.open }) : t(value === 'tables' ? 'pos.tables' : 'pos.order')} className={posClasses.tab} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        document.getElementById(`pos-tab-${tabs[next]}`)?.focus();
      }} onClick={() => { setTableSelection(null); setSeparateBillId(null); runtime.setTab(value); }}>{t(value === 'order' ? 'pos.order' : value === 'tables' ? 'pos.tables' : 'pos.status')}{value === 'status' ? <CountBadge tone={summary.missingCount ? 'missing' : 'neutral'} count={counts.open} aria-hidden="true"/> : null}</ActionButton>)}</div>
      {sync?.status === 'error' ? <div className="order-closed-band ui-glass-card" role="alert"><Icon name="warning"/><strong>{payText.t('pay.real.loadError')}</strong><ActionButton variant="secondary" onClick={() => { void bridge?.sync({ force: true }); }}>{payText.t('pay.real.loadRetry')}</ActionButton></div>
        : sync?.status === 'loading' ? <div className="order-closed-band ui-glass-card" role="status"><Spinner/><strong>{payText.t('pay.real.loading')}</strong></div>
        : sync && !sync.complete ? <div className="order-closed-band ui-glass-card" role="status"><Icon name="warning"/><span>{payText.t('pay.real.partial')}</span></div> : null}
      {closed ? <div data-pos-closed className="order-closed-band ui-glass-card" role="status"><Icon name="check"/><strong>{t('pos.closedTitle', { time: POS_NOW_TIME })}</strong><span>{t('pos.closedDescription')}</span><ActionButton variant="secondary" onClick={reopen}>{t('pos.reopen')}</ActionButton></div> : null}
      <div id={`pos-${tab}-panel`} role="tabpanel" aria-labelledby={`pos-tab-${tab}`} tabIndex={-1} className="order-tab-body" data-tab={tab}>
        {tab === 'tables' ? <TableMap linkedTables={linkedTables} selection={tableSelection} onSelect={selectTransferTarget} onCancelSelection={() => setTableSelection(null)} onRetry={retry} onEdit={editTables} onPick={table => table.state === 'empty' || table.state === 'reserved' ? startOrder(table) : setDetailId(table.tableId)}/> : tab === 'order' ?
          <Composer summaryQuote={deferred && !read.pos.cart.lines.length && existing ? {...existing,payable:existing.remaining} : !deferred ? {...cartPayment,payable:cartPayment.remaining} : undefined}
            heading={heading} context={context} checkoutLabel={checkoutLabel} checkoutWithoutCart={orderUncertain || deferred && !!existing} checkoutBlockedReason={checkoutBlockedReason}
            headerAction={postpaid && !tablesEnabled(read.settings) ? <ActionButton ref={billAnchor} variant="secondary" aria-expanded={billList} onClick={() => setBillList(!billList)}>{t('pos.billCount', { n: unpaid.length })}</ActionButton> : undefined}
            beforeAction={deferred && existing && read.pos.cart.lines.length ? <ActionButton variant="secondary" disabled={submitting || orderUncertain} onClick={() => openBillPayment(existing.billId)}>{t('pos.calculate')}</ActionButton> : undefined}
            onCheckout={checkoutAction} onRetryCatalog={retry} onAddMenu={() => { retry(); run.actions.openDetailRef({ featureId: 'menu', view: 'register' }, 'pos-tab-order'); }} onNotice={notice}/>
          : <OrderStatus onRetry={retry} onNotice={notice} onOpenReceipt={onOpenReceipt}/>}
      </div>
    </div>
    {tab === 'tables' ? <><div className="pos-tables-detail-host"><TableDetail linkedTables={linkedTables} onTransfer={bridge ? undefined : startTransfer} table={checkout?.open || tableSelection || separateBillId ? null : map.tables.find(table => table.tableId === detailId) ?? null} onClose={() => setDetailId(null)} onAdd={startOrder} onPay={openBillPayment} onNotice={notice}/></div>{!bridge && !checkout?.open && !tableSelection && !separateBillId && run.getState().overlay.type === 'none' ? <VisitPrompt onNotice={notice}/> : null}</> : null}
    {separateBillId ? <SeparateDialog key={separateBillId} billId={separateBillId} onClose={() => setSeparateBillId(null)} onNext={lines => { setTableSelection({ kind: 'separate', billId: separateBillId, lines }); setSeparateBillId(null); }}/> : null}
    <AnchoredPopover open={picker} anchorRef={opener} side="top" focusOnOpen label={t('pos.pickTable')} onClose={() => { setPicker(false); opener.current?.focus(); }}><div className="pos-table-picker"><TableMap picker onPick={table => { setTarget({ tableId: table.tableId, billId: table.billIds[0] }); submitOrder(table.tableId); }}/></div></AnchoredPopover>
    <AnchoredPopover open={billList} anchorRef={billAnchor} side="bottom" focusOnOpen label={t('pos.billCount', { n: unpaid.length })} onClose={() => { setBillList(false); billAnchor.current?.focus(); }}><div lang="ko" className="pos-bill-list"><ActionButton variant="ghost" onClick={() => { setTarget({}); setBillList(false); billAnchor.current?.focus(); }}>{t('pos.newOrder')}</ActionButton>{unpaid.length ? unpaid.map(quote => { const bill = read.pos.bills.find(b => b.billId === quote.billId)!; const first = read.pos.orders.find(order => quote.orderIds.includes(order.orderId))?.orderedAt.slice(-5); const minutes = (time: string) => { const [h,m] = time.split(':').map(Number); return h * 60 + m; }; const elapsed = first ? Math.max(0, minutes(POS_NOW_TIME) - minutes(first)) : 0; return <ActionButton key={quote.billId} variant="ghost" onClick={() => { setTarget({ billId: quote.billId }); setBillList(false); billAnchor.current?.focus(); }}>{t('pos.billNumber', { n: bill.originOrderNo })} · <PosMoney amount={quote.remaining}/> · {t('pos.elapsed', {n:elapsed})}</ActionButton>; }) : <p>{t('pos.noBills')}</p>}</div></AnchoredPopover>
    {cancelPartial ? <LoyaltyCheckout open billId={getPaymentBillId(read)} summary={''} returnFocusRef={returnFocus} startCancel onClose={() => setCancelPartial(false)} onComplete={() => {}}/> : null}
    {checkout && 'billId' in checkout.quote ? <BillPaymentDialog key={checkout.id} open={checkout.open} quote={checkout.quote} summary={checkout.summary} onRegisterMember={registerMember} returnFocusRef={{ get current() { return opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>(`[data-pos-table="${detailId}"]`) ?? billAnchor.current ?? document.getElementById(`pos-${tab}-panel`); } }} onClose={() => { setCheckout(current => current ? { ...current, open: false } : null); }} onComplete={n => { if (map.enabled) { const settledBill = read.pos.bills.find(bill => 'billId' in checkout.quote && bill.billId === checkout.quote.billId); setDetailId(settledBill?.tableId ?? null); runtime.setTab('tables'); } run.actions.showNotice({ kind: 'complete', messageKey: 'pos.done', params: { n } }); }}/>
      : checkout && 'cartId' in checkout.quote ? <PaymentDialog key={checkout.id} open={checkout.open} quote={checkout.quote} summary={checkout.summary} onRegisterMember={registerMember} returnFocusRef={returnFocus} onClose={() => setCheckout(current => current ? { ...current, open: false } : null)} onComplete={n => run.actions.showNotice({ kind: 'complete', messageKey: 'pos.done', params: { n } })}/> : null}
  </main>;
}

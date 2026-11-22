import { useRef, useState } from 'react';
import type { PosTableView } from '../../../contracts/pos';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { usePosSnapshot } from '../../../pos/react';
import { usePosBridge } from '../../../pos/remote-context';
import { quoteBill, type TableTransferKind } from '../../../pos/tables';
import { ActionButton, DetailSidePanel, PosActionButton, PosMoney } from '../../../ui';
import type { ComposerNotice } from '../Composer';
import { useTableCommands } from './actions';
import { stateKeys } from './TableMap';
import { tableTransferBundle } from './messages';
import { lineOptionCaption } from '../option-text';
import { linkedOccupancyText, type LinkedTableDisplay } from '../../../features/cctv/zones/linked-ui';

export function TableDetail({ table, onClose, onAdd, onPay, onNotice, onTransfer, linkedTables = [] }: {
  table: PosTableView | null; onClose: () => void; onAdd: (table: PosTableView) => void;
  onPay: (billId: string) => void; onNotice: (notice: ComposerNotice) => void;
  onTransfer?: (kind: TableTransferKind, billId: string) => void;
  linkedTables?: readonly LinkedTableDisplay[];
}) {
  const read = usePosSnapshot(), { t } = useBundle(posBundle, tableTransferBundle), execute = useTableCommands(onNotice);
  const bridge = usePosBridge();
  const cleaningRef = useRef(false), [cleaning, setCleaning] = useState(false);
  const session = read.pos.tableSessions.find(s => s.tableId === table?.tableId);
  const billId = table?.billIds[0] ?? session?.billId;
  const bill = read.pos.bills.find(b => b.billId === billId);
  const quote = billId ? quoteBill(read, billId) : null;
  const payment = read.pos.payments.find(p => p.billId === billId && p.status === 'paid');
  const orders = read.pos.orders.filter(order => order.preparation !== 'canceled' && (quote ? quote.orderIds.includes(order.orderId) : order.originBillId === billId));
  const blocked = read.data.dayClosed ? t('pos.closedHelp') : undefined;
  const partial = bill?.status === 'partial' || read.pos.payments.some(p => p.billId === billId && p.status === 'paid');
  const transferLocked = partial ? t('table.partialLocked') : bill?.splitPlan ? t('pos.lockedBill') : undefined;
  const clean = async (view: PosTableView) => {
    if (!bridge || cleaningRef.current) return;
    cleaningRef.current = true; setCleaning(true);
    const result = await bridge.cleanTable(view.tableId);
    cleaningRef.current = false; setCleaning(false);
    onNotice({ message: result.ok ? t('pos.cleaned', { n: view.number }) : '정리 상태를 바꾸지 못했어요. 다시 시도해 주세요' });
    if (result.ok) onClose();
  };
  return <DetailSidePanel open={!!table && (!!bill || table.state === 'cleaning')} selectedRowId={table?.tableId ?? null} title={table ? t('pos.tableBill', { n: table.number }) : ''} onClose={onClose} returnFocusKey={table?.tableId ?? ''} onRestoreFocus={id => document.querySelector<HTMLElement>(`[data-pos-table="${id}"]`)?.focus({ preventScroll: true })}>
    {table ? <div className="pos-table-detail">
      <p>{t(stateKeys[table.state])} · {t('pos.tableSeats', { n: table.seats })} · {orders[0]?.orderedAt.slice(-5)} · {t('pos.elapsed', { n: table.elapsed })}</p>
      {linkedTables.filter(link => link.tableId === table.tableId).map(link => <p key={link.zoneId}>{linkedOccupancyText(link)}{link.needsClearingBadge ? ' · 치울 테이블' : ''}</p>)}
      <h4>{t('pos.orderItems', { n: orders.length, qty: quote?.totalQty ?? 0 })}</h4>
      {orders.map(order => {
        const allocated = read.pos.billAllocations.filter(a => a.billId === billId);
        const lineIds = new Set(order.lines.map(l => l.orderLineId));
        const shared = [...new Set(read.pos.billAllocations.filter(a => a.billId !== billId && lineIds.has(a.orderLineId)).flatMap(a => {
          const other = read.pos.bills.find(b => b.billId === a.billId && b.status !== 'void');
          return other?.tableId && other.tableId !== table.tableId ? [other.tableId] : [];
        }))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return <section key={order.orderId}><div className="pos-table-detail__order"><div><strong>#{order.orderNo} {order.orderedAt.slice(-5)} · {t(`pos.${order.preparation}`)}</strong>{shared.length ? <small>{t('table.shared', { tables: shared.join(' · ') })}</small> : null}</div>{table.state !== 'cleaning' && !bridge ? <ActionButton variant="ghost" disabled={!!blocked || !!transferLocked} onClick={() => {
        const result = execute({ type: 'order.cancelUnpaid', orderId: order.orderId }, t('pos.canceledOrder', { n: order.orderNo }));
        if (result.ok && !result.value && orders.length === 1) onClose();
      }}>{t('pos.cancelUnpaid')}</ActionButton> : null}</div>
        {order.lines.flatMap(line => {
          const qty = allocated.filter(a => a.orderLineId === line.orderLineId).reduce((n, a) => n + a.qty, 0);
          if (!qty) return [];
          return [<div className="pos-table-detail__line" key={line.orderLineId}><span>{line.nameAtOrder} ×{qty}{line.optionsAtOrder.length ? <small>{lineOptionCaption(read.data.catalog.items, line.menuId, line.optionsAtOrder)}</small> : null}{line.request ? <small>{t('pos.request', { text: line.request })}</small> : null}</span><PosMoney amount={line.unitPriceAtOrder * qty}/></div>];
        })}
      </section>; })}
      <div className="pos-table-detail__line"><strong>{t('pos.accumulated')}</strong><PosMoney amount={bill?.status === 'paid' ? payment?.amount ?? 0 : (billId ? bridge?.bill(billId)?.quote.payable : undefined) ?? quote?.remaining ?? 0} size="metric"/></div>
      {table.state === 'cleaning' ? <PosActionButton reason={cleaning ? '정리 상태 기록 중…' : undefined} onAction={() => {
        if (bridge) { void clean(table); return; }
        if (execute({ type: 'table.clean', tableId: table.tableId }, t('pos.cleaned', { n: table.number }), false).ok) onClose();
      }}>{cleaning ? '정리 상태 기록 중…' : t('pos.clean')}</PosActionButton> : <>
        <div className="pos-table-detail__actions"><ActionButton variant="secondary" disabled={!!blocked || bill?.status === 'partial'} onClick={() => onAdd(table)}>{t('pos.addOrder')}</ActionButton>{table.state === 'occupied' && billId && !bridge ? <ActionButton variant="secondary" disabled={!!blocked} onClick={() => execute({ type: 'bill.requestPayment', billId }, t('pos.requestedPayment'))}>{t('pos.requestPayment')}</ActionButton> : null}</div>
        <PosActionButton reason={blocked} onBlocked={message => onNotice({ message })} onAction={() => { if (billId) onPay(billId); }}>{t('pos.calculate')}</PosActionButton>
        {onTransfer && billId ? <><div className="pos-table-detail__transfers">{(['move', 'merge', 'separate'] as const).map(kind => <ActionButton key={kind} variant="secondary" disabled={kind !== 'move' && !!transferLocked} aria-describedby={kind !== 'move' && transferLocked ? 'pos-table-transfer-reason' : undefined} onClick={() => onTransfer(kind, billId)}>{t(`table.${kind}`)}</ActionButton>)}</div>{transferLocked ? <p id="pos-table-transfer-reason">{transferLocked}</p> : null}</> : null}
      </>}
    </div> : null}
  </DetailSidePanel>;
}

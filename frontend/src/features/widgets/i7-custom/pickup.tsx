import { useRef, useState } from 'react';
import type { WidgetHost } from '../../../contracts';
import { NOW, TODAY } from '../../../data/db/time';
import { useBundle } from '../../../i18n';
import { ActionButton, DataGrid, DateField, InlineForm, StatusChip, TimeField, layoutTokens, type GridFocus } from '../../../ui';
import { commandError, customOrderListBundle, isPastPickup, maskName, maskPhone, orderNumber, requestKey } from './copy';
import { useCustomOrderModel, usePickupCount } from './use-custom';

const statusLabels = { confirmed: '예약 확정', completed: '수령 완료', canceled: '취소' } as const;
export function PickupSummary({ date }: { date: string }) {
  const count = usePickupCount(date);
  return count === null ? null : <p lang="ko" className="custom-pickup-summary">픽업 {count}건</p>;
}
/** Pickups use the reservation mutation without entering visit seat/table controls. */
export function PickupReservations({ date, host, reservationId }: { date: string; host: WidgetHost; reservationId?: string }) {
  const { t } = useBundle(customOrderListBundle);
  const { rows: allOrders, port, state, read } = useCustomOrderModel();
  const today = read?.businessDate ?? read?.now?.slice(0, 10) ?? TODAY;
  const initial = reservationId && allOrders.find(order => order.pickup?.reservationId === reservationId)?.customOrderId;
  const [selected, setSelected] = useState<string | null>(initial || null), [focus, setFocus] = useState<GridFocus>(null);
  const [editDate, setDate] = useState<string | null>(null), [editTime, setTime] = useState<string | null>(null), [error, setError] = useState(''), [cancel, setCancel] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  if (!port || state === 'error') return null;
  const rows = allOrders.filter(row => row.pickup?.date === date), row = rows.find(row => row.customOrderId === selected);
  return <section className="custom-pickups custom-detail" aria-label="픽업" lang="ko">
    <h3>픽업</h3><PickupSummary date={date} />
    <DataGrid id="pickup-reservations" label="픽업 예약" rows={rows} getRowId={row => row.customOrderId} getRowLabel={row => `픽업 ${orderNumber(row.customOrderId)}`} columns={[
      { id: 'kind', header: '종류', kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: () => '픽업', render: () => <StatusChip semantic="none">픽업</StatusChip> },
      { id: 'time', header: '예약 일시', kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: row => row.pickup?.time ?? '' },
      { id: 'order', header: '주문', kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: row => orderNumber(row.customOrderId), render: row => <ActionButton variant="ghost" aria-label={`픽업 ${orderNumber(row.customOrderId)} ${row.productLabel}`} onClick={() => { setSelected(row.customOrderId); setDate(null); setTime(null); setError(''); setCancel(false); }}>{orderNumber(row.customOrderId)}</ActionButton> },
      { id: 'product', header: '상품', kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: row => row.productLabel },
      { id: 'party', header: '인원', kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: () => '—' },
      { id: 'table', header: '테이블', kind: 'text', minWidth: layoutTokens.targetDefault * 3, value: () => '—' },
      { id: 'status', header: '상태', kind: 'status', minWidth: layoutTokens.targetDefault * 3, value: row => row.pickup ? statusLabels[row.pickup.status] : '' },
    ]} sort={null} onSortChange={() => {}} focus={focus} onFocusChange={setFocus} selectedRowId={selected} onSelectionChange={value => { setSelected(value); setDate(null); setTime(null); setCancel(false); setError(''); }} expandedRowIds={new Set()} emptyContent="등록된 픽업이 없어요" />
    {row?.pickup && <div className="custom-editor" role="region" aria-label={`${orderNumber(row.customOrderId)} 픽업 상세`}>
      <h4>{row.productLabel}</h4><p>{maskName(row.guest?.name ?? port.members?.find(member => member.memberId === row.memberId)?.label ?? row.memberId ?? '')} {row.guest?.phone ? maskPhone(row.guest.phone) : ''}</p><p>{[...row.options, `${row.quantity}개`].join(' · ')}</p><p>{row.request}</p>
      <StatusChip semantic={row.pickup.status === 'completed' ? 'done' : row.pickup.status === 'confirmed' ? 'done' : 'none'} tone={row.pickup.status === 'canceled' ? 'danger' : undefined}>{statusLabels[row.pickup.status]}</StatusChip>
      {row.pickup.status === 'confirmed' && <>
        <InlineForm title="픽업 일시" saveLabel="픽업 일시 고치기" onClose={() => { setSelected(null); setDate(null); setTime(null); }} onSave={() => {
          if (!row.pickup) return;
          const date = editDate ?? row.pickup.date, time = editTime ?? row.pickup.time;
          if ((date !== row.pickup.date || time !== row.pickup.time) && isPastPickup(`${date}T${time}`, read?.now ?? NOW)) { setError(t('widget.custom-order.pickupPast')); return; }
          const result = port.dispatch({ type: 'pickup.reschedule', reservationId: row.pickup.reservationId, date, time, idempotencyKey: requestKey() });
          if (!result.ok) setError(commandError(result.reason)); else { setError(''); if (result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, undoToken: result.undoToken }); }
        }}><DateField label="픽업 날짜" today={today} value={editDate ?? row.pickup.date} onValueChange={value => { setDate(value); setError(''); }} /><TimeField label="픽업 시각" value={editTime ?? row.pickup.time} onValueChange={value => { setTime(value); setError(''); }} /></InlineForm>
        <ActionButton ref={cancelButton} variant="secondary" onClick={() => {
          if (row.payment.amountSettled > row.payment.amountReturned) port.openReversal({ customOrderId: row.customOrderId, cancelOrder: true }, { selectedId: row.customOrderId, returnFocusRef: cancelButton });
          else setCancel(true);
        }}>픽업 취소하기</ActionButton>
      </>}
      {cancel && <InlineForm title="픽업 취소하기" saveLabel="취소 확정하기" onClose={() => setCancel(false)} onSave={() => {
        if (!row.pickup) return;
        const result = port.dispatch({ type: 'pickup.cancel', reservationId: row.pickup.reservationId, idempotencyKey: requestKey() });
        if (!result.ok) setError(commandError(result.reason)); else { setCancel(false); if (result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, undoToken: result.undoToken }); }
      }}><p>연결된 주문제작도 함께 취소해요</p></InlineForm>}
      {error && <p role="alert" className="custom-error">{error}</p>}
    </div>}
  </section>;
}

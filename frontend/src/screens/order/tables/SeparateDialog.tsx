import { useState } from 'react';
import { useBundle } from '../../../i18n';
import { usePosSnapshot } from '../../../pos/react';
import { quoteBill } from '../../../pos/tables';
import { ActionButton, ChecklistRow, PosDialog, PosMoney, PosQuantityStepper } from '../../../ui';
import { tableTransferBundle } from './messages';

export function SeparateDialog({ billId, onClose, onNext }: {
  billId: string; onClose: () => void; onNext: (lines: readonly { orderLineId: string; qty: number }[]) => void;
}) {
  const read = usePosSnapshot(), { t } = useBundle(tableTransferBundle);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const bill = read.pos.bills.find(b => b.billId === billId), quote = quoteBill(read, billId);
  const returnFocus = { get current() { return document.querySelector<HTMLElement>(`[data-pos-table="${bill?.tableId}"]`); } };
  const allocations = read.pos.billAllocations.filter(a => a.billId === billId);
  const lines = read.pos.orders.flatMap(o => o.lines).flatMap(line => {
    const qty = allocations.filter(a => a.orderLineId === line.orderLineId).reduce((n, a) => n + a.qty, 0);
    return qty ? [{ ...line, qty }] : [];
  });
  const selection = lines.flatMap(line => selected[line.orderLineId] ? [{ orderLineId: line.orderLineId, qty: Math.min(selected[line.orderLineId], line.qty) }] : []);
  const count = selection.reduce((n, line) => n + line.qty, 0);
  const canSeparate = count > 0 && count < quote.totalQty;
  return <PosDialog open title={t('table.separateTitle')} onClose={onClose} returnFocusRef={returnFocus}
    footer={<ActionButton size="primary" disabled={!canSeparate} onClick={() => onNext(selection)}>{t('table.next')}</ActionButton>}>
    <div className="pos-table-detail">
      {lines.map(line => <div key={line.orderLineId} className="pos-table-separate__line">
        <ChecklistRow checked={!!selected[line.orderLineId]} onCheckedChange={checked => setSelected(s => ({ ...s, [line.orderLineId]: checked ? 1 : 0 }))}>
          <strong>{line.nameAtOrder}</strong><small>{line.optionsAtOrder.map(o => o.name).join(' · ')}{line.request ? ` · ${line.request}` : ''}</small>
        </ChecklistRow>
        <PosQuantityStepper name={line.nameAtOrder} value={selected[line.orderLineId] ?? 0}
          onChange={qty => setSelected(s => ({ ...s, [line.orderLineId]: Math.max(0, Math.min(qty, line.qty)) }))}/>
        <PosMoney amount={line.unitPriceAtOrder * (selected[line.orderLineId] ?? 0)}/>
      </div>)}
    </div>
  </PosDialog>;
}

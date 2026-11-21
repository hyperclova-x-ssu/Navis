import type { PosDrawerSnapshot, PosState } from '../../contracts/pos';
import { freezePos } from '../domain/common';

/** Original approved splits survive cancellation; each return is subtracted only here. */
export function selectPosDrawer(pos: PosState, scenario: 'normal' | 'empty' = 'normal'): PosDrawerSnapshot {
  const cash = (splits: readonly { readonly method: string; readonly amount: number }[]) => splits.filter(s => s.method === 'cash').reduce((n, s) => n + s.amount, 0);
  const active = scenario === 'normal';
  const approvedCash = active ? pos.payments.reduce((n, p) => n + cash(p.splits), 0) : 0;
  const pendingCash = active ? pos.payments.filter(p => p.status === 'paid' && !p.recognizedAt).reduce((n, p) => n + cash(p.splits), 0) : 0;
  const cashCanceled = active ? pos.cancellations.reduce((n, c) => n + cash(c.methodAmounts), 0) : 0;
  const cashRefunded = active ? pos.refunds.reduce((n, r) => n + cash(r.methodAmounts), 0) : 0;
  const drawer = active ? pos.drawer : { ...pos.drawer, actual: null, memo: '', movements: [] };
  const incoming = drawer.movements.filter(m => m.kind === 'in').reduce((n, m) => n + m.amount, 0);
  const outgoing = drawer.movements.filter(m => m.kind === 'out').reduce((n, m) => n + m.amount, 0);
  const cashReturned = cashCanceled + cashRefunded, cashNet = approvedCash - cashReturned;
  const expected = drawer.opening + cashNet + incoming - outgoing;
  return freezePos({ ...drawer, approvedCash, cashPayments: approvedCash - pendingCash, pendingCash, cashCanceled, cashRefunded, cashReturned, cashNet,
    in: incoming, out: outgoing, expected, difference: drawer.actual === null ? null : drawer.actual - expected });
}

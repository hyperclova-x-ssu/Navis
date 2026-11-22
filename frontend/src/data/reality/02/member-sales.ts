import type { PosState } from '../../../contracts/pos';
import type { MoneyCorrection, MoneyPayment, MoneyState, SalesRecognition, Settlement } from '../../iteration7/accounting/types';
import { distributePosAmount } from '../../../pos/domain/money';
import type { PosReceiptDto } from './dto';
import { kstLocal } from './clock';

export function projectMemberSales(pos: PosState, money: MoneyState, receipts: readonly PosReceiptDto[]): MoneyState {
  const settlements: Settlement[] = [], payments: MoneyPayment[] = [], recognitions: SalesRecognition[] = [], corrections: MoneyCorrection[] = [];
  for (const receipt of receipts) {
    const bill = pos.bills.find(row => row.billId === receipt.billId);
    // Older receipts lack an allocation snapshot. Keep the real deposit and the original receipt visible.
    if (!bill) continue;
    const settlementId = `legacy:${receipt.paymentId ?? receipt.settlementId}`;
    const sourceRef = { kind: 'bill', id: receipt.billId }, at = kstLocal(receipt.at);
    const wire = receipt.memberAllocations ?? receipt.splits.map(split => ({ ...split, kind: 'method' as const }));
    const allocations = wire.map((row, index) => ({ ...row, ...('allocationId' in row ? { billAllocationId: row.allocationId } : {}), allocationId: `${settlementId}:${index}` }));
    settlements.push({ settlementId, sourceRef, at, purpose: 'sale', billId: receipt.billId, memberId: receipt.memberId ?? null, partId: null,
      amount: receipt.amount, allocations, status: 'paid' });
    if (receipt.paymentId && receipt.splits.length) payments.push({ settlementId, sourceRef, at, purpose: 'sale', paymentId: receipt.paymentId,
      amount: receipt.realAmount ?? receipt.splits.reduce((total, split) => total + split.amount, 0), splits: receipt.splits });

    const lines = bill.settlementLines.map(line => {
      const gross = (line.basePriceAtSale + line.optionPriceAtSale) * line.qty;
      const discount = line.discountAllocations.reduce((total, row) => total + row.amount, 0);
      const pass = allocations.find(row => 'billAllocationId' in row && row.billAllocationId === line.allocationId);
      const remainder = Math.max(0, gross - discount - (pass?.amount ?? 0));
      return { line, gross, discount, pass, balance: remainder };
    });
    const shares = lines.map(() => new Map<string, number>());
    for (const allocation of allocations) {
      if ('billAllocationId' in allocation) {
        const index = lines.findIndex(value => value.line.allocationId === allocation.billAllocationId);
        if (index >= 0) shares[index].set(allocation.allocationId, allocation.amount);
        continue;
      }
      const byLine = distributePosAmount(allocation.amount, lines.map(line => ({ id: line.line.allocationId, amount: line.balance })));
      lines.forEach((value, index) => { const amount = byLine[value.line.allocationId] ?? 0; value.balance -= amount; if (amount) shares[index].set(allocation.allocationId, amount); });
    }
    const original = lines.flatMap(({ line, gross, discount, pass }, index) => allocations.filter(row => shares[index].has(row.allocationId)).map((allocation, part): SalesRecognition => {
      const category = allocation.kind === 'method' ? allocation.method : allocation.kind === 'membership_period' ? 'subscription_day' : allocation.kind;
      const membershipDiscount = pass && 'membershipDiscount' in pass ? pass.membershipDiscount : 0;
      return { recognitionId: `${settlementId}:${line.allocationId}:${part}`, source: 'menu', sourceId: receipt.billId, businessDate: pos.businessDate, at,
        amount: shares[index].get(allocation.allocationId) ?? 0, cost: part ? 0 : line.unitCostAtSale === null || line.optionCostAtSale === null ? null : (line.unitCostAtSale + line.optionCostAtSale) * line.qty,
        settlementCategory: category, settlementId, settlementAllocationId: allocation.allocationId, menuId: line.menuId, billAllocationId: line.allocationId,
        orderLineId: pos.billAllocations.find(value => value.allocationId === line.allocationId)?.orderLineId, quantity: part ? 0 : line.qty, gross: part ? 0 : gross,
        discountBySource: part ? undefined : { direct: Math.max(0, discount - membershipDiscount), membership: membershipDiscount, coupon: 0 }, originalRecognitionId: null };
    }));
    recognitions.push(...original);
    for (const correction of receipt.corrections) {
      const correctedAt = kstLocal(correction.at);
      const amounts = distributePosAmount(correction.amount, original.map(row => ({ id: row.recognitionId, amount: row.amount })));
      const effects = original.map(row => ({ ...row, recognitionId: `legacy:${correction.correctionId}:${row.recognitionId}`, at: correctedAt,
        amount: -(amounts[row.recognitionId] ?? 0), cost: correction.kind === 'cancel' && row.cost !== null ? -row.cost : 0,
        gross: correction.kind === 'cancel' ? -(row.gross ?? 0) : 0, quantity: correction.kind === 'cancel' ? -(row.quantity ?? 0) : 0,
        discountBySource: correction.kind === 'cancel' && row.discountBySource ? { direct: -row.discountBySource.direct, membership: -row.discountBySource.membership, coupon: -row.discountBySource.coupon } : undefined,
        originalRecognitionId: row.recognitionId }));
      recognitions.push(...effects);
      corrections.push({ correctionId: correction.correctionId, settlementId, at: correctedAt, kind: correction.kind, amount: correction.amount,
        realMethodReturns: correction.methods, originalAllocationEffects: [], accountEffects: [], membershipEffects: [], recognitionEffects: effects, lineEffects: [] });
    }
  }
  return { ...money, settlements: [...money.settlements, ...settlements], payments: [...money.payments, ...payments],
    recognitions: [...money.recognitions, ...recognitions], corrections: [...money.corrections, ...corrections] };
}

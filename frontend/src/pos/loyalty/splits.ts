import type { PosLoyaltyQuote, PosMethod, PosMethodSplit, PosSplitInput, PosSplitPlan } from '../../contracts/pos';
import { freezePos, money, posFailure } from '../domain/common';
import { distributePosAmount, countedPosMethod } from '../domain/money';

export function normalizeMethodSplits(input: readonly PosMethodSplit[], amount: number) {
  const methods: readonly PosMethod[] = ['card', 'easy_pay', 'cash'];
  if (!input.length || input.some(s => !methods.includes(s.method))) return posFailure('INVALID_METHOD');
  if (!money(amount) || input.some(s => !money(s.amount) || s.amount === 0)) return posFailure('INVALID_AMOUNT');
  const total = input.reduce((n, s) => n + s.amount, 0);
  if (!money(total)) return posFailure('INVALID_AMOUNT');
  if (total !== amount) return posFailure('SPLIT_TOTAL_MISMATCH', 'VALIDATION', { remaining: amount - total });
  const splits = methods.flatMap(method => {
    const sum = input.filter(s => s.method === method).reduce((n, s) => n + s.amount, 0);
    return sum ? [{ method, amount: sum }] : [];
  });
  return freezePos({ ok: true as const, splits, countedMethod: countedPosMethod(splits) });
}

export function buildSplitPlan(quote: PosLoyaltyQuote, input: PosSplitInput) {
  const count = input.kind === 'equal' ? input.n : input.parts.length;
  if (!Number.isInteger(count) || count < 2 || count > 10) return posFailure('INVALID_PART_COUNT');
  if (!money(quote.payable) || quote.payable === 0) return posFailure('ZERO_CONFIRM_REQUIRED');
  let amounts: number[], quantities: PosSplitPlan['parts'][number]['lineQtyAllocations'][];
  if (input.kind === 'equal') {
    const each = Math.floor(quote.payable / count);
    amounts = Array.from({ length: count }, (_, i) => i === count - 1 ? quote.payable - each * (count - 1) : each);
    quantities = amounts.map(() => undefined);
  } else {
    const totals = new Map<string, number>();
    for (const part of input.parts) {
      const ids = new Set<string>();
      if (!part.lineQtyAllocations.length) return posFailure('QTY_ALLOCATION_INVALID');
      for (const row of part.lineQtyAllocations) {
        if (!Number.isSafeInteger(row.qty) || row.qty <= 0 || ids.has(row.allocationId) || !quote.lines.some(l => l.lineId === row.allocationId)) return posFailure('QTY_ALLOCATION_INVALID');
        ids.add(row.allocationId); totals.set(row.allocationId, (totals.get(row.allocationId) ?? 0) + row.qty);
      }
    }
    if (quote.lines.some(l => totals.get(l.lineId) !== l.qty)) return posFailure('QTY_ALLOCATION_INVALID');
    amounts = input.parts.map(() => 0);
    // Split each already discounted line net, so each won belongs to exactly one part.
    for (const line of quote.settlementLines) {
      const net = (line.basePriceAtSale + line.optionPriceAtSale) * line.qty - line.discountAllocations.reduce((n, d) => n + d.amount, 0);
      const weights = input.parts.map((p, i) => ({ id: String(i), amount: p.lineQtyAllocations.find(a => a.allocationId === line.allocationId)?.qty ?? 0 }));
      const allocated = distributePosAmount(net, weights);
      amounts = amounts.map((n, i) => n + allocated[String(i)]);
    }
    quantities = input.parts.map(p => p.lineQtyAllocations);
  }
  if (amounts.some(n => !money(n) || n === 0)) return posFailure('INVALID_AMOUNT');
  const planId = `${quote.billId}:split:${quote.revision}`;
  const plan: PosSplitPlan = { planId, billId: quote.billId, kind: input.kind, lines: quote.lines, settlementLines: quote.settlementLines,
    parts: amounts.map((amount, i) => ({ partId: `${planId}:${i + 1}`, amount, status: 'unpaid', ...(quantities[i] ? { lineQtyAllocations: quantities[i] } : {}) })) };
  return freezePos({ ok: true as const, plan });
}

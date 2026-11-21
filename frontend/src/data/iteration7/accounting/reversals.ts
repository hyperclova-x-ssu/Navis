import type { PosCommandMeta, PosFailure } from '../../../contracts/pos';
import { allocatePosAmount, distributePosAmount } from '../../../pos/domain/money';
import { sourceAvailable } from '../accounts';
import { quoteMembershipRefund } from '../memberships';
import type { MemberAccountTxn, MembershipUse, MoneyPlan, MoneyRead, MoneyReversalQuote, SalesRecognition, SourceRef } from './types';
import { available, canonical, emptyEffects, failure, guard, methods, nonnegative, positive, publish } from './shared';
import { returnedAllocation, sameSource, settlementActive, settlementLineQuantityLeft, settlementRemaining } from './settlement';

// Partition each complete line metric before distributing it across funding rows.
// The remainder uses the same stable-ID integer allocator as the original sale.
const quantityShare = (amount: number, quantity: number, remaining: number) =>
  distributePosAmount(amount, [{ id: 'selected', amount: quantity }, { id: 'remaining', amount: remaining - quantity }]).selected;

export function quoteMoneyReversal(read: MoneyRead, input: MoneyReversalQuote['input']): MoneyReversalQuote {
  const settlementId = input.settlementId ?? read.state.payments.find(p => p.paymentId === input.paymentId)?.settlementId ?? '';
  const s = read.state.settlements.find(s => s.settlementId === settlementId), issues: PosFailure[] = [];
  const blocked = available(read); if (blocked) issues.push(blocked);
  if (!s) issues.push(failure('NOT_FOUND', 'NOT_FOUND'));
  if (!['cancel', 'refund'].includes(input.kind)) issues.push(failure('INVALID_OUTCOME'));
  const previous = read.state.corrections.filter(c => c.settlementId === settlementId);
  const source = s?.sourceSnapshot;
  const returnedQty = (id: string) => read.state.corrections.filter(c => read.state.settlements.some(o => o.settlementId === c.settlementId && s && sameSource(o.sourceRef, s.sourceRef)))
    .flatMap(c => c.quantityReturns ?? []).filter(q => q.allocationId === id).reduce((n, q) => n + q.quantity, 0);
  const qtyLeft = (id: string) => (source?.lines.find(l => l.allocationId === id)?.quantity ?? 0) - returnedQty(id);
  const pass = s?.purpose === 'membership_sale' ? read.state.memberships.find(m => m.saleSettlementId === settlementId) : undefined;
  const passRefund = pass ? quoteMembershipRefund(read, { membershipId: pass.membershipId }) : null;
  const remainingRefundable = passRefund?.amount ?? (s ? settlementRemaining(read, s) : 0);
  const amount = input.amount ?? remainingRefundable;
  const currentSource = s ? read.sources.find(o => sameSource(o.sourceRef, s.sourceRef)) ?? source : undefined;
  const originalRows = read.state.recognitions.filter(r => !r.originalRecognitionId && s && r.sourceId === s.sourceRef.id && ['menu', 'membership_count'].includes(r.source));
  const sourceRecognized = originalRows.length > 0;
  const ownPart = source?.parts?.find(p => p.partId === s?.partId);
  // Full item returns use the same quantities and checks as explicit selections.
  // Refunds consume returnable quantities while retaining physical usage/cost.
  const lines = input.lines ?? (s?.purpose === 'sale' && sourceRecognized && amount === remainingRefundable && (!source?.parts?.length || ownPart?.allocationIds)
    ? source?.lines.filter(l => !ownPart?.allocationIds || ownPart.allocationIds.includes(l.allocationId))
      .map(l => ({ allocationId: l.allocationId, quantity: Math.min(qtyLeft(l.allocationId), settlementLineQuantityLeft(read, s, l.allocationId)) }))
      .filter(l => l.quantity > 0) : undefined);
  if (!nonnegative(amount) || amount > remainingRefundable || !positive(amount) && !lines?.length && (s?.amount !== 0 || previous.length)) issues.push(failure('REFUND_LIMIT'));
  const prepared = currentSource?.prepared;
  const selectedLines = lines ?? currentSource?.lines.filter(l => s && settlementLineQuantityLeft(read, s, l.allocationId) > 0);
  const selectedPrepared = selectedLines?.length ? selectedLines.map(l => currentSource?.lines.find(row => row.allocationId === l.allocationId)?.prepared ?? prepared) : [prepared];
  if (input.kind === 'cancel' && selectedPrepared.some(Boolean)) issues.push(failure('USE_REFUND'));
  if (input.kind === 'refund' && s?.purpose === 'sale' && selectedPrepared.some(p => p === false)) issues.push(failure('USE_CANCEL'));
  if (input.amount !== undefined && input.lines) issues.push(failure('INVALID_SELECTION'));
  if (lines && (!lines.length || new Set(lines.map(l => l.allocationId)).size !== lines.length || lines.some(l => !positive(l.quantity) || !s || l.quantity > Math.min(qtyLeft(l.allocationId), settlementLineQuantityLeft(read, s, l.allocationId))))) issues.push(failure('QTY_LIMIT'));
  const accountOrigins = read.state.accountTxns.filter(t => t.settlementId === settlementId && t.kind !== 'reversal');
  if (s?.purpose === 'charge_topup') {
    const topup = accountOrigins.find(t => t.kind === 'topup');
    if (amount !== s.amount || !topup || sourceAvailable(read, topup.txnId) < s.amount) issues.push(failure('TOPUP_ALREADY_USED'));
  }
  if (s?.purpose === 'membership_sale') {
    if (!passRefund) issues.push(failure('NOT_FOUND', 'NOT_FOUND'));
    else issues.push(...passRefund.issues);
    if (amount !== remainingRefundable || input.lines) issues.push(failure('REFUND_LIMIT'));
  }
  for (const debt of accountOrigins.filter(t => t.account === 'receivable' && t.kind === 'sale')) {
    const collections = read.state.accountTxns.filter(t => t.kind === 'collection' && t.sourceAmounts?.some(a => a.txnId === debt.txnId)
      && Math.abs(t.amount) - read.state.accountTxns.filter(r => r.originalTxnId === t.txnId).reduce((n, r) => n + r.amount, 0) > 0);
    if (collections.length) issues.push(failure('RECEIVABLE_ALREADY_COLLECTED', 'VALIDATION', { debtTxnId: debt.txnId, collectionIds: collections.map(c => c.settlementId), amounts: collections.map(c => ({ settlementId: c.settlementId, amount: -c.amount })) }));
  }
  const weights = s?.allocations.map(a => ({ id: a.allocationId!, amount: a.amount - returnedAllocation(read, a.allocationId!) })) ?? [];
  let amountByAllocation: Readonly<Record<string, number>> = {};
  if (!issues.length) amountByAllocation = allocatePosAmount(amount, weights);
  let actualAmount = amount;
  const byRecognition = new Map<string, number>();
  const remainingMetric = (r: SalesRecognition, metric: (r: SalesRecognition) => number) => metric(r) + read.state.recognitions.filter(c => c.originalRecognitionId === r.recognitionId).reduce((n, c) => n + metric(c), 0);
  if (lines?.length && s && !issues.length) {
    for (const line of lines) {
      const own = originalRows.filter(r => r.settlementId === settlementId && r.billAllocationId === line.allocationId);
      const metricTotal = (metric: (r: SalesRecognition) => number) => own.reduce((n, r) => n + remainingMetric(r, metric), 0);
      const quantityLeft = settlementLineQuantityLeft(read, s, line.allocationId);
      const remainingAmount = metricTotal(r => r.amount);
      // Refunds retain physical metrics. Pair their remaining money with their
      // remaining returnable quantity, including a later cancellation of this line.
      let amount: number;
      if (input.kind === 'refund' || quantityLeft < metricTotal(r => r.quantity ?? 0)) {
        amount = quantityShare(remainingAmount, line.quantity, quantityLeft);
      } else {
        const gross = quantityShare(metricTotal(r => r.gross ?? 0), line.quantity, quantityLeft);
        const discount = (['direct', 'coupon', 'membership'] as const).reduce((n, key) => n + quantityShare(metricTotal(r => r.discountBySource?.[key] ?? 0), line.quantity, quantityLeft), 0);
        amount = Math.min(remainingAmount, Math.max(0, gross - discount));
      }
      const values = allocatePosAmount(amount, own.map(r => ({ id: r.recognitionId, amount: remainingMetric(r, r => r.amount) })));
      for (const r of own) byRecognition.set(r.recognitionId, values[r.recognitionId]);
    }
    amountByAllocation = Object.fromEntries(weights.map(w => [w.id, originalRows.filter(r => r.settlementAllocationId === w.id).reduce((n, r) => n + (byRecognition.get(r.recognitionId) ?? 0), 0)]));
    actualAmount = Object.values(amountByAllocation).reduce((n, v) => n + v, 0);
    if (weights.some(w => amountByAllocation[w.id] > w.amount)) issues.push(failure('REFUND_LIMIT'));
  }
  const fullSourceReturn = s && read.state.settlements.filter(o => sameSource(o.sourceRef, s.sourceRef) && o.purpose === s.purpose).every(o => settlementRemaining(read, o) - (o.settlementId === settlementId ? actualAmount : 0) === 0);
  const quantityReturns = lines ? [...lines] : (fullSourceReturn && sourceRecognized ? source?.lines.filter(l => qtyLeft(l.allocationId) > 0).map(l => ({ allocationId: l.allocationId, quantity: qtyLeft(l.allocationId) })) ?? [] : []);
  if (input.kind === 'cancel' && currentSource?.wholeBillDiscount && lines && source?.lines.some(l => (lines.find(q => q.allocationId === l.allocationId)?.quantity ?? 0) !== qtyLeft(l.allocationId))) issues.push(failure('WHOLE_BILL_DISCOUNT'));
  const metrics = new Map<string, { quantity: number; gross: number; cost: number; direct: number; coupon: number; membership: number }>();
  if (input.kind === 'cancel' && !issues.length) for (const line of quantityReturns) {
    const own = originalRows.filter(r => r.billAllocationId === line.allocationId && (!lines || r.settlementId === settlementId));
    // Only cancellations undo production; earlier refunds still own their stock/cost.
    const quantityLeft = own.reduce((n, r) => n + remainingMetric(r, r => r.quantity ?? 0), 0);
    const keys = ['quantity', 'gross', 'cost', 'direct', 'coupon', 'membership'] as const;
    for (const key of keys) {
      const metric = (r: SalesRecognition) => key === 'direct' || key === 'coupon' || key === 'membership' ? r.discountBySource?.[key] ?? 0 : r[key] ?? 0;
      const weights = own.map(r => ({ id: r.recognitionId, amount: remainingMetric(r, metric) }));
      const total = weights.reduce((n, w) => n + w.amount, 0);
      const target = key === 'quantity' ? line.quantity : quantityShare(total, line.quantity, quantityLeft);
      const values = allocatePosAmount(target, weights);
      for (const r of own) { const row = metrics.get(r.recognitionId) ?? { quantity: 0, gross: 0, cost: 0, direct: 0, coupon: 0, membership: 0 }; row[key] = values[r.recognitionId]; metrics.set(r.recognitionId, row); }
    }
  }
  const originalAllocationEffects = (s?.allocations ?? []).filter(a => (amountByAllocation[a.allocationId!] ?? 0) > 0 || a.kind === 'membership_period' && actualAmount === 0 && !issues.length).map(a => ({ allocationId: a.allocationId!, amount: amountByAllocation[a.allocationId!] ?? 0 }));
  const realMethodReturns = methods.flatMap(method => {
    const value = s?.allocations.filter(a => a.kind === 'method' && a.method === method).reduce((n, a) => n + (amountByAllocation[a.allocationId!] ?? 0), 0) ?? 0;
    return value ? [{ method, amount: value }] : [];
  });
  if (input.methodAmounts && canonical(input.methodAmounts) !== canonical(realMethodReturns)) issues.push(failure('METHOD_LIMIT'));
  const id = `correction:${settlementId}:${read.revision}`, accountEffects: MemberAccountTxn[] = [];
  for (const t of accountOrigins) {
    const value = t.allocationId ? amountByAllocation[t.allocationId] ?? 0 : s?.amount ? Number(BigInt(Math.abs(t.amount)) * BigInt(actualAmount) / BigInt(s.amount)) : 0;
    if (!value) continue;
    const sourceAmounts = t.sourceAmounts ? allocatePosAmount(value, t.sourceAmounts.map(a => ({ id: a.txnId, amount: a.amount - read.state.accountTxns.filter(r => r.originalTxnId === t.txnId).flatMap(r => r.sourceAmounts ?? []).filter(r => r.txnId === a.txnId).reduce((n, r) => n + r.amount, 0) }))) : null;
    accountEffects.push({ ...t, txnId: `${id}:${t.txnId}`, at: read.now, kind: 'reversal', amount: -Math.sign(t.amount) * value, originalTxnId: t.txnId,
      ...(sourceAmounts ? { sourceAmounts: Object.entries(sourceAmounts).filter(([, amount]) => amount > 0).map(([txnId, amount]) => ({ txnId, amount })) } : {}) });
  }
  const recognitionEffects: SalesRecognition[] = [];
  for (const r of read.state.recognitions.filter(r => !r.originalRecognitionId&&(r.settlementId===settlementId||metrics.has(r.recognitionId)||quantityReturns.length&&read.state.settlements.some(o=>o.settlementId===r.settlementId&&s&&sameSource(o.sourceRef,s.sourceRef))))) {
    const owner=read.state.settlements.find(o=>o.settlementId===r.settlementId);
    const a = owner?.allocations.find(a => a.allocationId === r.settlementAllocationId);
    if (!a && !metrics.has(r.recognitionId)) continue;
    const returned = a && owner?.settlementId===settlementId?amountByAllocation[a.allocationId!] ?? 0:0;
    const siblings = a ? read.state.recognitions.filter(o => o.settlementAllocationId === a.allocationId && !o.originalRecognitionId) : [];
    const distribution = allocatePosAmount(returned, siblings.map(o => ({ id: o.recognitionId, amount: o.amount + read.state.recognitions.filter(c => c.originalRecognitionId === o.recognitionId).reduce((n, c) => n + c.amount, 0) })));
    const value = lines ? byRecognition.get(r.recognitionId) ?? 0 : distribution[r.recognitionId] ?? 0;
    const metric = metrics.get(r.recognitionId);
    if (!value && !metric) continue;
    recognitionEffects.push({ ...r, recognitionId: `${id}:${r.recognitionId}`, at: read.now, businessDate: read.businessDate, amount: -value,
      quantity: -(metric?.quantity ?? 0), gross: -(metric?.gross ?? 0),
      discountBySource: { direct: -(metric?.direct ?? 0), coupon: -(metric?.coupon ?? 0), membership: -(metric?.membership ?? 0) },
      cost: -(metric?.cost ?? 0), originalRecognitionId: r.recognitionId });
  }
  const membershipEffects: MembershipUse[] = [];
  for (const use of read.state.uses.filter(u => !u.canceledAt && (s?.allocations.some(a => a.useId === u.useId)||source?.lines.some(l=>u.coveredQuantities.some(q=>q.allocationId===l.allocationId))))) {
    const allocations = read.state.settlements.flatMap(s => s.allocations).filter(a => a.useId === use.useId);
    const exhausted = allocations.every(a => a.amount - returnedAllocation(read, a.allocationId!) - (amountByAllocation[a.allocationId!] ?? 0) === 0);
    const zeroUseReturned = use.coveredQuantities.every(q => read.state.corrections.flatMap(c=>c.quantityReturns??[]).filter(r=>r.allocationId===q.allocationId).reduce((n,r)=>n+r.quantity,0)+quantityReturns.filter(r=>r.allocationId===q.allocationId).reduce((n,r)=>n+r.quantity,0)>=q.quantity);
    if (exhausted && (zeroUseReturned || !sourceRecognized)) membershipEffects.push({ ...use, canceledAt: read.now });
  }
  const recognized = s && read.state.recognitions.some(r => r.sourceId === s.sourceRef.id && ['menu', 'membership_count'].includes(r.source) && !r.originalRecognitionId);
  const lineEffects = source && input.kind === 'cancel' && recognized ? source.lines.flatMap(l => {
    const qty = quantityReturns.find(q => q.allocationId === l.allocationId)?.quantity ?? 0;
    if (!qty) return [];
    return [{ allocationId: l.allocationId, orderLineId: l.orderLineId, menuId: l.menuId, quantity: -qty,
      stock: (l.recipe ?? []).map(r => ({ itemId: r.itemId, deltaBase: r.quantityBase * qty })) }];
  }) : [];
  if (source?.purpose === 'custom_order') {
    for (const r of read.state.recognitions.filter(r => r.source === 'custom_pickup' && r.sourceId === source.sourceRef.id && !r.originalRecognitionId)) {
      const value = Math.min(actualAmount, r.amount + read.state.recognitions.filter(c => c.originalRecognitionId === r.recognitionId).reduce((n, c) => n + c.amount, 0));
      recognitionEffects.push({ ...r, recognitionId: `${id}:${r.recognitionId}`, at: read.now, businessDate: read.businessDate, amount: -value, cost: null, originalRecognitionId: r.recognitionId });
    }
  }
  const base = { quoteRevision: read.revision, settlementId, kind: input.kind, amount: actualAmount, remainingRefundable, originalAllocationEffects, realMethodReturns,
    accountEffects, membershipEffects, recognitionEffects, lineEffects, quantityReturns, membershipTermsEffects: pass ? [{ ...pass, refundedAt: read.now }] : [], canSubmit: !issues.length, issues, input };
  return { ...base, quoteId: canonical({ ...base, runId: read.runId, generation: read.generation, scenario: read.scenario }) };
}
export function planMoneyReversal(read: MoneyRead, input: { readonly quote: MoneyReversalQuote; readonly meta: PosCommandMeta }): MoneyPlan {
  const payload = { type: 'money.reverse', quoteId: input.quote.quoteId }, checked = guard(read, input.meta, payload); if (checked) return checked;
  if (read.state.attempt) return failure('APPROVAL_BUSY', 'CONFLICT');
  const current = quoteMoneyReversal(read, input.quote.input);
  if (canonical(current) !== canonical(input.quote)) return failure('QUOTE_CHANGED', 'CONFLICT');
  if (!current.canSubmit) return current.issues[0];
  if (read.scenario === 'payment-failure') return failure('REVERSAL_FAILED', 'PREVIEW_FAILURE');
  const correctionId = `money-correction:${read.runId}:${input.meta.idempotencyKey}`;
  const { settlementId, kind, amount, originalAllocationEffects, realMethodReturns, accountEffects, membershipEffects, recognitionEffects, lineEffects, quantityReturns } = current;
  const correction = { correctionId, settlementId, at: read.now, kind, amount, originalAllocationEffects, realMethodReturns, accountEffects, membershipEffects, recognitionEffects, lineEffects, quantityReturns };
  return publish(read, { ...emptyEffects(), corrections: [correction], accountTxns: accountEffects, uses: membershipEffects, memberships: current.membershipTermsEffects ?? [], recognitions: recognitionEffects, lineEffects }, { correctionId, settlementId, accountEffects }, input.meta, payload);
}
export function planAbandonSettlement(read: MoneyRead, input: { readonly sourceRef: SourceRef; readonly meta: PosCommandMeta }): MoneyPlan {
  const payload = { type: 'money.abandon', sourceRef: input.sourceRef }, checked = guard(read, input.meta, payload); if (checked) return checked;
  if (read.state.attempt) return failure('APPROVAL_BUSY', 'CONFLICT');
  if (read.state.recognitions.some(r => r.sourceId === input.sourceRef.id && ['menu', 'membership_count'].includes(r.source))) return failure('NOT_PARTIAL');
  let current = read;
  const effects = emptyEffects();
  let all = effects;
  for (const s of read.state.settlements.filter(s => sameSource(s.sourceRef, input.sourceRef) && settlementActive(read, s))) {
    const quote = quoteMoneyReversal(current, { settlementId: s.settlementId, kind: 'cancel' });
    const p = planMoneyReversal(current, { quote, meta: { runId: read.runId, idempotencyKey: `${input.meta.idempotencyKey}:${s.settlementId}` } });
    if (!p.ok) return p;
    all = Object.fromEntries(Object.keys(all).map(k => [k, [...all[k as keyof typeof all], ...p.effects[k as keyof typeof all]]])) as unknown as typeof effects;
    current = { ...current, state: p.nextState, revision: current.revision + 1 };
  }
  return publish(read, all, {}, input.meta, payload);
}

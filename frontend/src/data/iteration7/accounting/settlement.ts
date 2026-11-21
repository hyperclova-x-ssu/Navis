import type { PosCommandMeta, PosFailure } from '../../../contracts/pos';
import { allocatePosAmount, distributePosAmount } from '../../../pos/domain/money';
import { accountBalance, allocateAccountSources } from '../accounts';
import { quoteMembershipUse } from '../memberships';
import type { MemberAccountTxn, MembershipUse, MoneyEffects, MoneyPlan, MoneyRead, MoneySource, SalesRecognition, Settlement, SettlementAllocation, SettlementQuote, SettlementTarget } from './types';
import { addDate, available, canonical, emptyEffects, failure, freezePos, guard, methods, nonnegative, positive, publish, validDate } from './shared';

export function findMoneySource(read: MoneyRead, target: SettlementTarget) {
  return read.sources.find(s => target.purpose === 'sale' && s.purpose === 'sale' && (target.billId ? s.billId === target.billId : !!target.cartId && s.cartId === target.cartId)
    || target.purpose === 'custom_order' && s.purpose === 'custom_order' && s.sourceRef.id === target.customOrderId);
}
export const sameSource = (a: { readonly kind: string; readonly id: string }, b: { readonly kind: string; readonly id: string }) => a.kind === b.kind && a.id === b.id;
export const returnedAllocation = (read: MoneyRead, id: string) => read.state.corrections.flatMap(c => c.originalAllocationEffects).filter(a => a.allocationId === id).reduce((n, a) => n + a.amount, 0);
export const settlementRemaining = (read: MoneyRead, s: Settlement) => s.amount - read.state.corrections.filter(c => c.settlementId === s.settlementId).reduce((n, c) => n + c.amount, 0);
export const settlementActive = (read: MoneyRead, s: Settlement) => settlementRemaining(read, s) > 0 || s.amount === 0 && !read.state.corrections.some(c => c.settlementId === s.settlementId);
export const settlementLineQuantityLeft = (read: MoneyRead, s: Settlement, allocationId: string) => {
  const rows = read.state.recognitions.filter(r => r.settlementId === s.settlementId && r.billAllocationId === allocationId && !r.originalRecognitionId);
  const quantity = rows.reduce((n, r) => n + (r.quantity ?? 0), 0);
  const remainingQuantity = quantity + read.state.recognitions.filter(r => rows.some(o => o.recognitionId === r.originalRecognitionId)).reduce((n, r) => n + (r.quantity ?? 0), 0);
  const returned = read.state.corrections.filter(c => c.settlementId === s.settlementId).flatMap(c => c.quantityReturns ?? []).filter(q => q.allocationId === allocationId).reduce((n, q) => n + q.quantity, 0);
  return Math.max(0, Math.min(quantity - returned, remainingQuantity));
};

export function quoteSettlement(read: MoneyRead, input: { readonly target: SettlementTarget; readonly allocations: readonly SettlementAllocation[] }): SettlementQuote {
  const { target } = input, issues: PosFailure[] = [], blocked = available(read); if (blocked) issues.push(blocked);
  const funding = !['sale', 'custom_order'].includes(target.purpose), source = findMoneySource(read, target);
  const memberId = 'memberId' in target ? target.memberId : source?.memberId;
  const product = target.purpose === 'membership_sale' ? read.products.find(p => p.productId === target.productId) : undefined;
  if (!['sale', 'custom_order', 'charge_topup', 'receivable_collection', 'membership_sale'].includes(target.purpose)) issues.push(failure('INVALID_SETTLEMENT_KIND'));
  if (funding && (!memberId || !read.members.some(m => m.memberId === memberId)) || target.purpose === 'membership_sale' && !product || !funding && !source) issues.push(failure('NOT_FOUND', 'NOT_FOUND'));
  if (source?.canSubmit === false) issues.push(...(source.issues?.length ? source.issues : [failure('QUOTE_CHANGED', 'CONFLICT')]));
  if (source && (!nonnegative(source.amountDue) || source.purpose === 'sale' && (!source.lines.length || new Set(source.lines.map(l => l.allocationId)).size !== source.lines.length
    || source.lines.some(l => !positive(l.quantity) || !nonnegative(l.unitPrice) || !nonnegative(l.unitPrice * l.quantity) || l.unitCost !== null && !nonnegative(l.unitCost)
      || Object.values(l.discountBySource ?? {}).some(d => !nonnegative(d)) || Object.values(l.discountBySource ?? {}).reduce((n, d) => n + d, 0) > l.unitPrice * l.quantity)))) issues.push(failure('INVALID_AMOUNT'));
  if (memberId && !read.members.some(m => m.memberId === memberId)) issues.push(failure('NOT_FOUND', 'NOT_FOUND'));
  if ('amount' in target && !positive(target.amount)) issues.push(failure('AMOUNT_POSITIVE_REQUIRED'));
  if (product && (!positive(product.soldPrice) || !positive(product.validDays) || product.validDays > 36600 || product.kind === 'count' && !positive(product.totalUses!))) issues.push(failure('INVALID_AMOUNT'));
  const totals = { card: 0, easy_pay: 0, cash: 0 }, other: SettlementAllocation[] = [];
  const supplied: readonly SettlementAllocation[] = Array.isArray(input.allocations) ? input.allocations : [];
  for (const a of supplied) {
    if (!a || !['method', 'charge', 'receivable', 'membership_count', 'membership_period'].includes(a.kind) || funding && a.kind !== 'method' || target.purpose === 'custom_order' && a.kind.startsWith('membership_')) { issues.push(failure('INVALID_SETTLEMENT_KIND')); continue; }
    if (!nonnegative(a.amount) || a.amount === 0 && a.kind !== 'membership_period') { issues.push(failure('AMOUNT_POSITIVE_REQUIRED')); continue; }
    if (a.kind === 'method') {
      if (!a.method || !methods.includes(a.method)) issues.push(failure('INVALID_SETTLEMENT_KIND'));
      else totals[a.method] += a.amount;
    } else {
      if (!memberId) issues.push(failure('MEMBER_REQUIRED'));
      other.push({ ...a, allocationId: undefined });
    }
  }
  if (!Array.isArray(input.allocations) || Object.values(totals).some(n => !nonnegative(n))) issues.push(failure('INVALID_AMOUNT'));
  const realMethodSplits = methods.filter(method => totals[method] > 0).map(method => ({ method, amount: totals[method] }));
  const allocations: readonly SettlementAllocation[] = [...realMethodSplits.map(s => ({ kind: 'method' as const, ...s })), ...other];
  const membershipEffects: MembershipUse[] = [], discounts: SettlementQuote['discounts'][number][] = [];
  const covered = new Map<string, number>();
  for (const a of other.filter(a => a.kind.startsWith('membership_'))) {
    if (!source || !a.membershipId || !a.billAllocationId) { issues.push(failure('PASS_MENU_REQUIRED')); continue; }
    const q = quoteMembershipUse(read, { membershipId: a.membershipId, source, allocationId: a.billAllocationId, quantity: a.quantity ?? 1, useId: a.useId });
    issues.push(...q.issues);
    const t = read.state.memberships.find(m => m.membershipId === a.membershipId);
    if (t && a.kind !== `membership_${t.kind}`) issues.push(failure('INVALID_SETTLEMENT_KIND'));
    if (a.amount !== q.recognizedAmount) issues.push(failure('QUOTE_CHANGED', 'CONFLICT'));
    covered.set(a.billAllocationId, (covered.get(a.billAllocationId) ?? 0) + (a.quantity ?? 1));
    if (covered.get(a.billAllocationId)! > (source.lines.find(l => l.allocationId === a.billAllocationId)?.quantity ?? 0)
      || membershipEffects.some(u => u.membershipId === a.membershipId)) issues.push(failure('PASS_ALREADY_USED'));
    const existing = read.state.uses.find(u => u.useId === q.useId && !u.canceledAt);
    membershipEffects.push({ useId: q.useId, membershipId: a.membershipId, at: existing?.at ?? read.now, sourceRef: existing?.sourceRef ?? source.sourceRef,
      coveredQuantities: [...(existing?.coveredQuantities ?? []), ...q.coveredQuantities],
      recognizedAmount: (existing?.recognizedAmount ?? 0) + q.recognizedAmount, membershipDiscount: (existing?.membershipDiscount ?? 0) + q.membershipDiscount, canceledAt: null });
    discounts.push({ source: 'membership', amount: q.membershipDiscount, useId: q.useId });
  }
  const prior = source ? read.state.settlements.filter(s => sameSource(s.sourceRef, source.sourceRef) && s.purpose === source.purpose && settlementActive(read, s)) : [];
  const received = prior.reduce((n, s) => n + settlementRemaining(read, s), 0);
  const priorDiscount = prior.flatMap(s => s.allocations).reduce((n, a) => n + (a.membershipDiscount ?? 0), 0);
  const currentDiscount = discounts.reduce((n, d) => n + d.amount, 0);
  const partId = target.purpose === 'sale' ? target.partId : undefined, part = source?.parts?.find(p => p.partId === partId);
  if (source?.parts?.length && !part || partId && !part || partId && prior.some(s => s.partId === partId && (s.amount === 0 || settlementRemaining(read, s) > 0))) issues.push(failure('PART_UNAVAILABLE'));
  if (part?.allocationIds && membershipEffects.some(u => u.coveredQuantities.some(q => !part.allocationIds!.includes(q.allocationId)))) issues.push(failure('PASS_MENU_REQUIRED'));
  const amountDue = funding ? 'amount' in target ? target.amount : product?.soldPrice ?? 0 : part ? part.amount - currentDiscount : (source?.amountDue ?? 0) - received - priorDiscount - currentDiscount;
  if (!nonnegative(amountDue)) issues.push(failure('ALLOCATION_SUM_MISMATCH'));
  if (source && !source.parts?.length && prior.some(s => settlementRemaining(read, s) > 0 || s.amount === 0 && !read.state.corrections.some(c => c.settlementId === s.settlementId))) issues.push(failure('QUOTE_CHANGED', 'CONFLICT'));
  const allocationTotal = allocations.reduce((n, a) => n + a.amount, 0);
  if (!nonnegative(allocationTotal) || allocationTotal !== amountDue) issues.push(failure('ALLOCATION_SUM_MISMATCH', 'VALIDATION', { remaining: amountDue - allocationTotal }));
  const charge = other.filter(a => a.kind === 'charge').reduce((n, a) => n + a.amount, 0);
  if (charge > accountBalance(read, memberId ?? '', 'charge')) issues.push(failure('CHARGE_BALANCE_EXCEEDED', 'VALIDATION', { available: accountBalance(read, memberId ?? '', 'charge') }));
  const collectionSources = target.purpose === 'receivable_collection' ? allocateAccountSources(read, target.memberId, 'receivable', target.amount, target.receivableTxnId) : [];
  if (target.purpose === 'receivable_collection' && collectionSources.reduce((n, s) => n + s.amount, 0) !== target.amount) issues.push(failure('RECEIVABLE_LIMIT', 'VALIDATION', { remaining: accountBalance(read, target.memberId, 'receivable') }));
  const sourceFingerprint = canonical({ source, member: read.members.find(m => m.memberId === memberId), product, accounts: read.state.accountTxns, uses: read.state.uses, memberships: read.state.memberships,
    corrections: read.state.corrections, prior, date: read.businessDate, runId: read.runId, generation: read.generation, scenario: read.scenario });
  const normalizedAllocations = allocations.map(a => {
    const use = membershipEffects.find(u => u.membershipId === a.membershipId);
    return a.kind.startsWith('membership_') ? { ...a, useId: use?.useId, membershipDiscount: discounts.find(d => d.useId === use?.useId)?.amount } : a;
  });
  const previewAllocations = normalizedAllocations.map((a, i) => ({ ...a, allocationId: `preview:a${i}` }));
  const preview: Settlement = { settlementId: 'preview', purpose: target.purpose, sourceRef: source?.sourceRef ?? { kind: target.purpose, id: memberId ?? '' }, billId: source?.billId ?? null, partId: partId ?? null,
    memberId: memberId ?? null, at: read.now, amount: amountDue, allocations: previewAllocations, status: 'paid', sourceSnapshot: source };
  const accountEffects = issues.length ? [] : settlementAccounts(read, preview, collectionSources);
  const isFinal = source && received + amountDue === source.amountDue - priorDiscount - currentDiscount;
  const allUses = [...read.state.uses.filter(u => !membershipEffects.some(n => n.useId === u.useId)), ...membershipEffects];
  const recognitionEffects = !issues.length && isFinal && source.purpose === 'sale' ? recognizeSource(read, source, [...prior, preview], allUses) : [];
  const base = { quoteRevision: read.revision, target, amountDue, allocations: normalizedAllocations, realMethodSplits, discounts, recognitionEffects, accountEffects, membershipEffects,
    remaining: amountDue - allocationTotal, canSubmit: issues.length === 0, issues, sourceFingerprint, collectionSources };
  return freezePos({ ...base, quoteId: canonical(base) });
}

function settlementAccounts(read: MoneyRead, settlement: Settlement, collectionSources: SettlementQuote['collectionSources']): MemberAccountTxn[] {
  const { settlementId: id, memberId, sourceRef } = settlement;
  const accountTxns: MemberAccountTxn[] = [];
  const txn = (account: MemberAccountTxn['account'], kind: MemberAccountTxn['kind'], amount: number, allocationId: string | null, sourceAmounts?: MemberAccountTxn['sourceAmounts']) => {
    accountTxns.push({ txnId: `${id}:txn${accountTxns.length}`, memberId: memberId!, account, kind, amount, allocationId, settlementId: id, at: read.now, originalTxnId: null, sourceRef, reason: '', ...(sourceAmounts ? { sourceAmounts } : {}) });
  };
  if (settlement.purpose === 'charge_topup') txn('charge', 'topup', settlement.amount, null);
  else if (settlement.purpose === 'receivable_collection') txn('receivable', 'collection', -settlement.amount, null, collectionSources);
  for (const a of settlement.allocations) {
    if (a.kind === 'charge') {
      const virtual = { ...read, state: { ...read.state, accountTxns: [...read.state.accountTxns, ...accountTxns] } };
      txn('charge', 'use', -a.amount, a.allocationId!, allocateAccountSources(virtual, memberId!, 'charge', a.amount));
    } else if (a.kind === 'receivable') txn('receivable', 'sale', a.amount, a.allocationId!);
  }
  return accountTxns;
}

export function planBeginSettlementApproval(read: MoneyRead, input: { readonly quote: SettlementQuote; readonly meta: PosCommandMeta }): MoneyPlan {
  const payload = { type: 'settlement', quoteId: input.quote.quoteId }, checked = guard(read, input.meta, payload); if (checked) return checked;
  const pending = read.state.attempt;
  if (pending) return pending.meta.idempotencyKey === input.meta.idempotencyKey && canonical(pending.quote) === canonical(input.quote)
    ? { ok: true, nextState: read.state, effects: emptyEffects(), value: {}, changed: false, duplicate: true, attemptId: pending.attemptId }
    : failure('APPROVAL_BUSY', 'CONFLICT');
  const current = quoteSettlement(read, { target: input.quote.target, allocations: input.quote.allocations });
  if (canonical(current) !== canonical(input.quote)) return failure('QUOTE_CHANGED', 'CONFLICT', { quote: current });
  if (!current.canSubmit) return current.issues[0];
  const attemptId = `settlement-attempt:${read.runId}:${input.meta.idempotencyKey}`;
  return freezePos({ ok: true, nextState: { ...read.state, attempt: { attemptId, runId: read.runId, generation: read.generation, scenario: read.scenario,
    meta: input.meta, quote: current, fingerprint: canonical(current) } }, effects: emptyEffects(), value: {}, changed: false, attemptId });
}

function recognizeSource(read: MoneyRead, source: MoneySource, settlements: readonly Settlement[], uses: readonly MembershipUse[]): readonly SalesRecognition[] {
  const sourceDiscount = (id: string) => settlements.flatMap(s => s.allocations).filter(a => a.billAllocationId === id).reduce((n, a) => n + (a.membershipDiscount ?? 0), 0);
  const rows: SalesRecognition[] = [], remaining = new Map(source.lines.map(l => [l.allocationId, l.unitPrice * l.quantity - Object.values(l.discountBySource ?? {}).reduce((n, d) => n + d, 0)
    - sourceDiscount(l.allocationId)]));
  const allocations = settlements.flatMap(s => s.allocations.map(a => ({ s, a }))).sort((x, y) => Number(!x.a.kind.startsWith('membership_')) - Number(!y.a.kind.startsWith('membership_')));
  for (const { s, a } of allocations) {
    const scope=source.parts?.find(p=>p.partId===s.partId)?.allocationIds;
    const amounts = a.billAllocationId ? { [a.billAllocationId]: a.amount } : allocatePosAmount(a.amount, [...remaining].filter(([id])=>!scope||scope.includes(id)).map(([id, amount]) => ({ id, amount })));
    for (const line of source.lines) {
      const amount = amounts[line.allocationId] ?? 0;
      if (!amount && !(a.kind === 'membership_period' && a.billAllocationId === line.allocationId)) continue;
      remaining.set(line.allocationId, remaining.get(line.allocationId)! - amount);
      const use = uses.find(u => u.useId === a.useId);
      rows.push({ recognitionId: `recognition:${s.settlementId}:${a.allocationId}:${line.allocationId}`, source: a.kind === 'membership_count' ? 'membership_count' : 'menu',
        sourceId: source.sourceRef.id, businessDate: read.businessDate, at: read.now, amount, cost: 0,
        settlementCategory: a.kind === 'method' ? a.method! : a.kind === 'membership_period' ? 'membership_count' : a.kind,
        settlementId: s.settlementId, settlementAllocationId: a.allocationId, membershipId: use?.membershipId, useId: use?.useId,
        billAllocationId: line.allocationId, orderLineId: line.orderLineId, menuId: line.menuId, originalRecognitionId: null });
    }
  }
  for (const line of source.lines) {
    let own=rows.filter(r=>r.billAllocationId===line.allocationId);
    if(!own.length){const first:SalesRecognition={recognitionId:`recognition:${source.sourceRef.id}:${line.allocationId}:zero`,source:'menu',sourceId:source.sourceRef.id,businessDate:read.businessDate,at:read.now,amount:0,cost:0,settlementCategory:'membership_count',billAllocationId:line.allocationId,orderLineId:line.orderLineId,menuId:line.menuId,originalRecognitionId:null};rows.push(first);own=[first];}
    const weights=own.map(r=>({id:r.recognitionId,amount:r.amount}));
    const weighted=weights.some(w=>w.amount)?weights:weights.map(w=>({...w,amount:1}));
    const quantities=distributePosAmount(line.quantity,weighted),grosses=distributePosAmount(line.unitPrice*line.quantity,weighted);
    const discounts={direct:0,coupon:0,membership:0,...line.discountBySource};discounts.membership+=sourceDiscount(line.allocationId);
    const shares={direct:distributePosAmount(discounts.direct,weighted),coupon:distributePosAmount(discounts.coupon,weighted),membership:distributePosAmount(discounts.membership,weighted)};
    for(const r of own){const id=r.recognitionId;rows[rows.indexOf(r)]={...r,quantity:quantities[id],gross:grosses[id],discountBySource:{direct:shares.direct[id],coupon:shares.coupon[id],membership:shares.membership[id]},cost:line.unitCost===null?null:line.unitCost*quantities[id]};}
  }
  return rows;
}

export function planFinishSettlementApproval(read: MoneyRead, input: { readonly attemptId: string; readonly runId: string; readonly outcome: 'approved' | 'failed'; readonly expectedQuoteFingerprint: string }): MoneyPlan {
  if (input.runId !== read.runId) return failure('STALE_RUN', 'CONFLICT');
  const attempt = read.state.attempt;
  if (!attempt) {
    const record = read.state.commands.find(c => c.attemptId === input.attemptId);
    if (record && record.attemptFingerprint === input.expectedQuoteFingerprint && record.generation === read.generation && record.scenario === read.scenario) return { ok: true, nextState: read.state, effects: emptyEffects(), value: record.value, changed: false, duplicate: true };
    return failure('STALE_ATTEMPT', 'CONFLICT');
  }
  if (attempt.attemptId !== input.attemptId || attempt.fingerprint !== input.expectedQuoteFingerprint || attempt.generation !== read.generation || attempt.scenario !== read.scenario) return failure('STALE_ATTEMPT', 'CONFLICT');
  const blocked = available(read); if (blocked) return blocked;
  if (!['approved', 'failed'].includes(input.outcome)) return failure('INVALID_OUTCOME');
  const q = quoteSettlement(read, { target: attempt.quote.target, allocations: attempt.quote.allocations });
  if (canonical(q) !== canonical(attempt.quote)) return failure('QUOTE_CHANGED', 'CONFLICT', { quote: q });
  if (!q.canSubmit) return q.issues[0];
  if (input.outcome === 'failed' || read.scenario === 'payment-failure') return failure('APPROVAL_FAILED', 'PREVIEW_FAILURE');
  if (!validDate(read.businessDate) || read.now.slice(0, 10) !== read.businessDate) return failure('BUSINESS_DATE_MISMATCH');
  const id = `settlement:${read.runId}:${attempt.meta.idempotencyKey}`, target = q.target, source = findMoneySource(read, target);
  const memberId = 'memberId' in target ? target.memberId : source?.memberId ?? null;
  const sourceRef = source?.sourceRef ?? { kind: target.purpose, id: memberId! };
  const allocations = q.allocations.map((a, i) => ({ ...a, allocationId: `${id}:a${i}`, ...(a.kind.startsWith('membership_') ? { useId: q.membershipEffects.find(u => u.membershipId === a.membershipId && u.coveredQuantities.some(q => q.allocationId === a.billAllocationId))?.useId } : {}) }));
  const settlement: Settlement = { settlementId: id, purpose: target.purpose, sourceRef, billId: source?.billId ?? null, partId: target.purpose === 'sale' ? target.partId ?? null : null,
    memberId, at: read.now, amount: q.amountDue, allocations, status: 'paid', ...(source ? { sourceSnapshot: source } : {}) };
  const accountTxns = settlementAccounts(read, settlement, q.collectionSources);
  const realAmount = q.realMethodSplits.reduce((n, a) => n + a.amount, 0), paymentId = realAmount ? `payment:${id}` : undefined;
  const effects: MoneyEffects = { ...emptyEffects(), settlements: [settlement], accountTxns, uses: q.membershipEffects,
    payments: paymentId ? [{ paymentId, settlementId: id, purpose: target.purpose, sourceRef, at: read.now, amount: realAmount, splits: q.realMethodSplits }] : [] };
  let remaining = 0, settled = true, membershipId: string | undefined, finalEffects = effects;
  if (target.purpose === 'membership_sale') {
    const product = read.products.find(p => p.productId === target.productId)!;
    membershipId = `membership:${id}`;
    finalEffects = { ...effects, memberships: [{ ...product, memberId: memberId!, membershipId, startsOn: read.businessDate, endsOn: addDate(read.businessDate, product.validDays - 1), saleSettlementId: id }] };
  } else if (source) {
    const all = [...read.state.settlements.filter(s => sameSource(s.sourceRef, source.sourceRef) && s.purpose === source.purpose && (settlementRemaining(read, s) > 0 || s.amount === 0 && !read.state.corrections.some(c => c.settlementId === s.settlementId))), settlement];
    const uses = [...read.state.uses.filter(u => !effects.uses.some(n => n.useId === u.useId) && !u.canceledAt), ...effects.uses];
    remaining = source.amountDue - all.flatMap(s => s.allocations).reduce((n, a) => n + (a.membershipDiscount ?? 0), 0) - all.reduce((n, s) => n + settlementRemaining(read, s), 0);
    settled = remaining === 0;
    if (settled && source.purpose === 'sale') finalEffects = { ...effects, recognitions: recognizeSource(read, source, all, uses), lineEffects: source.lines.map(l => ({ allocationId: l.allocationId, orderLineId: l.orderLineId, menuId: l.menuId,
      quantity: l.quantity, stock: (l.recipe ?? []).map(r => ({ itemId: r.itemId, deltaBase: -r.quantityBase * l.quantity })) })) };
  }
  const result = publish(read, finalEffects, { settlementId: id, ...(paymentId ? { paymentId } : {}), purpose: target.purpose, sourceRef,
    ...(source?.billId ? { billId: source.billId } : {}), orderIds: settled ? source?.orderIds ?? [] : [], remaining, settled,
    accountEffects: accountTxns, ...(membershipId ? { membershipId } : {}) }, attempt.meta, { type: 'settlement', quoteId: attempt.quote.quoteId });
  return result.ok ? freezePos({ ...result, nextState: { ...result.nextState, commands: result.nextState.commands.map(c => c === result.nextState.commands.at(-1) ? { ...c, attemptId: attempt.attemptId, attemptFingerprint: attempt.fingerprint } : c) } }) : result;
}

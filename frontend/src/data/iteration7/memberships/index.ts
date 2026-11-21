import { seedOperations } from '../../db/generated/operations';
import type { PosCommandMeta, PosFailure, PosMethodSplit } from '../../../contracts/pos';
import { allocatePosAmount } from '../../../pos/domain/money';
import type { MembershipTerms, MembershipUse, MoneyPlan, MoneyRead, MoneySource } from '../accounting/types';
import { addDate, available, canonical, emptyEffects, failure, guard, positive, publish, validDate } from '../accounting/shared';
export type { MembershipProduct, MembershipTerms, MembershipUse } from '../accounting/types';
export const legacyMembershipProducts = [
  { productId: 'mp-americano10', name: '아메리카노 10잔권', kind: 'count', soldPrice: 40000, totalUses: 10, validDays: 90, menuIds: ['m-americano'] },
  { productId: 'mp-morning20', name: '오전 음료 이용권', kind: 'count', soldPrice: 60000, totalUses: 20, validDays: 30, beforeHour: 12 },
  { productId: 'mp-monthly', name: '월 구독', kind: 'period', soldPrice: 55000, totalUses: null, validDays: 30, dailyLimit: 1 },
] as const;
export const membershipProducts: readonly import('../accounting/types').MembershipProduct[] = seedOperations.membershipProducts.map(row => ({
  productId: row.productId, name: row.name, kind: 'count', soldPrice: row.price, totalUses: row.uses, validDays: row.validDays,
  menuIds: [row.menuId], dailyLimit: row.dailyLimit,
}));
export function membershipValues(read: MoneyRead, terms: MembershipTerms) {
  const recognizedValue = read.state.recognitions.filter(r => r.membershipId === terms.membershipId).reduce((n, r) => n + r.amount, 0);
  const refundedValue = read.state.corrections.filter(c => c.settlementId === terms.saleSettlementId).reduce((n, c) => n + c.amount, 0);
  const uses = read.state.uses.filter(u => u.membershipId === terms.membershipId && !u.canceledAt);
  return { recognizedValue, refundedValue, unrecognizedValue: Math.max(0, terms.soldPrice - recognizedValue - refundedValue),
    usesRemaining: terms.totalUses === null ? null : terms.totalUses - (terms.openingUses ?? 0) - uses.length,
    status: terms.refundedAt ? 'refunded' as const : terms.endsOn < read.businessDate ? 'expired' as const : 'active' as const };
}
export function selectMemberships(read: MoneyRead, query: { readonly memberId?: string } = {}) {
  const memberships = read.state.memberships.filter(m => !query.memberId || m.memberId === query.memberId).map(m => ({ ...m, ...membershipValues(read, m), uses: read.state.uses.filter(u => u.membershipId === m.membershipId) }));
  return { products: read.products, memberships, activeCount: memberships.filter(m => m.status === 'active' && (m.usesRemaining === null || m.usesRemaining > 0)).length };
}
export interface MembershipUseQuote {
  readonly useId: string; readonly coveredAllocationIds: readonly string[]; readonly coveredQuantities: MembershipUse['coveredQuantities'];
  readonly recognizedAmount: number; readonly membershipDiscount: number; readonly usesRemainingAfter: number | null;
  readonly unrecognizedValueAfter: number; readonly canSubmit: boolean; readonly issues: readonly PosFailure[];
}
export function quoteMembershipUse(read: MoneyRead, input: { readonly membershipId: string; readonly source: MoneySource; readonly allocationId: string; readonly quantity: number; readonly useId?: string }): MembershipUseQuote {
  const t = read.state.memberships.find(m => m.membershipId === input.membershipId), line = input.source.lines.find(l => l.allocationId === input.allocationId);
  const issues: PosFailure[] = [], values = t ? membershipValues(read, t) : null;
  const useId = input.useId ?? `use:${input.source.sourceRef.kind}:${input.source.sourceRef.id}:${input.membershipId}:${input.allocationId}`;
  const frozen = input.source.membershipContributions?.find(c => c.useId === useId && c.membershipId === input.membershipId && c.allocationId === input.allocationId && c.quantity === input.quantity);
  const existing = read.state.uses.find(u => u.useId === useId && !u.canceledAt);
  if (!t || !line) issues.push(failure('NOT_FOUND', 'NOT_FOUND'));
  else if (input.source.purpose !== 'sale' || t.memberId !== input.source.memberId) issues.push(failure('PASS_MEMBER_MISMATCH'));
  else if (t.refundedAt || t.startsOn > read.businessDate || t.endsOn < read.businessDate || !existing && values!.usesRemaining !== null && values!.usesRemaining! < 1) issues.push(failure('PASS_INACTIVE'));
  else if (input.quantity !== 1 || input.quantity > line.quantity) issues.push(failure('QTY_LIMIT'));
  else if (t.menuIds?.length ? !t.menuIds.includes(line.menuId) : line.category !== 'drink' && !['m-americano', 'm-latte', 'm-vanilla'].includes(line.menuId)) issues.push(failure('PASS_MENU_REQUIRED'));
  else if (t.beforeHour !== undefined && Number(read.now.slice(11, 13)) >= t.beforeHour) issues.push(failure('PASS_MORNING_ONLY'));
  else if (existing && (!frozen || existing.coveredQuantities.some(c => c.allocationId === input.allocationId))) issues.push(failure('PASS_ALREADY_USED'));
  else if (!existing && t.dailyLimit && read.state.uses.filter(u => u.membershipId === t.membershipId && !u.canceledAt && u.at.slice(0, 10) === read.businessDate).length >= t.dailyLimit) issues.push(failure('PASS_DAILY_LIMIT'));
  const division = t?.totalUses ? Math.floor(t.soldPrice / t.totalUses) : 0;
  const beforeUses = (values?.usesRemaining ?? 0) + (existing ? 1 : 0);
  const share = t?.totalUses && beforeUses === 1 ? division + t.soldPrice % t.totalUses : division;
  const committed = read.state.settlements.flatMap(s => s.allocations).filter(a => a.useId === useId).reduce((n, a) => n + a.amount, 0);
  if (frozen && (!Number.isSafeInteger(frozen.recognizedAmount) || frozen.recognizedAmount < 0 || !Number.isSafeInteger(frozen.membershipDiscount) || frozen.membershipDiscount < 0
    || frozen.recognizedAmount + frozen.membershipDiscount > (line?.unitPrice ?? 0) * input.quantity || frozen.recognizedAmount + committed > share)) issues.push(failure('QUOTE_CHANGED', 'CONFLICT'));
  const recognizedAmount = !issues.length && t?.kind === 'count' ? frozen ? frozen.recognizedAmount : Math.min(share, line!.unitPrice * input.quantity, values!.unrecognizedValue) : 0;
  return { useId, coveredAllocationIds: [input.allocationId], coveredQuantities: [{ allocationId: input.allocationId, quantity: input.quantity }],
    recognizedAmount, membershipDiscount: frozen?.membershipDiscount ?? (line ? line.unitPrice * input.quantity - recognizedAmount : 0),
    usesRemainingAfter: values?.usesRemaining === null ? null : Math.max(0, (values?.usesRemaining ?? 0) - (existing ? 0 : 1)),
    unrecognizedValueAfter: (values?.unrecognizedValue ?? 0) - recognizedAmount, canSubmit: !issues.length, issues };
}
/** Called by the coordinator before finalized reads; selectors never materialize service. */
export function planMembershipServiceDay(read: MoneyRead, input: { readonly date: string }): MoneyPlan {
  const blocked = available(read); if (blocked) return blocked;
  if (!validDate(input.date) || input.date > read.businessDate) return failure('INVALID_DATE');
  const effects = emptyEffects(), recognitions = [...effects.recognitions];
  for (const t of read.state.memberships) {
    if (t.refundedAt || t.startsOn > input.date) continue;
    const values = membershipValues(read, t);
    if (t.kind === 'period') {
      for (let day = 0; day < t.validDays; day++) {
        const date = addDate(t.startsOn, day); if (date > input.date || date > t.endsOn) break;
        const recognitionId = `service:${t.membershipId}:${date}`;
        if (read.state.recognitions.some(r => r.recognitionId === recognitionId)) continue;
        const amount = Math.floor(t.soldPrice / t.validDays) + (day === t.validDays - 1 ? t.soldPrice % t.validDays : 0);
        recognitions.push({ recognitionId, source: 'subscription_day', sourceId: `${t.membershipId}:${date}`, membershipId: t.membershipId, businessDate: date,
          at: `${date}T00:00`, amount, cost: 0, settlementCategory: 'subscription_day', originalRecognitionId: null });
      }
    } else if (t.endsOn <= input.date && values.unrecognizedValue > 0 && !read.state.recognitions.some(r => r.recognitionId === `expiry:${t.membershipId}`)) {
      recognitions.push({ recognitionId: `expiry:${t.membershipId}`, source: 'membership_expiry', sourceId: t.membershipId, membershipId: t.membershipId,
        businessDate: t.endsOn, at: `${t.endsOn}T23:59`, amount: values.unrecognizedValue, cost: 0, settlementCategory: 'membership_expiry', originalRecognitionId: null });
    }
  }
  return publish(read, { ...effects, recognitions }, {});
}
export interface MembershipRefundQuote { readonly quoteId: string; readonly quoteRevision: number; readonly membershipId: string; readonly settlementId: string; readonly amount: number; readonly realMethodReturns: readonly PosMethodSplit[]; readonly canSubmit: boolean; readonly issues: readonly PosFailure[] }
export function quoteMembershipRefund(read: MoneyRead, input: { readonly membershipId: string }): MembershipRefundQuote {
  const t = read.state.memberships.find(m => m.membershipId === input.membershipId), issues: PosFailure[] = [];
  const blocked = available(read); if (blocked) issues.push(blocked);
  const settlement = read.state.settlements.find(s => s.settlementId === t?.saleSettlementId);
  const amount = t ? membershipValues(read, t).unrecognizedValue : 0;
  if (!t || !settlement) issues.push(failure('NOT_FOUND', 'NOT_FOUND'));
  else if (!positive(amount) || t.refundedAt) issues.push(failure('REFUND_LIMIT'));
  const availableMethods = (['card', 'easy_pay', 'cash'] as const).map(method => ({ method, amount: (settlement?.allocations.filter(a => a.kind === 'method' && a.method === method).reduce((n, a) => n + a.amount, 0) ?? 0) - read.state.corrections.filter(c => c.settlementId === settlement?.settlementId).reduce((n, c) => n + c.realMethodReturns.filter(m => m.method === method).reduce((v, m) => v + m.amount, 0), 0) }));
  const weights = availableMethods.map(a => ({ id: a.method, amount: a.amount }));
  const total = weights.reduce((n, a) => n + a.amount, 0);
  if (amount > total) issues.push(failure('REFUND_LIMIT'));
  const allocated = issues.length ? {} : allocatePosAmount(amount, weights);
  const realMethodReturns = availableMethods.filter(a => allocated[a.method] > 0).map(a => ({ method: a.method, amount: allocated[a.method] }));
  const body = { quoteRevision: read.revision, membershipId: input.membershipId, settlementId: t?.saleSettlementId ?? '', amount, realMethodReturns, canSubmit: !issues.length, issues };
  return { ...body, quoteId: canonical({ ...body, runId: read.runId, generation: read.generation }) };
}
export function planMembershipRefund(read: MoneyRead, input: { readonly quote: MembershipRefundQuote; readonly meta: PosCommandMeta }): MoneyPlan {
  const payload = { type: 'membership.refund', quoteId: input.quote.quoteId }, checked = guard(read, input.meta, payload); if (checked) return checked;
  if (read.state.attempt) return failure('APPROVAL_BUSY', 'CONFLICT');
  const current = quoteMembershipRefund(read, { membershipId: input.quote.membershipId });
  if (canonical(current) !== canonical(input.quote)) return failure('QUOTE_CHANGED', 'CONFLICT');
  if (!current.canSubmit) return current.issues[0];
  if (read.scenario === 'payment-failure') return failure('REVERSAL_FAILED', 'PREVIEW_FAILURE');
  const t = read.state.memberships.find(m => m.membershipId === current.membershipId)!;
  const correctionId = `membership-refund:${read.runId}:${input.meta.idempotencyKey}`;
  const correction = { correctionId, settlementId: current.settlementId, at: read.now, kind: 'refund' as const, amount: current.amount,
    originalAllocationEffects: [], realMethodReturns: current.realMethodReturns, accountEffects: [], membershipEffects: [], recognitionEffects: [], lineEffects: [] };
  return publish(read, { ...emptyEffects(), memberships: [{ ...t, refundedAt: read.now }], corrections: [correction] }, { correctionId, membershipId: t.membershipId, settlementId: current.settlementId }, input.meta, payload);
}

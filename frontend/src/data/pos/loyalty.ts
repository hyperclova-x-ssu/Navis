import type { PosLoyaltyRead, PosState } from '../../contracts/pos';
import type { DataSnapshot, DataTables } from '../db/types';
import { selectMembers } from '../derive/members';
import { moneyReadBase } from './projection';
import { selectMemberships } from '../iteration7/memberships';
import { createPosSeed } from '../../pos/seed';
import { NOW_TIME, TODAY } from '../db/time';
import { deepFreeze } from '../db/freeze';

export function selectPosLoyaltyRead(snapshot: DataSnapshot): PosLoyaltyRead {
  const t = snapshot.tables, m = t.marketing, date = snapshot.pos?.businessDate ?? TODAY;
  return deepFreeze({
    members: selectMembers(snapshot, {}).rows.map(r => ({ memberId: r.memberId, memberCode: r.memberCode, customerId: r.customerId, name: r.name, phone: r.phone, grade: r.grade, recentVisits: r.recentVisits })),
    passes: snapshot.pos?.money ? selectMemberships(moneyReadBase(snapshot)).memberships.map(p=>({membershipId:p.membershipId,memberId:p.memberId,nameKey:t.membershipProduct.find(x=>x.productId===p.productId)?.nameKey??'',kind:p.productId==='p-americano10'?'americano' as const:p.productId==='p-morning20'?'morning' as const:p.productId==='p-monthly'?'monthly' as const:'unsupported' as const,startsOn:p.startsOn,endsOn:p.endsOn,active:p.status==='active',usesLeft:p.usesRemaining,dailyLimit:p.dailyLimit??null,usedToday:p.uses.filter(u=>!u.canceledAt&&u.at.startsWith(date)).length})) : t.membership.map(p => {
      const product = t.membershipProduct.find(x => x.productId === p.productId);
      const kind = p.productId === 'p-americano10' ? 'americano' as const : p.productId === 'p-morning20' ? 'morning' as const : p.productId === 'p-monthly' ? 'monthly' as const : 'unsupported' as const;
      return { membershipId: p.membershipId, memberId: t.memberProfile.find(x => x.customerId === p.customerId)?.memberId, nameKey: product?.nameKey ?? '', kind,
        startsOn: p.startsOn, endsOn: p.endsOn, active: p.status === 'active', usesLeft: p.usesLeft, dailyLimit: product?.dailyLimit ?? null,
        usedToday: t.membershipUse.filter(u => u.membershipId === p.membershipId && !u.canceledAt && u.usedAt.startsWith(date)).length };
    }),
    coupons: m.coupon.map(c => ({ ...c, codes: m.couponCode.filter(code => code.couponId === c.couponId).map(code => ({ codeId: code.codeId, active: code.activatedAt !== null,
      used: m.couponRedemptionAgg.find(a => a.codeId === code.codeId)?.used ?? 0, issueCount: code.issueCount,
      ...(code.issuedTerms ? { issuedTerms: code.issuedTerms } : {}), ...(code.unpublishedAt ? { unpublished: true } : {}), // D-326.
      customerIds: m.couponTarget.filter(target => target.codeId === code.codeId).map(target => target.customerId) })) })),
  });
}

const seed = createPosSeed();
/** Contributions are per bill, never per split payment. Seed contributions already exist in baseline. */
export function posLoyaltyContributions(pos: PosState) {
  return pos.bills.filter(b => {
    if (b.status !== 'paid' || !b.recognizedAt) return false;
    const settlements = pos.money?.settlements.filter(s => s.purpose === 'sale' && s.billId === b.billId);
    if (settlements?.length) return settlements.some(s => {
      const cancels = pos.money!.corrections.filter(c => c.settlementId === s.settlementId && c.kind === 'cancel');
      return s.amount === 0 ? !cancels.length : cancels.reduce((n, c) => n + c.amount, 0) < s.amount;
    });
    return !pos.payments.some(p => p.billId === b.billId) || pos.payments.some(p => p.billId === b.billId && p.status === 'paid');
  }).map(b => {
    const cost = b.settlementLines.some(l => l.unitCostAtSale === null || l.optionCostAtSale === null) ? null
      : b.settlementLines.reduce((n, l) => n + l.recognizedQty * ((l.unitCostAtSale ?? 0) + (l.optionCostAtSale ?? 0)), 0);
    const gross = b.settlementLines.reduce((n, l) => n + l.recognizedQty * (l.basePriceAtSale + l.optionPriceAtSale), 0);
    return { bill: b, cost, revenue: gross - b.discounts.reduce((n, d) => n + d.amount, 0) };
  });
}
/** One use per original discount ID, and one contribution per original allocation/code. */
function couponTotals(rows: ReturnType<typeof posLoyaltyContributions>) {
  const out = new Map<string, { used: number; discount: number; revenue: number; cost: number | null }>();
  const uses = new Map<string, Set<string>>();
  for (const row of rows) {
    const codes = new Set(row.bill.discounts.filter(d => d.source === 'coupon' && d.codeId).map(d => d.codeId!));
    for (const codeId of codes) {
      const discounts = row.bill.discounts.filter(d => d.source === 'coupon' && d.codeId === codeId);
      const ids = uses.get(codeId) ?? new Set<string>();
      for (const d of discounts) ids.add(d.discountId);
      uses.set(codeId, ids);
      const allocations = new Set(discounts.flatMap(d => d.contributionAllocationIds ?? row.bill.settlementLines.map(l => l.allocationId)));
      const lines = row.bill.settlementLines.filter(l => allocations.has(l.allocationId));
      const own = out.get(codeId) ?? { used: 0, revenue: 0, discount: 0, cost: 0 };
      own.used = ids.size;
      own.discount += discounts.reduce((n, d) => n + d.amount, 0);
      own.revenue += lines.reduce((n, l) => n + l.recognizedQty * (l.basePriceAtSale + l.optionPriceAtSale) - l.discountAllocations.reduce((n, d) => n + d.amount, 0), 0);
      const cost = lines.some(l => l.unitCostAtSale === null || l.optionCostAtSale === null) ? null : lines.reduce((n, l) => n + l.recognizedQty * ((l.unitCostAtSale ?? 0) + (l.optionCostAtSale ?? 0)), 0);
      own.cost = own.cost === null || cost === null ? null : own.cost + cost;
      out.set(codeId, own);
    }
  }
  return out;
}
/** The old source has no per-code revenue/cost baseline. Expose exact POS deltas explicitly. */
function couponPerformance(snapshot: DataSnapshot) {
  const initial = couponTotals(posLoyaltyContributions(seed)), current = couponTotals(posLoyaltyContributions(snapshot.pos ?? seed));
  return deepFreeze(snapshot.tables.marketing.couponCode.map(c => {
    const a = current.get(c.codeId), b = initial.get(c.codeId);
    return { codeId: c.codeId, couponId: c.couponId, usedDelta: (a?.used ?? 0) - (b?.used ?? 0), revenueDelta: (a?.revenue ?? 0) - (b?.revenue ?? 0),
      costDelta: a?.cost === null || b?.cost === null ? null : (a?.cost ?? 0) - (b?.cost ?? 0), discountDelta: (a?.discount ?? 0) - (b?.discount ?? 0) };
  }));
}
const couponReads = new WeakMap<DataSnapshot, ReturnType<typeof couponPerformance>>();
export function selectPosCouponPerformance(snapshot: DataSnapshot) {
  const hit = couponReads.get(snapshot); if (hit) return hit;
  const result = couponPerformance(snapshot); couponReads.set(snapshot, result); return result;
}
export function projectPosLoyalty(t: DataTables, pos: PosState, previousPos: PosState = seed): DataTables {
  if (pos === previousPos) return t;
  const previous = posLoyaltyContributions(previousPos), current = posLoyaltyContributions(pos);
  const before = couponTotals(previous), after = couponTotals(current), codeIds = new Set([...before.keys(), ...after.keys()]);
  let revenueDelta = 0, costDelta = 0, discountDelta = 0;
  const aggs = [...t.marketing.couponRedemptionAgg];
  for (const codeId of codeIds) {
    const a = after.get(codeId), b = before.get(codeId), used = (a?.used ?? 0) - (b?.used ?? 0), discount = (a?.discount ?? 0) - (b?.discount ?? 0);
    revenueDelta += (a?.revenue ?? 0) - (b?.revenue ?? 0); costDelta += (a?.cost ?? 0) - (b?.cost ?? 0); discountDelta += discount;
    const index = aggs.findIndex(a => a.codeId === codeId), row = aggs[index] ?? { codeId, used: 0, discountSum: 0 };
    const next = { ...row, used: row.used + used, discountSum: row.discountSum + discount };
    if (index < 0) aggs.push(next); else aggs[index] = next;
  }
  const passes = (rows: typeof current) => {
    const out = new Map<string, { membershipId: string; at: string }>();
    for (const r of rows) for (const d of r.bill.discounts) if (d.source === 'membership' && d.useId && d.membershipId) {
      const old = out.get(d.useId), at = r.bill.recognizedAt!;
      out.set(d.useId, { membershipId: d.membershipId, at: old && old.at < at ? old.at : at });
    }
    return out;
  };
  const beforePass = passes(previous), afterPass = passes(current), passDeltas = new Map<string, number>();
  let uses = t.membershipUse;
  for (const useId of new Set([...beforePass.keys(), ...afterPass.keys()])) {
    const a = afterPass.get(useId), b = beforePass.get(useId); if (!!a === !!b) continue;
    const membershipId = (a ?? b)!.membershipId;
    passDeltas.set(membershipId, (passDeltas.get(membershipId) ?? 0) + (a ? -1 : 1));
    const index = uses.findIndex(u => u.useId === useId);
    const row = { useId, membershipId, usedAt: (a ?? b)!.at, canceledAt: a ? null : pos.businessDate + 'T' + NOW_TIME };
    uses = index < 0 ? [...uses, row] : uses.map((use, i) => i === index ? row : use);
  }
  // Rebuild only POS-created visits; all original visit evidence survives reversals.
  const visits = t.marketing.mktVisit.filter(v => !v.posContribution);
  for (const row of current.filter(r=>!pos.money?.settlements.some(s=>s.billId===r.bill.billId&&s.settlementId.startsWith('seed:')))) for (const memberId of new Set([row.bill.memberId, ...row.bill.discounts.map(d => d.contributionMemberId)].filter((id): id is string => !!id))) {
    const customerId = t.memberProfile.find(m => m.memberId === memberId)?.customerId;
    if (customerId && !visits.some(v => v.customerId === customerId && v.businessDate === pos.businessDate)) visits.push({ customerId, businessDate: pos.businessDate, hour: Number(row.bill.recognizedAt!.slice(11, 13)), posContribution: true });
  }
  return { ...t, membershipUse: uses, membership: t.membership.map(p => passDeltas.has(p.membershipId) && p.usesLeft !== null ? { ...p, usesLeft: p.usesLeft + passDeltas.get(p.membershipId)! } : p),
    marketing: { ...t.marketing, mktVisit: visits, couponRedemptionAgg: aggs,
      perfFixed: t.marketing.perfFixed.map(p => p.period === 'this-month' ? { ...p, revenueCoupon: p.revenueCoupon + revenueDelta, cost: p.cost + costDelta, discount: p.discount + discountDelta } : p) } };
}

/** Legacy membership tables are read-only adapters of the same canonical terms and uses. */
export function projectMoneyMembers(t:DataTables,pos:PosState):DataTables {
  if(!pos.money)return t;
  const read={...moneyReadBase({revision:0,seq:0,tables:t,pos}),state:pos.money};
  const passes=selectMemberships(read).memberships;
  const ids=new Set(passes.map(p=>p.membershipId));
  const memberships=[...t.membership.filter(m=>!ids.has(m.membershipId)&&m.status!=='active'),...passes.map(p=>({...t.membership.find(m=>m.membershipId===p.membershipId),membershipId:p.membershipId,customerKey:t.membership.find(m=>m.membershipId===p.membershipId)?.customerKey??'data.management.exampleMember',productId:p.productId,customerId:t.memberProfile.find(m=>m.memberId===p.memberId)?.customerId??'',startsOn:p.startsOn,endsOn:p.endsOn,status:p.status==='active'?'active' as const:'ended' as const,usesLeft:p.usesRemaining}))];
  const proposed=[...t.membershipUse.filter(u=>!ids.has(u.membershipId)),...pos.money.uses.map(u=>({useId:u.useId,membershipId:u.membershipId,usedAt:u.at,canceledAt:u.canceledAt}))];
  const same=proposed.length===t.membershipUse.length&&proposed.every((u,i)=>JSON.stringify(u)===JSON.stringify(t.membershipUse[i]));
  return {...t,membership:memberships,membershipUse:same?t.membershipUse:proposed};
}

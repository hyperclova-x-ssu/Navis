import type { PosMethodSplit } from '../../../contracts/pos';
import type { MemberGrade } from '../../db/management-types';
import type { DataTables } from '../../db/types';
import { addDays, weekdayOf } from '../../db/time';
import type { MemberAccountTxn, MembershipProduct, MembershipTerms, MembershipUse, MoneyRead } from '../../iteration7/accounting/types';
import type { selectMoneyReceipt } from '../../iteration7/accounting/selectors';
import type { MemberFundingTarget, TerminalRecord } from './commands';
import { memberDisplayId } from '../../customer-display';

export interface MemberDto {
  readonly memberId: string;
  readonly memberCode?: string;
  readonly customerId: string;
  readonly name: string;
  readonly phoneMasked: string;
  readonly joinedOn: string;
  readonly grade: MemberGrade;
  readonly gradeOverride: MemberGrade | null;
  readonly consent: { readonly contactAllowed: boolean; readonly marketingAllowed: boolean };
  readonly notes: readonly { readonly noteId: string; readonly body: string; readonly revision: number; readonly updatedAt: string }[];
  readonly visitCount: number;
  readonly recentVisitCount: number;
  readonly lastVisitAt: string | null;
  readonly lastPayment?: { readonly at: string; readonly amount: number } | null;
  readonly revision: number;
}

export interface MemberProductDto extends MembershipProduct { readonly revision: number }
export interface MemberPassDto {
  readonly membershipId: string;
  readonly memberId: string;
  readonly productId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly usesLeft: number | null;
  readonly status: 'active' | 'ended' | 'refunded';
  readonly terms: MemberProductDto;
  readonly saleSettlementId: string;
  readonly recognizedAmount?: number;
  readonly unrecognizedAmount?: number;
  readonly refundedAmount?: number;
  readonly revision: number;
}

export interface MemberUseDto {
  readonly useId: string;
  readonly membershipId: string;
  readonly usedAt: string;
  readonly canceledAt: string | null;
  readonly settlementId: string | null;
  readonly billId: string | null;
  readonly orderId: string | null;
}

export interface MemberAccountDto {
  readonly memberId: string;
  readonly chargeBalance: number;
  readonly receivableBalance: number;
  readonly revision: number;
  readonly hasEntries?: boolean;
}

export interface MemberFundingDto {
  readonly settlementId: string;
  readonly paymentId: string;
  readonly memberId: string;
  readonly purpose: MemberFundingTarget['purpose'];
  readonly amount: number;
  readonly at: string;
  readonly splits: readonly PosMethodSplit[];
  readonly terminal: TerminalRecord | null;
  readonly remainingRefundable: number;
  readonly remainingMethods: readonly PosMethodSplit[];
  readonly refunds: readonly { readonly correctionId: string; readonly amount: number; readonly at: string }[];
  readonly revision: number;
}

/** Project POS funding and its corrections into the same receipt shape the order screen uses. */
export function memberFundingReceipt(row: MemberFundingDto): NonNullable<ReturnType<typeof selectMoneyReceipt>> {
  const { settlementId, memberId, purpose, amount, splits, remainingRefundable } = row;
  const sourceRef = { kind: 'member_funding', id: settlementId };
  const at = memberDateTime(row.at);
  const allocations = splits.flatMap(split => split.method === 'card' || split.method === 'cash' || split.method === 'easy_pay'
    ? [{ kind: 'method' as const, amount: split.amount, method: split.method }] : []);
  return { settlementId, memberId, purpose, amount, at, sourceRef, status: 'paid', billId: null, partId: null,
    allocations, remainingRefundable, paymentId: row.paymentId,
    payment: { paymentId: row.paymentId, settlementId, purpose, sourceRef, at, amount: splits.reduce((sum, split) => sum + split.amount, 0), splits },
    currentPrepared: false, wholeBillDiscount: false, reversalLines: [], accountEffects: [], membershipEffects: [], recognitionEffects: [],
    corrections: row.refunds.map(refund => ({ ...refund, at: memberDateTime(refund.at), kind: 'refund', settlementId,
      originalAllocationEffects: [], realMethodReturns: [], accountEffects: [], membershipEffects: [], recognitionEffects: [], lineEffects: [] })),
  };
}

export interface RealMembersSnapshot {
  readonly profiles: Readonly<Record<string, MemberDto>>;
  readonly products: readonly MemberProductDto[];
  readonly passes: readonly MemberPassDto[];
  readonly uses: readonly MemberUseDto[];
  readonly accounts: Readonly<Record<string, MemberAccountDto>>;
  readonly entries: readonly MemberAccountTxn[];
  readonly businessDates: Readonly<Record<string, string>>;
  readonly businessDate: string;
}

const seoulDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const seoulDateTime = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const memberDate = (at: string) => seoulDate.format(new Date(at));
export const memberDateTime = (at: string) => seoulDateTime.format(new Date(at));
export const memberWeek = (date: string) => ({ start: addDays(date, 1 - weekdayOf(date)), end: addDays(date, 7 - weekdayOf(date)) });
export const memberSource = (use: MemberUseDto) => use.billId ? { kind: 'bill', id: use.billId }
  : use.orderId ? { kind: 'order', id: use.orderId } : { kind: 'membership_use', id: use.useId };

export function projectMemberTables(realMembers: RealMembersSnapshot, marketing: DataTables['marketing']): Partial<DataTables> {
  const members = Object.values(realMembers.profiles);
  const customerIds = new Map(members.map(m => [m.memberId, m.customerId]));
  return {
    realMembers,
    memberProfile: members.map(m => ({ memberId: m.memberId, dbMemberId: m.memberId, customerId: m.customerId,
      memberCode: memberDisplayId(m.memberId, m.memberCode, m.name) || undefined, joinedOn: m.joinedOn, gradeOverride: m.gradeOverride })),
    memberNote: members.flatMap(m => m.notes.map(n => ({ memberId: m.memberId, noteId: n.noteId, body: { raw: n.body }, updatedAt: n.updatedAt }))),
    membershipProduct: realMembers.products.map(p => ({ productId: p.productId, nameKey: p.name, kind: p.kind, uses: p.totalUses,
      validDays: p.validDays, dailyLimit: p.dailyLimit ?? null, price: p.soldPrice })),
    membership: realMembers.passes.flatMap(p => {
      const customerId = customerIds.get(p.memberId);
      return customerId ? [{ membershipId: p.membershipId, productId: p.productId, customerId, customerKey: customerId,
        startsOn: p.startsOn, endsOn: p.endsOn, status: p.status, usesLeft: p.usesLeft }] : [];
    }),
    membershipUse: realMembers.uses.map(u => ({ useId: u.useId, membershipId: u.membershipId, usedAt: u.usedAt, canceledAt: u.canceledAt })),
    marketing: { ...marketing, mktVisit: [], mktCustomer: members.map(m => ({ customerId: m.customerId, name: m.name,
      phoneLast4: m.phoneMasked.slice(-4), maskKey: 'data.management.exampleMember', consentSms: m.consent.marketingAllowed,
      consentNight: false, variant: null })) },
  };
}

type MemberMoneyRead = MoneyRead & { readonly realMembers?: RealMembersSnapshot };
export const readRealMemberMoney = (read: MoneyRead) => (read as MemberMoneyRead).realMembers;

/** The shared POS money projection can keep all other sources while replacing F05-owned rows. */
export function withRealMemberMoney(read: MoneyRead, realMembers: RealMembersSnapshot | undefined): MemberMoneyRead {
  if (!realMembers) return read;
  const counts = new Map<string, number>();
  const uses: MembershipUse[] = realMembers.uses.map(u => {
    if (!u.canceledAt) counts.set(u.membershipId, (counts.get(u.membershipId) ?? 0) + 1);
    return { useId: u.useId, membershipId: u.membershipId, at: u.usedAt, sourceRef: memberSource(u),
      canceledAt: u.canceledAt, coveredQuantities: [], recognizedAmount: 0, membershipDiscount: 0 };
  });
  const memberships: MembershipTerms[] = realMembers.passes.map(p => ({ ...p.terms, membershipId: p.membershipId,
    memberId: p.memberId, startsOn: p.startsOn, endsOn: p.endsOn, saleSettlementId: p.saleSettlementId,
    ...(p.usesLeft !== null && p.terms.totalUses !== null ? { openingUses: Math.max(0, p.terms.totalUses - p.usesLeft - (counts.get(p.membershipId) ?? 0)) } : {}) }));
  return { ...read, scenario: 'normal', realMembers, products: realMembers.products,
    state: { ...read.state, accountTxns: realMembers.entries, memberships, uses },
    members: read.members.map(m => ({ ...m, phone: realMembers.profiles[m.memberId]?.phoneMasked ?? m.phone })) };
}

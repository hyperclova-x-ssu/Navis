import type { MemberAccountTxn, MoneyRead, SourceAmount } from '../accounting/types';
export type { MemberAccountTxn } from '../accounting/types';

export interface MemberAccountQuery { readonly memberId?: string; readonly start?: string; readonly end?: string; readonly kind?: MemberAccountTxn['kind']; readonly query?: string }
export interface MemberAccountView { readonly memberId: string; readonly name: string; readonly phone: string; readonly chargeBalance: number; readonly receivableBalance: number; readonly transactions: readonly MemberAccountTxn[] }
export interface MemberAccountsModel { readonly members: readonly MemberAccountView[]; readonly chargeBalance: number; readonly receivableBalance: number; readonly chargeHolders: number; readonly receivableHolders: number; readonly transactions: readonly MemberAccountTxn[] }
export function accountBalance(read: MoneyRead, memberId: string, account: MemberAccountTxn['account']) {
  return read.state.accountTxns.filter(t => t.memberId === memberId && t.account === account).reduce((n, t) => n + t.amount, 0);
}
/** A return restores its original lot; unrelated newer topups never conceal consumption. */
export function sourceAvailable(read: MoneyRead, txnId: string) {
  const origin = read.state.accountTxns.find(t => t.txnId === txnId);
  if (!origin) return 0;
  return origin.amount + read.state.accountTxns.reduce((n, t) => {
    if (t.originalTxnId === txnId && !t.sourceAmounts?.length) return n + t.amount;
    const amount = t.sourceAmounts?.filter(s => s.txnId === txnId).reduce((v, s) => v + s.amount, 0) ?? 0;
    return n + Math.sign(t.amount) * amount;
  }, 0);
}
export function allocateAccountSources(read: MoneyRead, memberId: string, account: MemberAccountTxn['account'], amount: number, selectedTxnId?: string): readonly SourceAmount[] {
  let remaining = amount;
  return read.state.accountTxns.filter(t => t.memberId === memberId && t.account === account && ['opening', 'topup', 'sale', 'adjustment'].includes(t.kind) && t.amount > 0 && (!selectedTxnId || t.txnId === selectedTxnId))
    .sort((a, b) => a.at.localeCompare(b.at) || a.txnId.localeCompare(b.txnId)).flatMap(t => {
      const value = Math.min(remaining, Math.max(0, sourceAvailable(read, t.txnId))); remaining -= value;
      return value ? [{ txnId: t.txnId, amount: value }] : [];
    });
}
export function selectMemberAccounts(read: MoneyRead, query: MemberAccountQuery = {}): MemberAccountsModel {
  const search = query.query?.trim().toLocaleLowerCase() ?? '';
  const filter = (t: MemberAccountTxn) => (!query.start || t.at.slice(0, 10) >= query.start) && (!query.end || t.at.slice(0, 10) <= query.end) && (!query.kind || t.kind === query.kind);
  const members = read.members.filter(m => (!query.memberId || m.memberId === query.memberId) && (!search || m.name.toLocaleLowerCase().includes(search) || m.phone.slice(-4).includes(search))).map(m => ({ ...m,
    chargeBalance: accountBalance(read, m.memberId, 'charge'), receivableBalance: accountBalance(read, m.memberId, 'receivable'),
    transactions: read.state.accountTxns.filter(t => t.memberId === m.memberId && filter(t)).sort((a, b) => b.at.localeCompare(a.at) || b.txnId.localeCompare(a.txnId)) }));
  return { members, chargeBalance: members.reduce((n, m) => n + m.chargeBalance, 0), receivableBalance: members.reduce((n, m) => n + m.receivableBalance, 0),
    chargeHolders: members.filter(m => m.chargeBalance > 0).length, receivableHolders: members.filter(m => m.receivableBalance > 0).length,
    transactions: members.flatMap(m => m.transactions).sort((a, b) => b.at.localeCompare(a.at) || b.txnId.localeCompare(a.txnId)) };
}

import type { QueryCondition } from '../../../contracts';
import { selectMemberAccounts } from '../../../data/iteration7/accounts';
import { selectMemberships } from '../../../data/iteration7/memberships';
import type { MemberAccountTxn, MoneyRead } from '../../../data/iteration7/accounting/types';
import type { AccountTransaction, CreditBinding, CreditPort } from './types';

function accountHistory(read: MoneyRead, rows: readonly MemberAccountTxn[]): readonly AccountTransaction[] {
  const settlements = new Map(read.state.settlements.map(row => [row.settlementId, row]));
  const transactions = new Map(read.state.accountTxns.map(row => [row.txnId, row]));
  return rows.map(row => {
    const original = row.originalTxnId ? transactions.get(row.originalTxnId) : undefined;
    const settlementId = row.settlementId ?? original?.settlementId;
    const settlement = settlementId ? settlements.get(settlementId) : undefined;
    const source = settlement?.sourceRef ?? row.sourceRef ?? original?.sourceRef;
    const billId = settlement?.billId ?? (source?.kind === 'bill' ? source.id : undefined);
    const purpose = settlement?.purpose ?? source?.kind;
    const kind = original?.kind ?? row.kind;
    let originalLabel = '—';
    if (billId) {
      // A transferred portion can carry an internal suffix after the bill number.
      const billNumber = /^(B-\d+(?:-\d+)*)(?::|$)/.exec(billId)?.[1];
      originalLabel = billNumber ? `계산서 ${billNumber}` : '계산서';
    } else if (kind === 'collection' || purpose === 'receivable_collection') {
      originalLabel = '수금';
    } else if (kind === 'topup' || purpose === 'charge_topup') {
      originalLabel = '충전';
    }
    return { ...row, originalLabel };
  });
}

/** Read-only adapter. T-270 supplies MoneyRead and applies the engine's atomic plans. */
export function memberMoneyBinding(read: MoneyRead, port: CreditPort, condition: QueryCondition = { kind: 'default' }): CreditBinding {
  const passes = selectMemberships(read);
  const accounts = selectMemberAccounts(read, condition.kind === 'dateRange' ? { start: condition.start, end: condition.end }
    : condition.kind === 'snapshot' ? { end: condition.asOf } : {});
  return {
    view: read.scenario === 'error' ? { status: 'error' } : read.scenario === 'empty' ? { status: 'empty' } : {
      status: 'ready', model: { ...accounts, transactions: accountHistory(read, accounts.transactions) },
    },
    port,
    products: passes.products.map(product => ({ productId: product.productId, label: product.name, kind: product.kind, price: product.soldPrice, totalUses: product.totalUses ?? undefined, validDays: product.validDays })),
    memberships: passes.memberships.map(pass => ({
      membershipId: pass.membershipId, memberId: pass.memberId, productLabel: pass.name, kind: pass.kind,
      soldPrice: pass.soldPrice, totalUses: pass.totalUses ?? undefined, validDays: pass.validDays,
      startsOn: pass.startsOn, endsOn: pass.endsOn, usesRemaining: pass.usesRemaining,
      recognizedValue: pass.recognizedValue, unrecognizedValue: pass.unrecognizedValue, refundedValue: pass.refundedValue,
      status: pass.status === 'active' && pass.kind === 'count' && pass.usesRemaining === 0 ? 'exhausted' : pass.status,
      saleSettlementId: pass.saleSettlementId,
      uses: pass.uses.map(use => ({ useId: use.useId, usedAt: use.at, canceledAt: use.canceledAt, sourceRef: use.sourceRef })),
    })),
  };
}

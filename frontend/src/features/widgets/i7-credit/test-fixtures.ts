import { vi } from 'vitest';
import type { CreditBinding } from './types';

export const transaction = { txnId: 'TX-1', memberId: 'M-0001', account: 'charge' as const, kind: 'topup' as const, amount: 50000, at: '2026-10-26T10:15:00', settlementId: 'SET-1', originalTxnId: null, sourceRef: { kind: 'settlement', id: 'SET-1' } };
export function binding(): CreditBinding {
  return {
    view: { status: 'ready', model: {
      chargeBalance: 55000, receivableBalance: 10000, chargeHolders: 2, receivableHolders: 1,
      members: [
        { memberId: 'M-0001', name: '김지현', phone: '01012342481', chargeBalance: 40000, receivableBalance: 0, transactions: [transaction] },
        { memberId: 'M-0003', name: '박소영', phone: '01012348811', chargeBalance: 15000, receivableBalance: 0, transactions: [] },
        { memberId: 'M-0005', name: '정민아', phone: '01012347711', chargeBalance: 0, receivableBalance: 10000, transactions: [{ ...transaction, txnId: 'TX-2', memberId: 'M-0005', account: 'receivable', kind: 'sale', amount: 10000 }] },
      ], transactions: [transaction],
    } },
    products: [{ productId: 'P-COUNT', label: '아메리카노 10잔권', kind: 'count', price: 40000, totalUses: 10, validDays: 90 }, { productId: 'P-PERIOD', label: '월 구독', kind: 'period', price: 55000, validDays: 30 }],
    memberships: [],
    port: { openSettlement: vi.fn(), openAccounts: vi.fn(), openOriginalTransaction: vi.fn(), openMembershipUse: vi.fn() },
  };
}

import { expect, it, vi } from 'vitest';
import type { MoneyRead } from '../../../data/iteration7/accounting/types';
import { memberMoneyBinding } from './source';
import { accountIssue } from './copy';
import { binding } from './test-fixtures';

function read(): MoneyRead {
  return {
    runId: 'run', revision: 1, generation: 0, businessDate: '2026-10-26', now: '2026-10-26T15:45', scenario: 'normal', dayClosed: false,
    members: [{ memberId: 'M-0001', name: '김지현', phone: '01012342481' }], sources: [],
    products: [{ productId: 'monthly', name: '월 구독', kind: 'period', soldPrice: 55000, totalUses: null, validDays: 30 }],
    state: {
      settlements: [], payments: [], recognitions: [{ recognitionId: 'day', source: 'subscription_day', sourceId: 'pass', businessDate: '2026-10-26', at: '2026-10-26T00:00', amount: 1833, cost: null, settlementCategory: 'subscription_day', originalRecognitionId: null, membershipId: 'pass' }],
      accountTxns: [{ txnId: 'topup', memberId: 'M-0001', account: 'charge', kind: 'topup', amount: 50000, at: '2026-10-26T10:15', settlementId: 'sale', allocationId: 'original-allocation', originalTxnId: null, sourceRef: { kind: 'settlement', id: 'sale' }, reason: '' },
        { txnId: 'use', memberId: 'M-0001', account: 'charge', kind: 'use', amount: -10000, at: '2026-10-26T12:10', settlementId: 'use-sale', allocationId: 'use-allocation', originalTxnId: 'topup', sourceRef: { kind: 'bill', id: 'B-1' }, sourceAmounts: [{ txnId: 'topup', amount: 10000 }], reason: '' }],
      memberships: [{ membershipId: 'pass', productId: 'monthly', memberId: 'M-0001', name: '월 구독', kind: 'period', soldPrice: 55000, totalUses: null, validDays: 30, startsOn: '2026-10-26', endsOn: '2026-11-24', saleSettlementId: 'pass-sale' }],
      uses: [{ useId: 'use-pass', membershipId: 'pass', at: '2026-10-26T13:00', sourceRef: { kind: 'bill', id: 'B-2' }, coveredQuantities: [{ allocationId: 'line', quantity: 1 }], recognizedAmount: 0, membershipDiscount: 5000, canceledAt: null }],
      corrections: [], commands: [], attempt: null,
    },
  };
}

it('projects accounts, sold terms and original use references from the live domain without writing', () => {
  const source = read(), before = structuredClone(source), port = binding().port;
  const result = memberMoneyBinding(source, port);
  expect(result.view).toMatchObject({ status: 'ready', model: { chargeBalance: 40000, receivableBalance: 0, chargeHolders: 1 } });
  if (result.view.status !== 'ready') throw Error('ready');
  expect(result.view.model.transactions[0]).toMatchObject({ allocationId: 'use-allocation', originalTxnId: 'topup', sourceAmounts: [{ txnId: 'topup', amount: 10000 }] });
  expect(result.memberships[0]).toMatchObject({ recognizedValue: 1833, unrecognizedValue: 53167, uses: [{ sourceRef: { kind: 'bill', id: 'B-2' } }] });
  expect(source).toEqual(before);
  expect(vi.mocked(port.openSettlement)).not.toHaveBeenCalled();
});

it('forwards the requested history period while keeping source balances and exposes error/empty variants', () => {
  const source = read(), port = binding().port;
  expect(memberMoneyBinding(source, port, { kind: 'dateRange', start: '2026-10-25', end: '2026-10-25' }).view).toMatchObject({ status: 'ready', model: { chargeBalance: 40000, transactions: [] } });
  expect(memberMoneyBinding({ ...source, scenario: 'error' }, port).view).toEqual({ status: 'error' });
  expect(memberMoneyBinding({ ...source, scenario: 'empty' }, port).view).toEqual({ status: 'empty' });
});

it('keeps the approved consumed-topup and collected-receivable explanations', () => {
  expect(accountIssue('TOPUP_ALREADY_USED')).toBe('이미 사용한 충전금이라 전체 취소할 수 없어요');
  expect(accountIssue('RECEIVABLE_ALREADY_COLLECTED')).toBe('이미 수금한 외상이 있어요 · 수금 취소·환불을 먼저 해 주세요');
});

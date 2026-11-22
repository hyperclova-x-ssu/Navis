import { expect, it } from 'vitest';
import { approvalBody, parseApproval, parseCancellation, cancellationResult, formError, settlementPage } from './pay-wire.ts';

it('uses the documented v2.2 form and keeps approval settlement placeholders zero', () => {
  expect(parseApproval('paymentId=fixture')).toEqual({ paymentId: 'fixture' });
  expect(parseApproval('paymentId=fixture&paymentId=duplicate')).toBeNull();
  expect(parseApproval('paymentId=fixture&amount=1000')).toBeNull();
  expect(formError('approve', '')).toBe('RequireParameter');
  expect(formError('approve', 'paymentId=')).toBe('InvalidParameter');
  expect(formError('approve', 'bad=value')).toBe('InvalidParameter');
  const body = approvalBody({ paymentId: 'fixture', payHistId: 'history', amount: 3800,
    merchantPayKey: 'order-fixture', productName: '카페라떼', admissionAt: new Date('2026-11-17T06:45:00Z'), useDate: '20261117' });
  expect(Object.keys(body).sort()).toEqual(['detail', 'paymentId']);
  expect(body.detail).toMatchObject({ paymentId: 'fixture', payHistId: 'history', admissionYmdt: '20261117154500',
    admissionState: 'SUCCESS', totalPayAmount: 3800, settleExpected: false, settleExpectAmount: 0, payCommissionAmount: 0,
    useCfmYmdt: '20261117' });
  expect(body.detail).not.toHaveProperty('settleCompleteDate');
});

it('uses official cancellation codes for tax, rest and repeated full cancellations', () => {
  const form = 'paymentId=fixture&cancelAmount=1000&cancelReason=stop&cancelRequester=2&taxScopeAmount=1000&taxExScopeAmount=0&doCompareRest=1&expectedRestAmount=2800';
  const input = parseCancellation(form);
  expect(parseCancellation(form.replace('&taxExScopeAmount=0', ''))).toBeNull();
  expect(formError('cancel', form.replace('&taxExScopeAmount=0', ''))).toBe('RequireParameter');
  expect(input).not.toBeNull();
  if (!input) throw new Error('cancellation form rejected');
  expect(cancellationResult(input, 0)).toBe('AlreadyCanceled');
  expect(cancellationResult(input, 900)).toBe('OverRemainAmount');
  expect(cancellationResult(input, 3000)).toBe('RestAmountDiff');
  expect(cancellationResult({ ...input, taxScopeAmount: 1 }, 3800)).toBe('TaxScopeAmountError');
  expect(cancellationResult({ ...input, taxScopeAmount: 999, taxExScopeAmount: 1 }, 3800)).toBe('TaxScopeAmtGreaterThanRemainError');
  expect(cancellationResult(input, 3800)).toBe('Success');
});

it('paginates separate settlement rows and only supplies totals on page 1', () => {
  expect(settlementPage([], 1)).toEqual({ list: [], currentPage: 1, responseCount: 0, totalCount: 0, totalPageCount: 0 });
  expect(settlementPage([], 2)).toEqual({ list: [], currentPage: 2, responseCount: 0 });
});

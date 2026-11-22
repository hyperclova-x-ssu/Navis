import { describe, expect, it } from 'vitest';
import { PortError } from '../00/port';
import { billBody, paymentBody, terminalBody } from './requests';

const reason = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof PortError ? `${error.code}/${error.reason}/${error.field}` : String(error); } return 'none'; };

describe('F02 request bodies', () => {
  it('builds a bill from cart lines and drops empty option lists', () => {
    expect(billBody('takeout', [{ menuId: 'm1', qty: 2, optionIds: [] }, { menuId: 'm2', qty: 1, optionIds: ['o1'] }])).toEqual({
      type: 'takeout', lines: [{ menuId: 'm1', qty: 2 }, { menuId: 'm2', qty: 1, optionIds: ['o1'] }],
    });
    expect(reason(() => billBody('takeout', []))).toBe('VALIDATION/EMPTY_CART/lines');
  });

  it('records cash without a terminal slip and requires one for card and easy pay', () => {
    expect(paymentBody('cash', 4500, 1)).toEqual({ method: 'cash', amount: 4500, quoteRevision: 1 });
    expect(reason(() => paymentBody('card', 4500, 1))).toBe('VALIDATION/TERMINAL_RECORD_REQUIRED/terminal');
    expect(paymentBody('easy_pay', 4500, 3, { approvalNo: ' a123 ', at: '2026-10-26T15:45' })).toEqual({
      method: 'easy_pay', amount: 4500, quoteRevision: 3, terminal: { approvalNo: 'a123', occurredAt: '2026-10-26T15:45:00+09:00' },
    });
    expect(reason(() => paymentBody('cash', 0, 1))).toBe('VALIDATION/INVALID_AMOUNT/amount');
    expect(reason(() => paymentBody('cash', 45.5, 1))).toBe('VALIDATION/INVALID_AMOUNT/amount');
  });

  it('checks the terminal references and time like the service', () => {
    expect(reason(() => terminalBody({ at: '2026-10-26T15:45' }))).toBe('VALIDATION/TERMINAL_REFERENCE_REQUIRED/approvalNo');
    expect(reason(() => terminalBody({ approvalNo: '12 34', at: '2026-10-26T15:45' }))).toBe('VALIDATION/TERMINAL_REFERENCE_INVALID/approvalNo');
    expect(reason(() => terminalBody({ receiptNo: 'x'.repeat(41), at: '2026-10-26T15:45' }))).toBe('VALIDATION/TERMINAL_REFERENCE_INVALID/receiptNo');
    expect(reason(() => terminalBody({ approvalNo: 'A1', at: '15:45' }))).toBe('VALIDATION/TERMINAL_TIME_INVALID/at');
    expect(terminalBody({ approvalNo: 'A1', receiptNo: 'R-9', at: '2026-10-26T09:05' })).toEqual({ approvalNo: 'A1', receiptNo: 'R-9', occurredAt: '2026-10-26T09:05:00+09:00' });
  });
});

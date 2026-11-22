import type { PosReceiptView, PosReversalQuote } from '../../../contracts/pos';
import { kstLocal } from './clock';
import type { PosReceiptDto } from './dto';

export function projectReceiptView(source: PosReceiptDto, local: PosReceiptView | null): PosReceiptView {
  return {
    ...source, paymentId: source.paymentId ?? source.settlementId, at: kstLocal(source.at),
    approvalNo: source.terminal?.approvalNo ?? source.terminal?.receiptNo ?? '',
    transactionNo: source.transactionNo ?? '', discounts: [],
    lines: source.lines.map(line => ({ ...line, options: line.options.map(option => ({ ...option, extraRecipe: [] })) })),
    member: local?.member?.memberId === source.memberId ? local?.member ?? null : null,
    cashReceipt: null, canIssueCashReceipt: false,
    corrections: source.corrections.map(correction => ({ ...correction, at: kstLocal(correction.at) })),
  };
}

/** The member-value correction is a whole-settlement operation in the current POS contract. */
export function projectMemberReversal(source: PosReceiptDto, kind: PosReversalQuote['kind'], local: PosReversalQuote, dayClosed: boolean): PosReversalQuote {
  return {
    ...local, kind, amount: source.remaining, remaining: source.remaining, methods: source.splits,
    canSubmit: !dayClosed && source.remaining > 0, issues: [], lines: [],
  };
}

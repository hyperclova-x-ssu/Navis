/** REAL-PLAN F02 — request bodies of the POS service (B02 README). Validation mirrors the service so the owner sees the reason before a round trip. */
import type { PosMethod } from '../../../contracts/pos';
import { PortError } from '../00/port';
import { kstOffset } from './clock';

export const POS_PATH = '/pos';
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export interface CartLineInput { readonly menuId: string; readonly qty: number; readonly optionIds: readonly string[] }
/** What the owner copies from the store's terminal slip. `at` is the store-local `YYYY-MM-DDTHH:mm` shown on the slip. */
export interface TerminalInput { readonly approvalNo?: string; readonly receiptNo?: string; readonly at: string }

const invalid = (reason: string, field?: string) => new PortError(400, 'VALIDATION', reason, field);

export function terminalBody(input: TerminalInput): { approvalNo?: string; receiptNo?: string; occurredAt: string } {
  const approvalNo = input.approvalNo?.trim() || undefined, receiptNo = input.receiptNo?.trim() || undefined;
  if (!approvalNo && !receiptNo) throw invalid('TERMINAL_REFERENCE_REQUIRED', 'approvalNo');
  for (const [field, value] of [['approvalNo', approvalNo], ['receiptNo', receiptNo]] as const) {
    if (value !== undefined && !REFERENCE.test(value)) throw invalid('TERMINAL_REFERENCE_INVALID', field);
  }
  let occurredAt: string;
  try { occurredAt = kstOffset(input.at); } catch { throw invalid('TERMINAL_TIME_INVALID', 'at'); }
  return { ...(approvalNo ? { approvalNo } : {}), ...(receiptNo ? { receiptNo } : {}), occurredAt };
}

export interface TableRevision { readonly tableId: string; readonly expectedRevision: number }

export function orderLinesBody(lines: readonly CartLineInput[]) {
  if (!lines.length) throw invalid('EMPTY_CART', 'lines');
  return lines.map(line => ({ menuId: line.menuId, qty: line.qty, ...(line.optionIds.length ? { optionIds: [...line.optionIds] } : {}) }));
}

export function billBody(type: 'dine_in' | 'takeout', lines: readonly CartLineInput[], extra: { readonly discount?: number; readonly table?: TableRevision; readonly postpaid?: boolean; readonly reservationId?: string } = {}) {
  return {
    type,
    lines: orderLinesBody(lines),
    ...(extra.discount ? { discount: extra.discount } : {}),
    ...(extra.table ? { table: extra.table } : {}),
    ...(extra.postpaid ? { postpaid: true } : {}),
    // R1-F06-2: the booking whose first order this is (its claim's command key is the idempotency key of the call).
    ...(extra.reservationId ? { reservationId: extra.reservationId } : {}),
  };
}

/** Cash records carry no terminal slip; card and easy-pay records must (`TERMINAL_RECORD_REQUIRED`). */
export function paymentBody(method: PosMethod, amount: number, quoteRevision: number, terminal?: TerminalInput) {
  if (!Number.isSafeInteger(amount) || amount < 1) throw invalid('INVALID_AMOUNT', 'amount');
  if (method === 'cash') return { method, amount, quoteRevision };
  if (!terminal) throw invalid('TERMINAL_RECORD_REQUIRED', 'terminal');
  return { method, amount, quoteRevision, terminal: terminalBody(terminal) };
}

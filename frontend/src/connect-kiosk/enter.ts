/**
 * KIOSK-UI — the Navis side of the Npay 커넥트 prop. A paid kiosk order arrives on the same-origin channel and is entered through the
 * POS' own command path (cart → one card/간편결제 approval, exactly what the POS screen's checkout presses): the order lands in POS
 * 주문현황 as a new highlighted row, flows into sales/P&L, and the owner's prepare → ready buttons work on it. Over HTTP the same
 * sale goes through the POS service's checkout (the bridge). The kiosk-side label (커넥트 · 네이버페이 …) is display text only; the
 * ledger tender stays card / easy_pay. One existing common-notice line says '커넥트 주문이 들어왔어요' (no sound, no new parts).
 */
import type { RunStore } from '../contracts';
import type { PosCatalogItem, PosMethod, PosReadSnapshot } from '../contracts/pos';
import { POS_NOW_TIME } from '../pos/clock';
import { getPaymentBillId, quotePaymentBill } from '../pos/loyalty';
import type { PosStatusRuntime } from '../pos/runtime';
import type { PosBridge } from '../data/reality/02/bridge';
import { connectMemo, rememberConnectOrder, type ConnectOrderLine, type ConnectOrderMessage } from './channel';
import type { PaymentLabel } from './flow';

const APPROVAL_WAIT_MS = 15_000;
/** Navis settles a card/간편결제 and the kiosk reports a name; only Naver Pay payments are 간편결제 (the ledger tender stays display-agnostic). */
export const methodFor = (payment: PaymentLabel): PosMethod => (payment === '카드' || payment === '삼성·애플·NFC' ? 'card' : 'easy_pay');

interface ResolvedLine { readonly menuId: string; readonly optionIds: readonly string[]; readonly qty: number }
const activeItems = (read: PosReadSnapshot): readonly PosCatalogItem[] => read.data.catalog.items.filter(item => !item.deletedAt);

/** Find the same menu by id, else by its name, and each option by id, else by its name inside the menu's groups (HTTP ids can differ from the seed's). */
export function resolveLines(read: PosReadSnapshot, lines: readonly ConnectOrderLine[]): readonly ResolvedLine[] | null {
  const items = activeItems(read), out: ResolvedLine[] = [];
  for (const line of lines) {
    const item = items.find(i => i.menuId === line.menuId) ?? items.find(i => i.name === line.name);
    if (!item) return null;
    const options = item.groups.flatMap(group => group.options.filter(option => !option.archivedAt));
    const optionIds: string[] = [];
    for (const wanted of line.options) {
      const found = options.find(o => o.optionId === wanted.optionId) ?? options.find(o => o.name === wanted.name);
      if (!found) return null;
      if (!optionIds.includes(found.optionId)) optionIds.push(found.optionId);
    }
    out.push({ menuId: item.menuId, optionIds, qty: line.qty });
  }
  return out;
}

function waitFor(runtime: PosStatusRuntime, done: (read: PosReadSnapshot) => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    if (done(runtime.read())) { resolve(true); return; }
    const stop = runtime.subscribe(() => { if (done(runtime.read())) { cleanup(); resolve(true); } });
    const timer = window.setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    function cleanup() { stop(); window.clearTimeout(timer); }
  });
}

export type IntakeResult = 'done' | 'retry' | 'drop';
export interface IntakeDeps {
  readonly run: RunStore;
  readonly runtime: PosStatusRuntime;
  readonly bridge: PosBridge | null;
}

/** Enter one kiosk order. `retry` means the POS is busy (the owner has a cart open, an approval is pending) and the order waits. */
export async function enterConnectOrder({ run, runtime, bridge }: IntakeDeps, message: ConnectOrderMessage): Promise<IntakeResult> {
  const state = run.getState();
  if (state.onboarding.step !== 'done') return 'retry';
  const first = runtime.read();
  if (first.posUi.approval?.status === 'pending' || first.pos.cart.lines.length || first.pos.cart.lock) return 'retry';
  const failed = () => { run.actions.showNotice({ kind: 'error', messageKey: 'pos.connectFailed' }); };
  const resolved = resolveLines(first, message.lines);
  if (!resolved) { failed(); return 'drop'; }
  const key = (name: string) => `connect:${message.id}:${name}`;
  const meta = (name: string) => ({ runId: runtime.read().runId, idempotencyKey: key(name) });
  const clear = () => { runtime.execute({ type: 'cart.clear', meta: meta('clear') }); };
  const step = (result: { readonly ok: boolean }) => { if (!result.ok) { clear(); failed(); } return result.ok; };
  if (!step(runtime.execute({ type: 'cart.type', orderType: message.orderType, meta: meta('type') }))) return 'drop';
  for (const [index, line] of resolved.entries()) {
    if (!step(runtime.execute({ type: 'cart.add', menuId: line.menuId, optionIds: line.optionIds, qty: line.qty, meta: meta(`add:${index}`) }))) return 'drop';
  }
  if (!step(runtime.execute({ type: 'cart.note', text: connectMemo(message.payment), meta: meta('note') }))) return 'drop';

  const before = new Set(runtime.read().pos.orders.map(order => order.orderId));
  const read = runtime.read();
  const billId = getPaymentBillId(read), quote = quotePaymentBill(read, billId);
  if (!quote.canSubmit) { clear(); failed(); return 'drop'; }
  const amount = quote.remaining || quote.payable;
  let orderId: string | undefined;

  if (bridge) {
    // HTTP: the POS service records the sale; its terminal reference is a kiosk reference, never a real card number.
    const outcome = await bridge.checkout({ attemptId: message.id, method: methodFor(message.payment),
      terminal: { approvalNo: `NC-${message.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`, at: `${read.pos.businessDate}T${POS_NOW_TIME}` }, expectedPayable: amount });
    clear();
    if (outcome.status !== 'paid') { failed(); return 'drop'; }
    if (outcome.orderNo !== undefined) rememberConnectOrder(outcome.orderNo, message.payment);
    orderId = runtime.read().pos.orders.find(order => order.orderNo === outcome.orderNo)?.orderId;
  } else {
    const begun = runtime.beginApproval({ billId, quoteRevision: quote.revision, splits: [{ method: methodFor(message.payment), amount }], meta: meta('pay') });
    if (!begun.ok) { clear(); failed(); return 'drop'; }
    const attemptId = runtime.read().posUi.approval?.attemptId;
    const settled = await waitFor(runtime, r => r.posUi.approval?.attemptId === attemptId && r.posUi.approval?.status !== 'pending', APPROVAL_WAIT_MS);
    const approval = runtime.read().posUi.approval;
    if (!settled || approval?.status !== 'succeeded') { runtime.dismissApproval(); clear(); failed(); return 'drop'; }
    const added = runtime.read().pos.orders.filter(order => !before.has(order.orderId));
    orderId = added.sort((a, b) => b.orderNo - a.orderNo)[0]?.orderId;
    runtime.dismissApproval();
  }

  if (orderId) runtime.openPos({ tab: 'status', orderId, forceVisible: true });
  run.actions.showNotice({ kind: 'complete', messageKey: 'pos.connectOrder' });
  return 'done';
}

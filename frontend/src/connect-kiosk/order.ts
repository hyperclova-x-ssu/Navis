/** KIOSK-UI — the kiosk's timings and the paid-order message it hands to Navis. */
import type { ConnectOrderMessage } from './channel';
import { cartTotal, optionLines, type KioskState } from './flow';
import { kioskItem } from './menu';

export interface KioskTimings {
  readonly idleMs: number; readonly approveMs: number; readonly cameraApproveMs: number; readonly scanMs: number; readonly endSeconds: number;
}
export const KIOSK_TIMINGS: KioskTimings = { idleMs: 60_000, approveMs: 1_500, cameraApproveMs: 900, scanMs: 1_500, endSeconds: 10 };

export function buildOrderMessage(state: KioskState, id: string, paidAt: string): ConnectOrderMessage | null {
  if (!state.orderType || !state.payment || !state.cart.length) return null;
  const lines = state.cart.flatMap(line => {
    const item = kioskItem(line.itemId);
    if (!item) return [];
    const options = optionLines(line).map(o => ({ optionId: o.id, name: o.name, extraPrice: o.extraPrice }));
    return [{ menuId: item.id, name: item.name, qty: line.qty, unitPrice: item.price + options.reduce((n, o) => n + o.extraPrice, 0), options }];
  });
  if (!lines.length) return null;
  return { v: 1, type: 'order', id, orderType: state.orderType, lines, total: cartTotal(state.cart), payment: state.payment, buzzer: state.buzzer, paidAt };
}

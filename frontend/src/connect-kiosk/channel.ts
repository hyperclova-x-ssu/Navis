/**
 * KIOSK-UI — how a paid kiosk order reaches the Navis window. The kiosk and Navis are two pages of the same origin (a split
 * screen, two windows or two frames), so one BroadcastChannel carries the order; nothing leaves the browser. The message
 * names every line by id AND by text so the Navis side can find the same menu even when its ids differ from the seed's.
 */
import type { KioskOrderType, PaymentLabel } from './flow';

export const CONNECT_CHANNEL = 'navis-connect-orders';
export const CONNECT_SOURCE = '커넥트';

export interface ConnectOrderLine {
  readonly menuId: string; readonly name: string; readonly qty: number; readonly unitPrice: number;
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly extraPrice: number }[];
}
export interface ConnectOrderMessage {
  readonly v: 1; readonly type: 'order';
  /** One id per paid kiosk order: the Navis side records an id once, so a repeated delivery never makes a second order. */
  readonly id: string;
  readonly orderType: KioskOrderType; readonly lines: readonly ConnectOrderLine[];
  readonly total: number; readonly payment: PaymentLabel; readonly buzzer: string | null; readonly paidAt: string;
}

export function isConnectOrderMessage(value: unknown): value is ConnectOrderMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<ConnectOrderMessage>;
  return m.v === 1 && m.type === 'order' && typeof m.id === 'string' && m.id.length > 0 && (m.orderType === 'dine_in' || m.orderType === 'takeout')
    && Array.isArray(m.lines) && m.lines.length > 0 && typeof m.total === 'number' && typeof m.payment === 'string'
    && m.lines.every(l => !!l && typeof l.menuId === 'string' && typeof l.name === 'string' && Number.isInteger(l.qty) && l.qty > 0 && Array.isArray(l.options));
}

export interface ConnectTransport {
  post(message: ConnectOrderMessage): void;
  subscribe(listener: (message: ConnectOrderMessage) => void): () => void;
}

/** The browser transport (a BroadcastChannel). Pages without one simply cannot hand the order over; the kiosk still runs. */
export function createBrowserTransport(name = CONNECT_CHANNEL): ConnectTransport {
  const open = (): BroadcastChannel | null => { try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null; } catch { return null; } };
  return {
    post(message) { const channel = open(); if (!channel) return; try { channel.postMessage(message); } finally { channel.close(); } },
    subscribe(listener) {
      const channel = open();
      if (!channel) return () => undefined;
      const onMessage = (event: MessageEvent) => { if (isConnectOrderMessage(event.data)) listener(event.data); };
      channel.addEventListener('message', onMessage);
      return () => { channel.removeEventListener('message', onMessage); channel.close(); };
    },
  };
}

/** The display text a Connect order carries in the Navis order list and detail (the ledger tender is separate). */
export const connectMemo = (payment: PaymentLabel): string => `${CONNECT_SOURCE} · ${payment}`;
const MEMO = new RegExp(`^${CONNECT_SOURCE} · (.+)$`, 'u');

const viaBridge = new Map<number, PaymentLabel>();
/** Over HTTP the service stores no memo, so the Navis window remembers which order numbers came from the kiosk (this page load only). */
export const rememberConnectOrder = (orderNo: number, payment: PaymentLabel): void => { viaBridge.set(orderNo, payment); };
export const forgetConnectOrders = (): void => { viaBridge.clear(); };

/** `{source, payment}` when the order came from the kiosk, from its memo (local POS) or from the remembered order number (HTTP). */
export function connectOrigin(order: { readonly orderNo: number; readonly memo?: string }): { readonly source: string; readonly payment: string } | undefined {
  const fromMemo = order.memo ? MEMO.exec(order.memo) : null;
  if (fromMemo) return { source: CONNECT_SOURCE, payment: fromMemo[1] };
  const remembered = viaBridge.get(order.orderNo);
  return remembered ? { source: CONNECT_SOURCE, payment: remembered } : undefined;
}

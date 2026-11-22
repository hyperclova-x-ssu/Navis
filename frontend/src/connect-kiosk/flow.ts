/**
 * KIOSK-UI — the kiosk's whole customer flow as one pure reducer (attract → 매장/포장 → menu → item → cart → 진동벨 → payment →
 * processing → success → keyword review → attract). Timers (60 s idle, 1.5 s approval, 10 s 끝내기) live in the component; every
 * state change that is a customer's press is an action here so the flow is testable without a browser.
 */
import { kioskItem, type KioskItem, type KioskTabKey } from './menu';

export type KioskOrderType = 'dine_in' | 'takeout';
/** The payment names the kiosk shows and the order row repeats (display text only). */
export const PAYMENT_LABELS = ['네이버페이', '페이스사인', '삼성·애플·NFC', '카드'] as const;
export type PaymentLabel = (typeof PAYMENT_LABELS)[number];
/** Npay point lines and the no-login review apply to Naver Pay payments only (guide: QR, 삼성페이 via Npay, 페이스사인). */
export const isNpayPayment = (label: PaymentLabel): boolean => label === '네이버페이' || label === '페이스사인';

export type KioskScreen =
  | 'attract' | 'method' | 'menu' | 'detail' | 'cart' | 'buzzer' | 'pay' | 'scan' | 'face'
  | 'processing' | 'success' | 'review' | 'reviewSent' | 'laterSent';

export const MAX_BUZZER_DIGITS = 3;
export const MAX_REVIEW_PICKS = 5;
export const MAX_LINE_QTY = 99;

export interface CartLine { readonly key: string; readonly itemId: string; readonly optionIds: readonly string[]; readonly qty: number }
export interface DetailDraft {
  readonly itemId: string;
  /** Set when the draft edits an existing cart line (옵션 변경). */
  readonly editKey: string | null;
  readonly qty: number;
  readonly picked: readonly string[];
}
export interface PaidReceipt { readonly orderId: string; readonly total: number; readonly label: PaymentLabel; readonly buzzer: string | null }

export interface KioskState {
  readonly screen: KioskScreen;
  readonly orderType: KioskOrderType | null;
  readonly tab: KioskTabKey;
  readonly cart: readonly CartLine[];
  readonly detail: DetailDraft | null;
  readonly buzzerDraft: string;
  readonly buzzer: string | null;
  readonly payment: PaymentLabel | null;
  readonly paid: PaidReceipt | null;
  readonly reviewPicks: readonly string[];
  readonly serial: number;
}

export const initialKioskState: KioskState = {
  screen: 'attract', orderType: null, tab: 'all', cart: [], detail: null, buzzerDraft: '', buzzer: null,
  payment: null, paid: null, reviewPicks: [], serial: 0,
};

export type KioskAction =
  | { readonly type: 'start' }
  | { readonly type: 'chooseType'; readonly orderType: KioskOrderType }
  | { readonly type: 'back' }
  | { readonly type: 'home' }
  | { readonly type: 'setTab'; readonly tab: KioskTabKey }
  | { readonly type: 'openItem'; readonly itemId: string }
  | { readonly type: 'detailQty'; readonly delta: 1 | -1 }
  | { readonly type: 'detailOption'; readonly groupId: string; readonly optionId: string; readonly delta: 1 | -1 }
  | { readonly type: 'detailAdd' }
  | { readonly type: 'detailPayNow' }
  | { readonly type: 'openCart' }
  | { readonly type: 'cartQty'; readonly key: string; readonly delta: 1 | -1 }
  | { readonly type: 'cartRemove'; readonly key: string }
  | { readonly type: 'cartEdit'; readonly key: string }
  | { readonly type: 'cartMore' }
  | { readonly type: 'cartPay' }
  | { readonly type: 'buzzerDigit'; readonly digit: string }
  | { readonly type: 'buzzerBackspace' }
  | { readonly type: 'buzzerNone' }
  | { readonly type: 'buzzerConfirm' }
  | { readonly type: 'choosePayment'; readonly label: PaymentLabel }
  | { readonly type: 'paymentRequested'; readonly label: PaymentLabel }
  | { readonly type: 'approved'; readonly orderId: string }
  | { readonly type: 'reviewStart' }
  | { readonly type: 'reviewLater' }
  | { readonly type: 'toggleChip'; readonly chip: string }
  | { readonly type: 'reviewSubmit' };

const optionPrice = (item: KioskItem, optionId: string): number => item.groups.flatMap(g => g.options).find(o => o.id === optionId)?.extraPrice ?? 0;
export const unitPrice = (item: KioskItem, optionIds: readonly string[]): number => item.price + optionIds.reduce((n, id) => n + optionPrice(item, id), 0);
export const lineTotal = (line: CartLine): number => { const item = kioskItem(line.itemId); return item ? unitPrice(item, line.optionIds) * line.qty : 0; };
export const won = (amount: number): string => `${amount.toLocaleString('ko-KR')}원`;
export const cartTotal = (cart: readonly CartLine[]): number => cart.reduce((n, line) => n + lineTotal(line), 0);
export const cartCount = (cart: readonly CartLine[]): number => cart.reduce((n, line) => n + line.qty, 0);
export const detailTotal = (draft: DetailDraft): number => { const item = kioskItem(draft.itemId); return item ? unitPrice(item, draft.picked) * draft.qty : 0; };
/** Every required group has exactly one chosen option (the group says 필수). */
export const requiredSatisfied = (item: KioskItem, picked: readonly string[]): boolean =>
  item.groups.every(group => !group.required || group.options.some(o => picked.includes(o.id)));
export const optionLines = (line: Pick<CartLine, 'itemId' | 'optionIds'>): readonly { readonly id: string; readonly name: string; readonly extraPrice: number }[] => {
  const item = kioskItem(line.itemId);
  return item ? item.groups.flatMap(g => g.options).filter(o => line.optionIds.includes(o.id)).map(o => ({ id: o.id, name: o.name, extraPrice: o.extraPrice })) : [];
};
const sameOptions = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const sortedPicks = (item: KioskItem, picked: readonly string[]): readonly string[] => item.groups.flatMap(g => g.options.map(o => o.id)).filter(id => picked.includes(id));

/** Put a line into the cart; an identical item+options line merges its quantity (as the POS cart does). */
function putLine(cart: readonly CartLine[], draft: DetailDraft, serial: number): { readonly cart: readonly CartLine[]; readonly serial: number } {
  const item = kioskItem(draft.itemId);
  if (!item) return { cart, serial };
  const optionIds = sortedPicks(item, draft.picked);
  const others = draft.editKey ? cart.filter(l => l.key !== draft.editKey) : cart;
  const twin = others.find(l => l.itemId === draft.itemId && sameOptions(l.optionIds, optionIds));
  if (twin) {
    const merged = { ...twin, qty: Math.min(MAX_LINE_QTY, twin.qty + draft.qty) };
    return { cart: draft.editKey && cart.some(l => l.key === draft.editKey) ? cart.filter(l => l.key !== draft.editKey).map(l => l.key === twin.key ? merged : l) : cart.map(l => l.key === twin.key ? merged : l), serial };
  }
  if (draft.editKey && cart.some(l => l.key === draft.editKey)) {
    return { cart: cart.map(l => l.key === draft.editKey ? { ...l, optionIds, qty: draft.qty } : l), serial };
  }
  return { cart: [...cart, { key: `line-${serial + 1}`, itemId: draft.itemId, optionIds, qty: draft.qty }], serial: serial + 1 };
}

/** Where `< 이전` goes from a screen. The payment screen has no back (the real one only has 처음으로). */
export function backTarget(state: KioskState): KioskScreen | null {
  switch (state.screen) {
    case 'method': return 'attract';
    case 'menu': return 'method';
    case 'detail': return state.detail?.editKey ? 'cart' : 'menu';
    case 'cart': return 'menu';
    case 'buzzer': return 'cart';
    case 'scan': case 'face': return 'pay';
    default: return null;
  }
}

export function kioskReducer(state: KioskState, action: KioskAction): KioskState {
  switch (action.type) {
    case 'home': return { ...initialKioskState, serial: state.serial };
    case 'start': return state.screen === 'attract' ? { ...state, screen: 'method' } : state;
    case 'chooseType': return state.screen === 'method' ? { ...state, orderType: action.orderType, screen: 'menu' } : state;
    case 'back': {
      const target = backTarget(state);
      if (!target) return state;
      return { ...state, screen: target, detail: null };
    }
    case 'setTab': return state.screen === 'menu' ? { ...state, tab: action.tab } : state;
    case 'openItem': {
      const item = kioskItem(action.itemId);
      if (state.screen !== 'menu' || !item || item.soldOut) return state;
      // A menu without options goes straight into the cart (real kiosk: only menus with options open the item page).
      if (!item.groups.length) {
        const put = putLine(state.cart, { itemId: item.id, editKey: null, qty: 1, picked: [] }, state.serial);
        return { ...state, cart: put.cart, serial: put.serial };
      }
      return { ...state, screen: 'detail', detail: { itemId: item.id, editKey: null, qty: 1, picked: [] } };
    }
    case 'detailQty': {
      if (state.screen !== 'detail' || !state.detail) return state;
      const qty = Math.min(MAX_LINE_QTY, Math.max(1, state.detail.qty + action.delta));
      return qty === state.detail.qty ? state : { ...state, detail: { ...state.detail, qty } };
    }
    case 'detailOption': {
      if (state.screen !== 'detail' || !state.detail) return state;
      const item = kioskItem(state.detail.itemId);
      const group = item?.groups.find(g => g.id === action.groupId);
      if (!item || !group || !group.options.some(o => o.id === action.optionId)) return state;
      const without = state.detail.picked.filter(id => id !== action.optionId);
      // Every group here allows one pick: choosing another option in a group replaces the earlier one.
      const picked = action.delta > 0
        ? [...without.filter(id => !group.options.some(o => o.id === id)), action.optionId]
        : without;
      return picked.length === state.detail.picked.length && picked.every(id => state.detail!.picked.includes(id)) ? state : { ...state, detail: { ...state.detail, picked } };
    }
    case 'detailAdd': case 'detailPayNow': {
      if (state.screen !== 'detail' || !state.detail) return state;
      const item = kioskItem(state.detail.itemId);
      if (!item || !requiredSatisfied(item, state.detail.picked)) return state;
      const put = putLine(state.cart, state.detail, state.serial);
      if (action.type === 'detailPayNow') return { ...state, cart: put.cart, serial: put.serial, detail: null, screen: 'buzzer', buzzerDraft: '' };
      return { ...state, cart: put.cart, serial: put.serial, detail: null, screen: state.detail.editKey ? 'cart' : 'menu' };
    }
    case 'openCart': return state.screen === 'menu' && state.cart.length ? { ...state, screen: 'cart' } : state;
    case 'cartQty': {
      if (state.screen !== 'cart') return state;
      return { ...state, cart: state.cart.map(l => l.key === action.key ? { ...l, qty: Math.min(MAX_LINE_QTY, Math.max(1, l.qty + action.delta)) } : l) };
    }
    case 'cartRemove': return state.screen === 'cart' ? { ...state, cart: state.cart.filter(l => l.key !== action.key) } : state;
    case 'cartEdit': {
      const line = state.cart.find(l => l.key === action.key);
      return state.screen === 'cart' && line ? { ...state, screen: 'detail', detail: { itemId: line.itemId, editKey: line.key, qty: line.qty, picked: line.optionIds } } : state;
    }
    case 'cartMore': return state.screen === 'cart' ? { ...state, screen: 'menu' } : state;
    case 'cartPay': return state.screen === 'cart' && state.cart.length ? { ...state, screen: 'buzzer', buzzerDraft: '' } : state;
    case 'buzzerDigit': {
      if (state.screen !== 'buzzer' || !/^\d$/.test(action.digit) || state.buzzerDraft.length >= MAX_BUZZER_DIGITS) return state;
      return { ...state, buzzerDraft: state.buzzerDraft + action.digit };
    }
    case 'buzzerBackspace': return state.screen === 'buzzer' && state.buzzerDraft ? { ...state, buzzerDraft: state.buzzerDraft.slice(0, -1) } : state;
    case 'buzzerNone': return state.screen === 'buzzer' ? { ...state, buzzer: null, buzzerDraft: '', screen: 'pay' } : state;
    case 'buzzerConfirm': return state.screen === 'buzzer' && state.buzzerDraft ? { ...state, buzzer: state.buzzerDraft, screen: 'pay' } : state;
    case 'choosePayment': {
      if (state.screen !== 'pay') return state;
      return { ...state, payment: action.label, screen: action.label === '네이버페이' ? 'scan' : action.label === '페이스사인' ? 'face' : 'processing' };
    }
    case 'paymentRequested': return state.screen === 'scan' || state.screen === 'face' ? { ...state, payment: action.label, screen: 'processing' } : state;
    case 'approved': {
      if (state.screen !== 'processing' || !state.payment) return state;
      return { ...state, screen: 'success', paid: { orderId: action.orderId, total: cartTotal(state.cart), label: state.payment, buzzer: state.buzzer }, reviewPicks: [] };
    }
    case 'reviewStart': return state.screen === 'success' ? { ...state, screen: 'review', reviewPicks: [] } : state;
    case 'reviewLater': return state.screen === 'success' ? { ...state, screen: 'laterSent' } : state;
    case 'toggleChip': {
      if (state.screen !== 'review') return state;
      if (state.reviewPicks.includes(action.chip)) return { ...state, reviewPicks: state.reviewPicks.filter(c => c !== action.chip) };
      return state.reviewPicks.length >= MAX_REVIEW_PICKS ? state : { ...state, reviewPicks: [...state.reviewPicks, action.chip] };
    }
    case 'reviewSubmit': return state.screen === 'review' && state.reviewPicks.length ? { ...state, screen: 'reviewSent' } : state;
  }
}

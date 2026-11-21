import { createContext, useContext, useSyncExternalStore } from 'react';
import type { SettlementAllocation, SettlementQuote } from '../../../data/iteration7/accounting/types';
import type { SettlementMember, SettlementPaymentPhase } from './SharedPosPaymentDialog';
import type { MoneyReversalView } from './SharedPosReversalDialog';

/** A frozen preview of all original shares; composition commits planAbandonSettlement. */
export interface PartialSettlementReversalQuote extends MoneyReversalView {
  readonly settlementIds: readonly string[];
}

export interface SaleSettlementState {
  readonly billId?: string; readonly phase: SettlementPaymentPhase;
  readonly completion?: { readonly settled: boolean; readonly remaining: number; readonly orderNo?: number };
}
/** Composition subscribes to the atomic money coordinator and returns a cached snapshot.
 * quoteSale also adapts bill-selected membership benefits into line-bound allocations.
 * No timers, money writes or session registration belong to the UI port.
 */
export interface SettlementUiPort {
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: () => SaleSettlementState;
  readonly quoteSale: (input: { readonly billId: string; readonly partId?: string; readonly allocations: readonly SettlementAllocation[] }) => SettlementQuote;
  readonly member: (memberId: string) => SettlementMember | null;
  readonly approve: (quote: SettlementQuote) => boolean;
  readonly quotePartialCancellation: (billId: string) => PartialSettlementReversalQuote;
  readonly cancelPartial: (quote: PartialSettlementReversalQuote) => boolean;
  readonly reset: () => void;
}
const SettlementUiContext = createContext<SettlementUiPort | null>(null);
export const SettlementUiProvider = SettlementUiContext.Provider;
export const useSettlementUi = () => useContext(SettlementUiContext);
const ready: SaleSettlementState = { phase: { status: 'ready' } };
const noSubscription = () => () => undefined;
const readReady = () => ready;
export function useSaleSettlementState(port: SettlementUiPort | null, billId: string): SaleSettlementState {
  const snapshot = useSyncExternalStore(port?.subscribe ?? noSubscription, port?.read ?? readReady, port?.read ?? readReady);
  return snapshot.billId === billId ? snapshot : ready;
}

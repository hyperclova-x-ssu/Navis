import type { QueryCondition } from '../../contracts';
import type { DataSnapshot } from '../db/types';

import type { ModelMap, ModelReader, StateNote, WidgetView } from './types';

export interface ModelContext {
  readonly viewContext?: { readonly cameraDisconnected?: boolean; readonly reservationVariant?: string };
  readonly snapshot: DataSnapshot;
  /** Normal-variant model of another widget, same snapshot (memoized, no copies). */
  readonly read: ModelReader;
}
export type Projector<F extends keyof ModelMap> = (ctx: ModelContext, condition: QueryCondition, variant: string) => WidgetView<ModelMap[F], F>;

export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
/** One-decimal rounding that is stable for display (8.1992 → 8.2). */
export const round1 = (n: number): number => Math.round(n * 10 + (n >= 0 ? 1e-9 : -1e-9)) / 10;
export const percentChange = (value: number, base: number): number => round1(((value - base) / base) * 100);
export const rateOf = (profit: number, net: number): number | null => (net > 0 ? round1((profit / net) * 100) : null);

export function ready<F extends keyof ModelMap>(featureId: F, condition: QueryCondition, variant: string, model: ModelMap[F], notes?: readonly StateNote[]): WidgetView<ModelMap[F], F> {
  return notes && notes.length > 0 ? { status: 'ready', featureId, condition, variant, model, notes } : { status: 'ready', featureId, condition, variant, model };
}
export function emptyView<F extends keyof ModelMap>(featureId: F, variant: string, partial?: Partial<ModelMap[F]>, actionKey?: string): WidgetView<ModelMap[F], F> {
  return { status: 'empty', featureId, variant, messageKey: `data.state.${featureId}.${variant}`, ...(actionKey ? { actionKey } : {}), ...(partial ? { partial } : {}) };
}
export const note = (id: keyof ModelMap, variant: string, params?: StateNote['params']): StateNote => (params ? { messageKey: `data.state.${id}.${variant}`, params } : { messageKey: `data.state.${id}.${variant}` });

export const categoryKey = (category: string): string => `data.expenseCategory.${category}`;
export const evidenceKey = (evidence: string): string => `data.evidence.${evidence}`;

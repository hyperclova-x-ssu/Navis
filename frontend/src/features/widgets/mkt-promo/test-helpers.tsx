import { vi } from 'vitest';
import type { DetailRef, FeatureId, QueryCondition, WidgetHost } from '../../../contracts';
import { createWidgetDataStore, selectWidget, type ModelOf, type WidgetDataStore } from '../../../data/widget-data';
export { NO_PHOTO_MENU, PHOTO_MENU, cafeCatalog, syncedCafeStore } from './promo-test-server';

/**
 * The model the widget reads from the 안숭잘부 카페 seed (SEED-W1), taken from the same selector the panels use, so a test states its
 * expected numbers from the data instead of repeating literals that change with the seed.
 */
export function cafeModel<F extends FeatureId>(id: F, condition: QueryCondition = { kind: 'default' }, store: WidgetDataStore = createWidgetDataStore()): ModelOf<F> {
  const view = selectWidget(store.getSnapshot(), id, condition, 'normal');
  if (view.status !== 'ready') throw new Error(`${id} ${view.status}`);
  return view.model as ModelOf<F>;
}
/** The Korean text of a data text (`{ raw }`) as the seed wrote it. */
export const rawOf = (value: unknown): string => String((value as { raw?: string }).raw ?? '');
/** Exact won as the window writes it (`1,739,400원`). */
export const wonText = (amount: number): string => `${Math.round(amount).toLocaleString('en-US')}원`;
/** Compact money as the panel writes it: `173.9만 원` from 10,000 won up, the plain amount below. */
export const manText = (amount: number): string => (Math.abs(amount) < 10000 ? wonText(Math.abs(amount)) : `${(Math.round(Math.abs(amount) / 1000) / 10).toFixed(1)}만 원`);

/** A recording WidgetHost for panel and detail tests. */
export function makeHost() {
  const host = {
    layer: 'marketing' as const,
    resetPreview: vi.fn(),
    openClosing: vi.fn<WidgetHost['openClosing']>(() => true),
    openLinked: vi.fn<(ref: DetailRef) => void>(),
    openDetail: vi.fn<(ref: DetailRef) => void>(),
    notify: vi.fn(),
    acknowledgeBriefing: vi.fn(),
  } satisfies WidgetHost;
  return host;
}

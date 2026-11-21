/** The React adapter serves the marketing widgets from the same store (one coupon source, F-55). */
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { WidgetDataProvider, useDataDispatch, useWidgetView } from '../react';
import { createWidgetDataStore, readModel } from '../widget-data';

describe('useWidgetView for marketing widgets', () => {
  it('a send re-renders coupon status and results from the same snapshot; the sample state applies to that widget only', () => {
    const store = createWidgetDataStore();
    const slotToSend = readModel(store.getSnapshot(), 'slot-coupon').openSlots.find(slot => slot.regularIds.length > 0)!;
    const wrapper = ({ children }: { children: ReactNode }) => <WidgetDataProvider store={store} preview={{ family: 'normal', overrides: { 'slot-coupon': 'no-slots' } }}>{children}</WidgetDataProvider>;
    const { result } = renderHook(() => ({ status: useWidgetView('coupon-status'), perf: useWidgetView('marketing-performance'), slot: useWidgetView('slot-coupon'), today: useWidgetView('marketing-today'), dispatch: useDataDispatch() }), { wrapper });
    expect(result.current.slot.status).toBe('empty');
    expect(result.current.today.status === 'ready' && result.current.today.model.cells[0].kind).toBe('quiet-hours');
    act(() => {
      const r = result.current.dispatch({ type: 'coupon.sendSlot', slotIds: [slotToSend.slotId], recipientIds: slotToSend.regularIds, benefit: 'percent-10', idempotencyKey: 'react' });
      expect(r.ok).toBe(true);
    });
    expect(result.current.status.status === 'ready' && result.current.status.model.activeCount).toBe(2);
    expect(result.current.perf.status === 'ready' && [result.current.perf.model.issued, result.current.perf.model.rate]).toEqual([300, 74]);
  });
});

// A briefing fact that is derived from POS rows must not be shown as "0원" while the POS domain is still loading (CHAT-REAL-DEV-2, Q27).
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore } from '../../data/widget-data';
import { assistantDomains } from './snapshot';
import { gateUnreadable } from './real-gate';

type State = { mode: 'http' | 'fixture'; status: 'ready' | 'loading' | 'error' | 'stale' };
const storeWith = (pos: State['status']) => {
  const store = createWidgetDataStore();
  const real = { state: (domain: string) => ({ mode: 'http', status: domain === 'pos' ? pos : 'ready' }) as State, mode: () => 'http', load: async () => undefined };
  return { ...store, real } as unknown as ReturnType<typeof createWidgetDataStore>;
};
const keys = (store: ReturnType<typeof createWidgetDataStore>) => {
  const domains = gateUnreadable(assistantDomains, store);
  const result = domains.projectWidget(store.getSnapshot(), 'briefing', { kind: 'default' }, 'ko');
  return result && 'facts' in result ? result.facts.map(fact => fact.key) : [];
};

describe('briefing facts while POS is unread', () => {
  it('keeps the closing and POS-order lines when POS is ready or stale', () => {
    for (const status of ['ready', 'stale'] as const) {
      const shown = keys(storeWith(status));
      expect(shown).toContain('briefing.closing.netSales');
      expect(shown).toContain('briefing.closing.profit');
    }
  });
  it.each(['loading', 'error'] as const)('drops the closing sales and profit while POS is %s, and keeps the other lines', status => {
    const shown = keys(storeWith(status));
    expect(shown).not.toContain('briefing.closing.netSales');
    expect(shown).not.toContain('briefing.closing.profit');
    expect(shown).not.toContain('briefing.closing.status');
    expect(shown).toContain('briefing.reservations.today');
    expect(shown).toContain('briefing.importantAlerts.count');
  });
});

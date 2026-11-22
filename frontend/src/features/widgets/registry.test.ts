import { describe, expect, it } from 'vitest';
import type { WidgetModule } from '../../contracts';
import { collectWidgetModules, widgetModules } from './registry';

const fake = (id: string) => ({ id, Panel: () => null, Detail: null, useSummary: () => '' }) as unknown as WidgetModule;

describe('widget module registry', () => {
  it('works with any subset of folders, including none', () => {
    expect(collectWidgetModules({})).toEqual([]);
    expect(collectWidgetModules({ './empty/index.ts': {} })).toEqual([]);
    expect(collectWidgetModules({ './b/index.ts': { widgets: [fake('tax')] }, './a/index.ts': { widgets: [fake('ledger'), fake('margin')] } }).map(m => m.id)).toEqual(['ledger', 'margin', 'tax']);
  });
  it('rejects a duplicate id and an id outside the registry', () => {
    expect(() => collectWidgetModules({ './a/index.ts': { widgets: [fake('tax')] }, './b/index.ts': { widgets: [fake('tax')] } })).toThrow(/twice/);
    expect(() => collectWidgetModules({ './a/index.ts': { widgets: [fake('stock-sync')] } })).toThrow(/not in the widget registry/);
    expect(() => collectWidgetModules({ './a/index.ts': { widgets: [fake('demand')] } })).toThrow(/not in the widget registry/);
  });
  it('collects the folders present in the working tree without duplicates', () => {
    const ids = widgetModules.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(29);
    expect(Object.keys(import.meta.glob('./*/index.ts'))).toHaveLength(13);
    for (const id of ['demand','hiring','interior','floor-plan','memberships']) expect(ids).not.toContain(id);
  });
});

/** Sample states (DATA_MODEL 10.12, AC-229 and the widget empty/error ACs). */
import { TODAY, YESTERDAY } from './db/time';
import { createSeedTables } from './db/seed';
import { describe, expect, it } from 'vitest';
import type { PreviewSelection } from '../contracts';
import { createWidgetDataStore, DATA_WIDGET_IDS, NORMAL_PREVIEW, previewVariants, readModel, resolveVariant, selectWidget, widgetFacts } from './widget-data';

const seed = createSeedTables();
const milk = seed.purchaseItem.find(row => row.itemId === 'i-milk')!;
const snapshot = createWidgetDataStore({
  inventoryItem: seed.inventoryItem.map(row => row.itemId === milk.itemId ? { ...row, restockThreshold: 30_000 } : row),
  purchaseOrder: [...seed.purchaseOrder,
    { poId: 'preview-overdue', supplierId: milk.supplierId, dueDate: YESTERDAY, expectedTime: null, status: 'scheduled', variant: null },
    { poId: 'preview-upcoming', supplierId: milk.supplierId, dueDate: TODAY, expectedTime: '10:00', status: 'scheduled', variant: null },
  ],
  purchaseOrderLine: [...seed.purchaseOrderLine, ...['preview-overdue', 'preview-upcoming'].map(poId => ({
    polId: `line:${poId}`, poId, itemId: milk.itemId, qtyOrdered: 12, unitPrice: milk.unitPrice, unitSnapshot: milk.purchaseUnit, basePerUnit: milk.basePerUnit,
  }))],
}).getSnapshot();
const preview = (family: PreviewSelection['family'], overrides: PreviewSelection['overrides'] = {}): PreviewSelection => ({ family, overrides });

describe('variant lists', () => {
  it('every one of the 21 widgets has at least one empty variant and exactly one error variant', () => {
    for (const id of DATA_WIDGET_IDS) {
      const variants = previewVariants(id);
      expect(variants.filter((v) => v.family === 'empty').length, id).toBeGreaterThanOrEqual(1);
      expect(variants.filter((v) => v.family === 'error'), id).toEqual([{ id: 'error', family: 'error', labelKey: `preview.variant.${id}.error` }]);
      for (const v of variants) expect(v.labelKey).toBe(`preview.variant.${id}.${v.id}`);
      expect(new Set(variants.map((v) => v.id)).size).toBe(variants.length);
    }
    expect(previewVariants('stock-sync' as never)).toEqual([]);
  });
  it('keeps the DATA_MODEL 10.12 order and extra variants', () => {
    expect(previewVariants('margin').map((v) => `${v.family}:${v.id}`)).toEqual(['empty:no-sales', 'special:missing-cost', 'special:zero-net', 'error:error']);
    expect(previewVariants('inventory-booking').map((v) => v.id)).toEqual(['no-items', 'partial-data', 'partial-zero', 'needs-review', 'no-restock', 'no-products', 'error']);
    expect(previewVariants('voice-booking').map((v) => v.id)).toEqual(['none', 'needs-confirmation', 'phone-disconnected', 'error']);
    expect(previewVariants('ai-response').map((v) => v.id)).toEqual(['none', 'channel-disconnected', 'send-failure', 'error']);
  });
});

describe('resolveVariant', () => {
  it('override → family first variant → first empty variant (special = empty) → normal', () => {
    expect(resolveVariant('ledger', NORMAL_PREVIEW)).toBe('normal');
    expect(resolveVariant('ledger', preview('empty'))).toBe('no-sales');
    expect(resolveVariant('ledger', preview('special'))).toBe('no-expenses');
    expect(resolveVariant('ledger', preview('error'))).toBe('error');
    expect(resolveVariant('manuals', preview('special'))).toBe('none');
    expect(resolveVariant('community', preview('special'))).toBe('none');
    expect(resolveVariant('margin', preview('special', { margin: 'zero-net' }))).toBe('zero-net');
    expect(resolveVariant('margin', preview('error', { margin: 'normal' }))).toBe('normal');
    expect(resolveVariant('margin', preview('empty', { margin: 'bogus' }))).toBe('no-sales');
    expect(resolveVariant('ledger', preview('normal', { margin: 'zero-net' }))).toBe('normal');
    expect(resolveVariant('stock-sync' as never, preview('empty'))).toBe('normal');
  });
});

describe('variant views', () => {
  it('uses a café milk order to demonstrate overdue stock when the snapshot has none', () => {
    const normal = createWidgetDataStore().getSnapshot();
    const view = selectWidget(normal, 'suppliers', { kind: 'default' }, 'overdue');
    expect(view).toMatchObject({ status: 'ready', model: {
      upcomingCount: 0, overdueCount: 1, overdue: [{
        supplierId: 's-dairy', dueDate: '2026-11-16', overdue: true,
        lines: [{ itemId: 'i-milk', unit: 'L', ordered: 12, received: 0, remaining: 12, unitPrice: 2900 }],
      }],
    } });
    expect(readModel(normal, 'suppliers').overdueCount).toBe(0);
    expect(normal.tables.purchaseOrder.every(order => order.status === 'complete')).toBe(true);
  });
  it('error: widget-specific message with retry; empty: message (+ action) without a model', () => {
    for (const id of DATA_WIDGET_IDS) {
      expect(selectWidget(snapshot, id, { kind: 'default' }, 'error'), id).toEqual({ status: 'error', featureId: id, variant: 'error', messageKey: `data.state.${id}.error` });
    }
    expect(selectWidget(snapshot, 'calendar', { kind: 'default' }, 'none')).toEqual({ status: 'empty', featureId: 'calendar', variant: 'none', messageKey: 'data.state.calendar.none', actionKey: 'data.action.addEvent' });
    expect(selectWidget(snapshot, 'voice-booking', { kind: 'default' }, 'phone-disconnected')).toMatchObject({ status: 'empty', actionKey: 'data.action.connect' });
    expect(selectWidget(snapshot, 'margin', { kind: 'default' }, 'zero-net')).toMatchObject({ status: 'empty', messageKey: 'data.state.margin.zero-net' });
    expect(selectWidget(snapshot, 'suppliers', { kind: 'default' }, 'no-upcoming')).toMatchObject({ status: 'empty', partial: { upcomingCount: 0, overdueCount: 1 } });
  });
  it('partial/special states keep values and add a note', () => {
    const ledger = selectWidget(snapshot, 'ledger', { kind: 'default' }, 'no-expenses');
    expect(ledger).toMatchObject({ status: 'ready', notes: [{ messageKey: 'data.state.ledger.no-expenses' }] });
    expect(ledger.status === 'ready' && [ledger.model.sales.net, ledger.model.remaining, ledger.model.expenses.total]).toEqual([831_220, null, 0]);
    const margin = selectWidget(snapshot, 'margin', { kind: 'default' }, 'missing-cost');
    expect(margin.status === 'ready' && [margin.model.rate, margin.model.costMissing, margin.model.menus[0].menuId, margin.model.menus[0].costMissing]).toEqual([null, true, 'm-saltbread', true]);
    const inv = selectWidget(snapshot, 'inventory-booking', { kind: 'default' }, 'partial-zero');
    expect(inv.status === 'ready' && [inv.model.restockCount, inv.model.reviewCount]).toEqual([0, 3]);
    expect(inv).toMatchObject({ notes: [{ messageKey: 'data.state.inventory-booking.partial-zero' }] });
    const noProducts = selectWidget(snapshot, 'inventory-booking', { kind: 'default' }, 'no-products');
    expect(noProducts.status === 'ready' && [noProducts.model.restockCount, noProducts.model.products.total]).toEqual([1, 0]);
    const cctv = selectWidget(snapshot, 'customer-analysis', { kind: 'default' }, 'gaps');
    expect(cctv.status === 'ready' && [cctv.model.gapHours, cctv.model.totalVisits]).toEqual([[12, 13, 15], 125]);
    const noShifts = selectWidget(snapshot, 'customer-analysis', { kind: 'default' }, 'no-shifts');
    expect(noShifts.status === 'ready' && [noShifts.model.totalVisits, noShifts.model.hours.every((h) => h.staff === null)]).toEqual([180, true]);
    const briefing = selectWidget(snapshot, 'briefing', { kind: 'default' }, 'partial');
    expect(briefing.status === 'ready' && briefing.model.arrival.map((i) => i.featureId)).toEqual(['calendar', 'inventory-booking', 'suppliers']);
    const calendar = selectWidget(snapshot, 'calendar', { kind: 'default' }, 'source-failed');
    expect(calendar.status === 'ready' && [calendar.model.todayCount, calendar.model.weekCount]).toEqual([4, 9]);
    const tax = selectWidget(snapshot, 'tax', { kind: 'default' }, 'missing-data');
    expect(tax.status === 'ready' && tax.model.period).toBeNull();
    const suppliers = selectWidget(snapshot, 'suppliers', { kind: 'default' }, 'overdue');
    expect(suppliers.status === 'ready' && [suppliers.model.overdueCount, suppliers.model.upcomingCount]).toEqual([1, 1]);
  });
  it('a sample state never changes other models or Navis facts (SCR-29)', () => {
    const normalFacts = DATA_WIDGET_IDS.flatMap((id) => widgetFacts(selectWidget(snapshot, id, { kind: 'default' }, 'normal')));
    for (const id of DATA_WIDGET_IDS) for (const v of previewVariants(id)) selectWidget(snapshot, id, { kind: 'default' }, v.id);
    expect(DATA_WIDGET_IDS.flatMap((id) => widgetFacts(selectWidget(snapshot, id, { kind: 'default' }, 'normal')))).toEqual(normalFacts);
    expect(readModel(snapshot, 'briefing').arrival.map((i) => i.value)).toEqual([4, 1, 1]);
    expect(readModel(snapshot, 'suppliers').overdueCount).toBe(1);
    expect(readModel(snapshot, 'inventory-booking').restockItems[0].nextDelivery?.poId).toBe('preview-overdue');
    expect(readModel(snapshot, 'voice-booking').todayCount).toBe(4);
  });
});

/** Navis facts (DATA_MODEL 10.13): unit codes, label keys, key numbers; translatable strings as DataText. */
import { addDays, TODAY, TOMORROW } from './db/time';
import { seedToday } from './db/generated/today';
import { seedOperations } from './db/generated/operations';
import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, DATA_WIDGET_IDS, selectWidget, widgetFacts, demandFacts, type ModelFact } from './widget-data';

const store = createWidgetDataStore();
const facts = (id: Parameters<typeof selectWidget>[1], condition: Parameters<typeof selectWidget>[2] = { kind: 'default' }) => widgetFacts(selectWidget(store.getSnapshot(), id, condition, 'normal'));
const byKey = (list: readonly ModelFact[], key: string) => list.filter((f) => f.key === key);
const UNITS = new Set(['KRW', 'percent', 'pp', 'person', 'visit', 'reservation', 'order', 'item', 'pcs', 'L', 'kg', 'g', 'mL', 'seat', 'table', 'count', 'level', 'hour', 'day', '']);

describe('widgetFacts', () => {
  it('every widget yields facts with `{widget}.{metric}` keys, known unit codes and data label keys', () => {
    for (const id of DATA_WIDGET_IDS) {
      const list = facts(id);
      expect(list.length, id).toBeGreaterThan(0);
      for (const f of list) {
        expect(f.key).toMatch(/^[a-zA-Z]+\.[a-zA-Z0-9.]+$/);
        expect(UNITS.has(f.unit), `${f.key} ${f.unit}`).toBe(true);
        expect(f.labelKey.startsWith('data.')).toBe(true);
      }
    }
  });
  it('keeps stored units (won, not 만 원) and the documented numbers', () => {
    expect(byKey(facts('ledger'), 'ledger.sales.net')[0]).toMatchObject({ value: seedToday.rollup.net, unit: 'KRW', date: TODAY, labelKey: 'data.fact.ledger.sales.net' });
    expect(byKey(facts('ledger'), 'ledger.remaining')[0]).toMatchObject({ value: 721_220, unit: 'KRW' });
    expect(byKey(facts('margin'), 'margin.rate')[0]).toMatchObject({ value: 70.6, unit: 'percent' });
    expect(byKey(facts('margin'), 'margin.rate.delta')[0]).toMatchObject({ value: -0.4, unit: 'pp' });
    expect(byKey(facts('inventory-booking'), 'inventory.restock.count')[0]).toMatchObject({ value: 0, unit: 'item' });
    const stocks = byKey(facts('inventory-booking'), 'inventory.stock');
    expect(stocks).toHaveLength(seedToday.stock.length);
    expect(stocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 20_400, unit: 'mL', labelText: { raw: '목장 1등급 우유' } }),
      expect.objectContaining({ value: 5_688, unit: 'g', labelText: { raw: '하우스 블렌드 원두' } }),
    ]));
    expect(byKey(demandFacts(store.getSnapshot()), 'demand.expected.total')[0]).toMatchObject({ value: 211, unit: 'person', date: TOMORROW });
    expect(byKey(demandFacts(store.getSnapshot()), 'demand.expected.band').map((f) => f.value)).toEqual([65, 111, 35]);
    expect(byKey(facts('voice-booking'), 'booking.today.count')[0]).toMatchObject({ value: 4, unit: 'reservation' });
    expect(byKey(facts('members'), 'memberships.active.count')[0]).toMatchObject({ value: 3, unit: 'count' });
    expect(byKey(facts('customer-analysis'), 'cctv.peak.staff')[0]).toMatchObject({ value: 2, unit: 'person' });
    expect(byKey(facts('staff-schedule'), 'staff.hourly.14.count')).toEqual([
      expect.objectContaining({ value: 2, unit: 'person', date: TODAY, labelText: { key: 'data.fact.staff.hourly.count', params: { hour: 14 } } }),
    ]);
    expect(byKey(facts('calendar'), 'calendar.today.count')[0]).toMatchObject({ value: 3, unit: 'count', date: TODAY });
    expect(byKey(facts('trade-area'), 'tradeArea.peak.people')[0]).toMatchObject({ value: 395, unit: 'person', labelText: { key: 'data.fact.tradeArea.peakAt', params: { hour: 18 } } });
  });
  it('customer-analysis adds the mock CCTV facts (t=20 scene, camelCase keys, never live values)', () => {
    const list = facts('customer-analysis');
    const get = (k: string) => byKey(list, k);
    expect(get('cctv.inStore.now')[0]).toMatchObject({ value: 5, unit: 'person' });
    expect(get('cctv.occupants.now')[0]).toMatchObject({ value: 3, unit: 'person' });
    expect(get('cctv.tables.occupied')).toEqual([expect.objectContaining({ value: 2, unit: 'table' })]);
    expect(get('cctv.tables.toClear')[0]).toMatchObject({ value: 0, unit: 'table' });
    expect(get('cctv.tables.empty')).toEqual([expect.objectContaining({ value: 1, unit: 'table' })]);
    expect(get('cctv.dwell.avgToday')[0]).toMatchObject({ value: 39 });
    expect(get('cctv.change5m')[0]).toMatchObject({ value: -1, unit: 'person' });
    expect(byKey(list, 'cctv.visits.total')).toHaveLength(1);
    for (const f of list.filter((x) => x.key.startsWith('cctv.'))) expect(f.key).toMatch(/^[a-zA-Z]+(\.[a-zA-Z0-9]+)+$/);
  });
  it('range conditions carry start/end and daily values', () => {
    const list = facts('ledger', { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY });
    expect(byKey(list, 'ledger.sales.net')[0]).toMatchObject({ start: addDays(TODAY, -6), end: TODAY });
    expect(byKey(list, 'ledger.sales.daily')).toHaveLength(7);
  });
  it('string-list facts (keywords, schedule titles, manual steps) are DataText to translate; manuals only published, with source', () => {
    expect(byKey(facts('local-trends'), 'localTrends.keyword').map((f) => f.text)).toEqual([{ key: 'seed:상도동 카공' }, { key: 'seed:숭실대 디저트' }, { key: 'seed:보늬밤 라떼' }]);
    expect(byKey(facts('calendar'), 'calendar.entry')[0]).toMatchObject({ value: '12:00', date: TODAY, text: { key: 'data.calendar.shiftChange' } });
    const steps = byKey(facts('manuals'), 'manuals.step');
    const closing = seedOperations.manuals.find(row => row.category === 'closing')!;
    expect(steps).toHaveLength(23);
    expect(steps.find(f => f.value === `${closing.manualId}#1`)).toMatchObject({
      text: { raw: closing.steps[0].body }, source: { raw: closing.title },
    });
    const s = createWidgetDataStore();
    s.dispatch({ type: 'manuals.createDraftFromMemo', memo: 'memo' });
    expect(widgetFacts(selectWidget(s.getSnapshot(), 'manuals', { kind: 'default' }, 'normal')).filter((f) => f.key === 'manuals.step')).toHaveLength(23);
  });
  it('empty and error views have no facts', () => {
    const snap = store.getSnapshot();
    expect(widgetFacts(selectWidget(snap, 'ledger', { kind: 'default' }, 'no-sales'))).toEqual([]);
    expect(widgetFacts(selectWidget(snap, 'ledger', { kind: 'default' }, 'error'))).toEqual([]);
  });
});

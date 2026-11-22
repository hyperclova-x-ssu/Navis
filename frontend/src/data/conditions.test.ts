import { describe, expect, it } from 'vitest';
import { ALL_DATA_WIDGET_IDS, DATA_WIDGET_IDS, MARKETING_WIDGET_IDS, defaultCondition, normalizeCondition, supportedConditions, isDataWidgetId } from './conditions';
import { addDays, LAST_MONTH_END, LAST_MONTH_START, MONTH_START, TODAY, YESTERDAY } from './db/time';
import { getRegistry, REMOVED_WIDGET_IDS } from '../catalog';

describe('widget condition source (DATA_MODEL 10.7)', () => {
  it('covers the 29 active widget registrations and the retained data ID for the retired widget', () => {
    const activeIds = getRegistry('A').map(f => f.id);
    expect(activeIds).toHaveLength(29);
    expect(REMOVED_WIDGET_IDS).toEqual(['marketing-performance']);
    expect(ALL_DATA_WIDGET_IDS).toHaveLength(30);
    expect(new Set(ALL_DATA_WIDGET_IDS).size).toBe(30);
    expect([...ALL_DATA_WIDGET_IDS].sort()).toEqual([...activeIds, ...REMOVED_WIDGET_IDS].sort());
    expect(ALL_DATA_WIDGET_IDS).toEqual([...DATA_WIDGET_IDS, ...MARKETING_WIDGET_IDS]);
    for (const id of ['stock-sync','demand','hiring','interior','floor-plan','memberships']) {
      expect(ALL_DATA_WIDGET_IDS).not.toContain(id);
      expect(isDataWidgetId(id)).toBe(false);
      expect(normalizeCondition(id, {kind:'default'})).toEqual({ok:false,code:'UNKNOWN_FEATURE'});
    }
    expect(isDataWidgetId('stock-sync')).toBe(false);
    for (const id of ALL_DATA_WIDGET_IDS) expect(isDataWidgetId(id)).toBe(true);
  });
  it('keeps the default shapes (default for all, snapshot for inventory)', () => {
    expect(defaultCondition('ledger')).toEqual({ kind: 'default' });
    expect(defaultCondition('inventory-booking')).toEqual({ kind: 'snapshot', asOf: TODAY });
    for (const id of ALL_DATA_WIDGET_IDS) expect(supportedConditions(id)[0]).toEqual(defaultCondition(id));
  });
  it('lists the supported date ranges per widget', () => {
    expect(supportedConditions('ledger')).toEqual([
      { kind: 'default' },
      { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY },
      { kind: 'dateRange', start: addDays(TODAY, -29), end: TODAY },
      { kind: 'dateRange', start: MONTH_START, end: TODAY },
    ]);
    expect(supportedConditions('margin')).toHaveLength(3);
    expect(supportedConditions('tax')).toEqual([{ kind: 'default' }, { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END }]);
    expect(supportedConditions('menu')).toEqual([{ kind: 'default' }]);
    expect(supportedConditions('members')).toEqual([{ kind: 'default' }]);
    expect(supportedConditions('briefing')).toEqual([{ kind: 'default' }]);
  });
  it('normalizes default, equivalent ranges and supported ranges', () => {
    expect(normalizeCondition('ledger', { kind: 'default' })).toEqual({ ok: true, value: { kind: 'default' } });
    expect(normalizeCondition('ledger', { kind: 'dateRange', start: TODAY, end: TODAY })).toEqual({ ok: true, value: { kind: 'default' } });
    expect(normalizeCondition('tax', { kind: 'dateRange', start: MONTH_START, end: TODAY })).toEqual({ ok: true, value: { kind: 'default' } });
    expect(normalizeCondition('menu', { kind: 'default' })).toEqual({ ok: true, value: { kind: 'default' } });
    expect(normalizeCondition('ledger', { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY })).toEqual({ ok: true, value: { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY } });
    expect(normalizeCondition('inventory-booking', { kind: 'default' })).toEqual({ ok: true, value: { kind: 'snapshot', asOf: TODAY } });
    expect(normalizeCondition('inventory-booking', { kind: 'snapshot', asOf: TODAY })).toEqual({ ok: true, value: { kind: 'snapshot', asOf: TODAY } });
  });
  it('rejects unsupported conditions without substituting another period', () => {
    expect(normalizeCondition('ledger', { kind: 'dateRange', start: addDays(TODAY, -7), end: TODAY })).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    expect(normalizeCondition('margin', { kind: 'dateRange', start: MONTH_START, end: TODAY })).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    expect(normalizeCondition('briefing', { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY })).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    expect(normalizeCondition('ledger', { kind: 'snapshot', asOf: TODAY })).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    expect(normalizeCondition('inventory-booking', { kind: 'snapshot', asOf: YESTERDAY })).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
  });
  it('rejects malformed conditions as INVALID_CONDITION and unknown widgets', () => {
    expect(normalizeCondition('ledger', { kind: 'dateRange', start: '2026-02-30', end: TODAY })).toEqual({ ok: false, code: 'INVALID_CONDITION' });
    expect(normalizeCondition('ledger', { kind: 'dateRange', start: TODAY, end: addDays(TODAY, -6) })).toEqual({ ok: false, code: 'INVALID_CONDITION' });
    expect(normalizeCondition('ledger', null as never)).toEqual({ ok: false, code: 'INVALID_CONDITION' });
    expect(normalizeCondition('ledger', { kind: 'weird' } as never)).toEqual({ ok: false, code: 'INVALID_CONDITION' });
    expect(normalizeCondition('stock-sync', { kind: 'default' })).toEqual({ ok: false, code: 'UNKNOWN_FEATURE' });
  });
});

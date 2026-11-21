/** Conditions of the 7 marketing widgets (DATA_MODEL 10.15.1, API-09 v4.1). */
import { addDays, LAST_MONTH_END, LAST_MONTH_START, MONTH_START, TODAY, TOMORROW } from '../db/time';
import { describe, expect, it } from 'vitest';
import { ALL_DATA_WIDGET_IDS, defaultCondition, isDataWidgetId, MARKETING_WIDGET_IDS, normalizeCondition, supportedConditions } from '../widget-data';

describe('marketing conditions', () => {
  it('30 data widgets, all known; marketing and M2 defaults', () => {
    // PRD §12.4 F-278/280/281, DATA_MODEL §19.1: notice, environment and custom orders.
    const m2 = ['notice-send', 'store-environment', 'custom-order'] as const;
    expect(ALL_DATA_WIDGET_IDS).toHaveLength(30);
    expect(new Set(ALL_DATA_WIDGET_IDS).size).toBe(30);
    expect(ALL_DATA_WIDGET_IDS).toEqual(expect.arrayContaining([...m2]));
    for (const id of ALL_DATA_WIDGET_IDS) expect(isDataWidgetId(id), id).toBe(true);
    for (const id of [...MARKETING_WIDGET_IDS, ...m2]) {
      expect(defaultCondition(id)).toEqual({ kind: 'default' });
    }
  });
  it('marketing results: this month (default) and last month only; the others default only', () => {
    expect(supportedConditions('marketing-performance')).toEqual([{ kind: 'default' }, { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END }]);
    expect(normalizeCondition('marketing-performance', { kind: 'dateRange', start: MONTH_START, end: TODAY })).toEqual({ ok: true, value: { kind: 'default' } });
    expect(normalizeCondition('marketing-performance', { kind: 'dateRange', start: '2026-08-01', end: '2026-08-31' })).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    expect(normalizeCondition('slot-coupon', { kind: 'dateRange', start: TOMORROW, end: addDays(TOMORROW, 6) })).toEqual({ ok: true, value: { kind: 'default' } });
    for (const id of MARKETING_WIDGET_IDS.filter((x) => x !== 'marketing-performance')) {
      expect(supportedConditions(id)).toEqual([{ kind: 'default' }]);
      expect(normalizeCondition(id, { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END })).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
      expect(normalizeCondition(id, { kind: 'snapshot', asOf: TODAY })).toEqual({ ok: false, code: 'UNSUPPORTED_CONDITION' });
    }
  });
});

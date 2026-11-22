import { describe, expect, it } from 'vitest';
import { createSeedContext, createReplaySeedContext, disposableReplaySeedContext } from './seed-context.ts';
import { historyForSeed } from './seed-history.ts';

describe('café seed context', () => {
  it('preserves the fixed fixture date and 90-day range', () => {
    const result = createSeedContext();
    expect(result).toMatchObject({
      start: '2026-08-20', end: '2026-11-17', days: 90, businessDate: '2026-11-17',
    });
  });

  it('isolates archive variants without polluting the normal catalog', () => {
    const instant = '2026-11-22T04:59:00+09:00';
    const first = createReplaySeedContext({ instant, variant: 'S8-176/3' });
    const second = createReplaySeedContext({ instant, variant: 'S8-176/4' });
    expect(first.businessDate).toBe('2026-11-21');
    expect(first.rows.menu_item).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '휘낭시에', deleted_at: first.now.toISOString() }),
    ]));
    expect(second.rows.menu_item).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '휘낭시에', deleted_at: first.now.toISOString() }),
    ]));
    expect(first.archivedMenuIds).not.toEqual(second.archivedMenuIds);
    expect(createSeedContext().archivedMenuIds).toEqual([]);
  });

  it('uses the Seoul calendar for the window and the store cutoff for service rows', () => {
    const beforeCutoff = createSeedContext({ now: new Date('2026-11-21T19:59:59Z') });
    expect(beforeCutoff).toMatchObject({
      start: '2026-08-25', end: '2026-11-22', days: 90, businessDate: '2026-11-21',
    });
    expect(beforeCutoff.rows.stock_daily_opening).toEqual(expect.arrayContaining([
      expect.objectContaining({ business_date: '2026-11-21' }),
      expect.objectContaining({ business_date: '2026-11-22' }),
    ]));
    expect(beforeCutoff.rows.store).toMatchObject([{
      timezone: 'Asia/Seoul', business_day_start: '05:00', created_at: '2026-08-24T20:00:00.000Z',
    }]);
    const atCutoff = createSeedContext({ now: new Date('2026-11-21T20:00:00Z') });
    expect(atCutoff).toMatchObject({ end: '2026-11-22', businessDate: '2026-11-22' });
  });

  it('uses the clock shared by the disposable HTTP services only on explicit seed opt-in', () => {
    const replay = {
      NAVIS_DB_HOST: 'db', NAVIS_REPLAY_DISPOSABLE: '1', NAVIS_REPLAY_INSTANT: '2026-11-22T04:59:59+09:00',
    };
    expect(disposableReplaySeedContext(replay)).toBeUndefined();
    const optedIn = { ...replay, NAVIS_DISPOSABLE_REPLAY_SEED: '1' };
    expect(disposableReplaySeedContext(optedIn)).toMatchObject({ end: '2026-11-22', businessDate: '2026-11-21' });
    expect(() => disposableReplaySeedContext({ ...optedIn, NAVIS_DB_HOST: 'postgres.example.invalid' })).toThrow();
    expect(() => disposableReplaySeedContext({ ...optedIn, NAVIS_HOSTED_DEMO_AUTH: '1' })).toThrow();
    expect(() => disposableReplaySeedContext({ NAVIS_DISPOSABLE_REPLAY_SEED: '1' })).toThrow();
  });

  it('pins an explicitly selected fixture date and rejects impossible calendar dates', () => {
    const now = new Date('2026-11-21T19:59:59Z');
    const result = createSeedContext({ now, endDate: '2026-12-05' });
    expect(result).toMatchObject({ start: '2026-09-07', end: '2026-12-05', days: 90, businessDate: '2026-12-05' });
    expect(() => createSeedContext({ now, endDate: '2026-02-30' })).toThrow();
  });

  it('cuts operating history at the shared instant, including immediately before 05:00', () => {
    const now = new Date('2026-11-21T19:59:59Z');
    const result = createSeedContext({ now });
    expect(result.cutoff).toBe(now.toISOString());
    expect(result.businessDate).toBe('2026-11-21');
    const history = historyForSeed(result);
    expect(history.some(sale => sale.businessDate === '2026-11-21' && sale.at !== null)).toBe(true);
    expect(history.every(sale => sale.order.ordered_at <= result.cutoff
      && (!sale.at || sale.at <= result.cutoff)
      && (!sale.correction || sale.correction.at <= result.cutoff))).toBe(true);
    expect(createSeedContext().cutoff).toBe('2026-11-17T06:45:00.000Z');
  });

  it('lands only the part of the last day that has occurred and keeps the generated tender totals', () => {
    const context = createSeedContext();
    const history = historyForSeed(context);
    const partial = history.filter(sale => sale.businessDate === context.businessDate);
    expect(partial.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThan(context.rows.bill.length);
    expect(partial.every(sale => sale.order.ordered_at <= context.cutoff)).toBe(true);
    const { rows, cutoff } = context;
    const tender = (rows.payment as Array<{ amount: number; paid_at: string }>)
      .filter(payment => payment.paid_at <= cutoff).reduce((sum, row) => sum + row.amount, 0);
    const returns = (rows.payment_correction as Array<{ amount: number; at: string }>)
      .filter(correction => correction.at <= cutoff).reduce((sum, row) => sum + row.amount, 0);
    expect(history.reduce((sum, sale) => sum + (sale.at ? sale.quote.payable : 0) - (sale.correction?.amount ?? 0), 0))
      .toBe(tender - returns);
  });
});

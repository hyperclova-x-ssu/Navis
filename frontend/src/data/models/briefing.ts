import { selectBriefing } from '../derive/operations';
import { YESTERDAY, addDays, TODAY } from '../db/time';
import type { BriefingItem, BriefingModel } from './types';
import { note, percentChange, ready, type Projector } from './util';

/**
 * Briefing never stores values: it re-reads the source models (normal variant) of the same snapshot.
 * Priority: today's work > loss if missed > good to know; max 3; sources with value 0 are skipped.
 */
export const projectBriefing: Projector<'briefing'> = (ctx, condition, variant) => {
  const t = ctx.snapshot.tables;
  const calendar = ctx.read('calendar');
  const inventory = ctx.read('inventory-booking');
  const suppliers = ctx.read('suppliers');
  const grants = ctx.read('grants');

  const firstTimed = calendar.todayEntries.find((e) => e.time !== null);
  const urgentGrants = grants.notices.filter((n) => n.isCandidate && n.daysLeft <= 7).length;
  const candidates: BriefingItem[] = [
    { featureId: 'calendar', tier: 'today', value: calendar.todayCount, unit: 'count', messageKey: 'data.briefing.calendar', params: { count: calendar.todayCount }, hint: firstTimed?.time ? { key: 'data.briefing.calendarHint', params: { time: firstTimed.time } } : null, ref: { featureId: 'calendar' } },
    { featureId: 'inventory-booking', tier: 'loss', value: inventory.restockCount, unit: 'item', messageKey: 'data.briefing.restock', params: { count: inventory.restockCount }, hint: inventory.outOfStockCount > 0 ? { key: 'data.briefing.restockHint', params: { count: inventory.outOfStockCount } } : null, ref: { featureId: 'inventory-booking' } },
    { featureId: 'suppliers', tier: 'loss', value: suppliers.overdueCount, unit: 'order', messageKey: 'data.briefing.overdue', params: { count: suppliers.overdueCount }, hint: null, ref: { featureId: 'suppliers' } },
    { featureId: 'grants', tier: 'loss', value: urgentGrants, unit: 'count', messageKey: 'data.briefing.grants', params: { count: urgentGrants }, hint: null, ref: { featureId: 'grants' } },

  ];
  const ledger = ctx.read('ledger');
  const yesterdayRow = t.dailySales.find((r) => r.businessDate === YESTERDAY);
  const baseRow = t.dailySales.find((r) => r.businessDate === addDays(YESTERDAY, -7));
  const net = (r: typeof yesterdayRow) => (r ? r.gross - r.discount - r.refund : 0);
  const model: BriefingModel = {
    ...selectBriefing(ctx.snapshot, { date: TODAY, viewContext: { ...ctx.viewContext as import('../derive/operations').BriefingViewContext, partial: variant === 'partial' } }),
    arrival: candidates.filter((c) => c.value > 0).slice(0, 3),
    closing: { netSales: ledger.sales.net, remaining: ledger.remaining },
    yesterday: { date: YESTERDAY, netSales: net(yesterdayRow), delta: baseRow ? { value: percentChange(net(yesterdayRow), net(baseRow)), kind: 'percent' } : null },
  };
  return ready('briefing', condition, variant, model, variant === 'partial' ? [note('briefing', 'partial')] : undefined);
};

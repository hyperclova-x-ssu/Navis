import { describe, expect, it } from 'vitest';
import { createWidgetDataStore, readModel, selectPayments, selectWidget, TODAY } from './widget-data';
import { addDays, daysBetween, MONTH_START } from './db/time';
import { createSeedTables } from './db/seed';
import type { QueryCondition } from '../contracts';

const ranges: readonly [QueryCondition, number, string][] = [
  [{ kind: 'default' }, 1, TODAY],
  [{ kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY }, 7, addDays(TODAY, -6)],
  [{ kind: 'dateRange', start: addDays(TODAY, -29), end: TODAY }, 30, addDays(TODAY, -29)],
  [{ kind: 'dateRange', start: MONTH_START, end: TODAY }, daysBetween(MONTH_START, TODAY) + 1, MONTH_START],
];

describe('손익 기간별 추이', () => {
  it('선택 기간의 일별 매출과 확정 지출, 순이익이 기간 합계와 일치한다', () => {
    const snapshot = createWidgetDataStore().getSnapshot();
    for (const [condition, length, start] of ranges) {
      const view = selectWidget(snapshot, 'ledger', condition, 'normal');
      if (view.status !== 'ready') throw new Error('손익을 읽지 못했어요');
      const { model } = view;
      expect(model.periodTrend).toHaveLength(length);
      expect(model.periodTrend[0].date).toBe(start);
      expect(model.periodTrend.at(-1)).toEqual({ date: TODAY, net: 831_220, expenses: 110_000, netProfit: 721_220 });
      expect(model.periodTrend.reduce((sum, row) => sum + row.net, 0)).toBe(model.sales.net);
      expect(model.periodTrend.reduce((sum, row) => sum + row.expenses, 0)).toBe(model.expenses.total);
      expect(model.periodTrend.reduce((sum, row) => sum + row.netProfit, 0)).toBe(model.netProfit);
      expect(model.periodTrend.every((row) => row.net - row.expenses === row.netProfit)).toBe(true);
    }
    expect(selectPayments(snapshot, { date: TODAY, scenario: 'normal' }).totals.net).toBe(831_220);
    expect(readModel(snapshot, 'ledger').trend).toHaveLength(7);
    expect(readModel(snapshot, 'ledger').trend.at(-1)).toMatchObject({ net: 831_220, expenses: 110_000, netProfit: 721_220 });
  });

  it('새 확정 지출은 두 추이에 반영하고 지출 없음 예시에서는 제외한다', () => {
    const store = createWidgetDataStore();
    expect(store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'supplies', amount: 30_000 }).ok).toBe(true);
    const model = readModel(store.getSnapshot(), 'ledger');
    expect(model.trend.at(-1)).toMatchObject({ expenses: 140_000, netProfit: 691_220 });
    expect(model.periodTrend[0]).toMatchObject({ expenses: 140_000, netProfit: 691_220 });
    const view = selectWidget(store.getSnapshot(), 'ledger', { kind: 'default' }, 'no-expenses');
    if (view.status !== 'ready') throw new Error('손익을 읽지 못했어요');
    expect(view.model.periodTrend[0]).toMatchObject({ expenses: 0, netProfit: 831_220 });
  });
});

describe('매뉴얼 두 그룹', () => {
  it('매장 정보는 영업 안내 본문이며 인수인계 분류와 체크리스트를 바꾸지 않는다', () => {
    const model = readModel(createWidgetDataStore().getSnapshot(), 'manuals');
    expect(model.publishedCount).toBe(5);
    expect(model.manuals).toHaveLength(5);
    expect(model.storeInfoCount).toBe(1);
    const guide = createSeedTables().manualStep.find(row => row.manualId === 'cafe-store-guide')!;
    expect(model.storeInfo.map((row) => [row.title, row.body, row.category, row.checklist])).toEqual([
      [{ key: 'data.management.info.hours' }, guide.body, 'store-info', false],
    ]);
    expect(model.byCategory.reduce((sum, row) => sum + row.count, 0)).toBe(5);
    expect(model.todayChecklist.map(row => [row.done, row.total])).toEqual([[0, 5], [0, 5]]);
  });

  it('매장 정보의 작성·수정·삭제 및 되돌리기는 해당 그룹의 본문과 개수에 반영된다', () => {
    const store = createWidgetDataStore();
    const created = store.dispatch({ type: 'manuals.create', section: 'store-info', title: '배달 포장 규칙', category: 'store-info', steps: ['포장을 확인해요'], idempotencyKey: '매장 정보' });
    expect(created.ok).toBe(true);
    let model = readModel(store.getSnapshot(), 'manuals');
    expect(model.storeInfoCount).toBe(2);
    const row = model.storeInfo.find((item) => 'raw' in item.title && item.title.raw === '배달 포장 규칙')!;
    expect(row.body).toEqual({ raw: '포장을 확인해요' });
    expect(store.dispatch({ type: 'manuals.update', manualId: row.manualId, patch: { steps: ['포장 상태를 다시 확인해요'] } }).ok).toBe(true);
    expect(readModel(store.getSnapshot(), 'manuals').storeInfo.find((item) => item.manualId === row.manualId)?.body).toEqual({ raw: '포장 상태를 다시 확인해요' });
    const deleted = store.dispatch({ type: 'manuals.delete', manualId: row.manualId });
    expect(deleted.ok).toBe(true);
    expect(readModel(store.getSnapshot(), 'manuals').storeInfoCount).toBe(1);
    if (!deleted.ok || !deleted.undoToken) throw new Error('되돌리기 정보가 없어요');
    expect(store.undo(deleted.undoToken).ok).toBe(true);
    model = readModel(store.getSnapshot(), 'manuals');
    expect(model.storeInfoCount).toBe(2);
    expect(model.publishedCount).toBe(5);
  });
});

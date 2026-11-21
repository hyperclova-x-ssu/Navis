import {describe, expect, it} from 'vitest';
import {
  completeOrder as complete, dismissOrderAlert, evaluateOrderAlert, initialOrderAlert, initialOrdersSlice as initialize,
  reopenOrder, selectOrderSummary as summarize, undoOrderComplete, usualMin as usual,
} from './index';
import { ORDER_NOW, ORDER_RECORDS } from './fixture';
import { MENU } from './menu';
import {ORDER_ROWS} from './rows';
import type {OrderAlertContext, OrderRecord, OrdersSlice} from './index';

const inputs = { records: ORDER_RECORDS, catalog: MENU, businessNow: ORDER_NOW };
const initialOrdersSlice = () => initialize(ORDER_RECORDS);
const selectOrderSummary = (slice: OrdersSlice) => summarize(slice, inputs);
const completeOrder = (slice: OrdersSlice, id: string, now: number) => complete(slice, id, now, ORDER_NOW);
const usualMin = (record: OrderRecord) => usual(record, MENU);

const T0 = 1_000_000;
const ok: OrderAlertContext = {onDashboard: true, coachVisible: false, overlayOpen: false, orderDetailOpen: false};

describe('fixture·요약', () => {
  it('72건·1,284,000원, amount = Σ qty×unitPrice', () => {
    expect(ORDER_RECORDS).toHaveLength(72);
    expect(ORDER_RECORDS.reduce((s, r) => s + r.amount, 0)).toBe(1_284_000);
    for (const r of ORDER_RECORDS) expect(r.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)).toBe(r.amount);
  });
  it('평소 시간이 11.6 표 72행과 모두 같다', () => {
    ORDER_ROWS.forEach((row, i) => expect(usualMin(ORDER_RECORDS[i]), `#${row[0]}`).toBe(row[5]));
  });
  it('처음 요약: 진행 중 5·누락 #66·오래 걸림 #69·평균 8.7·몰림', () => {
    const s = selectOrderSummary(initialOrdersSlice());
    expect(s).toMatchObject({todayCount: 72, orderGross: 1_284_000, doneCount: 67, openCount: 5, missingCount: 1,
      slowCount: 1, avgWaitMin: 8.7, recent10: 5, prev10: 1, rush: true});
    expect(s.missingIds).toEqual(['O-066']);
    expect(s.openList.map(o => o.no)).toEqual([66, 69, 70, 71, 72]);
    expect(s.openList.map(o => o.elapsedMin)).toEqual([28, 7, 5, 3, 1]);
    expect(s.openList.find(o => o.no === 69)).toMatchObject({usualMin: 3, isSlow: true, isMissing: false});
    expect(s.doneList.filter(d => d.waitMin > 2 * usualMin(ORDER_RECORDS[d.no - 1])).map(d => d.no).sort((a, b) => a - b)).toEqual([25, 26, 29, 41]);
  });
  it('selector는 orders 배열이 같으면 같은 객체', () => {
    const slice = initialOrdersSlice();
    expect(selectOrderSummary(slice)).toBe(selectOrderSummary({...slice}));
  });
});

describe('명령', () => {
  it('#66·#69 완료 뒤: 누락 0·오래 0·진행 중 3·몰림 꺼짐·평균 8.9', () => {
    let slice = initialOrdersSlice();
    slice = completeOrder(slice, 'O-066', T0).slice;
    slice = completeOrder(slice, 'O-069', T0).slice;
    const s = selectOrderSummary(slice);
    expect(s).toMatchObject({missingCount: 0, slowCount: 0, openCount: 3, rush: false, avgWaitMin: 8.9, doneCount: 69});
    expect(slice.orderRevision).toBe(2);
  });
  it('5건 모두 완료하면 평균 8.7(625/72)', () => {
    let slice = initialOrdersSlice();
    for (const id of ['O-066', 'O-069', 'O-070', 'O-071', 'O-072']) slice = completeOrder(slice, id, T0).slice;
    expect(selectOrderSummary(slice)).toMatchObject({openCount: 0, avgWaitMin: 8.7});
  });
  it('unchanged는 같은 객체', () => {
    const slice = initialOrdersSlice();
    for (const [out, code] of [
      [completeOrder(slice, 'O-001', T0), 'NOT_OPEN'], [completeOrder(slice, 'X', T0), 'UNKNOWN_ORDER'],
      [reopenOrder(slice, 'O-001'), 'NOT_REOPENABLE'], [reopenOrder(slice, 'X'), 'UNKNOWN_ORDER'],
      [undoOrderComplete(slice, 'nope', T0), 'UNDO_UNAVAILABLE'],
    ] as const) {
      expect(out.slice).toBe(slice);
      expect(out.result).toEqual({status: 'unchanged', code});
    }
  });
  it('undo token은 1회 소비·6초 뒤 만료·새 완료가 교체', () => {
    const a = completeOrder(initialOrdersSlice(), 'O-066', T0).slice;
    const token = a.orderUndo!.token;
    expect(undoOrderComplete(a, token, T0 + 6000).result).toMatchObject({status: 'unchanged'});
    const undone = undoOrderComplete(a, token, T0 + 5999);
    expect(undone.result.status).toBe('applied');
    expect(selectOrderSummary(undone.slice).openCount).toBe(5);
    expect(undone.slice.orderUndo).toBeNull();
    expect(undoOrderComplete(undone.slice, token, T0 + 10).result.status).toBe('unchanged');
    const b = completeOrder(a, 'O-069', T0 + 100).slice;
    expect(undoOrderComplete(b, token, T0 + 200).result.status).toBe('unchanged');
    expect(undoOrderComplete(b, b.orderUndo!.token, T0 + 200).result.status).toBe('applied');
  });
  it('멈춘 undo는 remainingMs 동안 유효', () => {
    const a = completeOrder(initialOrdersSlice(), 'O-066', T0).slice;
    const paused = {...a, orderUndo: {...a.orderUndo!, pausedReasons: ['focus' as const], remainingMs: 3000}};
    expect(undoOrderComplete(paused, a.orderUndo!.token, T0 + 60_000).result.status).toBe('applied');
  });
  it('reopen은 completedInRun만, 그 주문의 undo 무효', () => {
    const a = completeOrder(initialOrdersSlice(), 'O-066', T0).slice;
    const r = reopenOrder(a, 'O-066');
    expect(r.result.status).toBe('applied');
    expect(r.slice.orderUndo).toBeNull();
    expect(r.slice.orderRevision).toBe(2);
    expect(selectOrderSummary(r.slice).missingIds).toEqual(['O-066']);
    expect(reopenOrder(a, 'O-065').result).toEqual({status: 'unchanged', code: 'NOT_REOPENABLE'});
  });
});

describe('알림 판정', () => {
  const summary = selectOrderSummary(initialOrdersSlice());
  it('처음 1회 띄우고 notified 유지', () => {
    const shown = evaluateOrderAlert(initialOrderAlert, summary, ok);
    expect(shown).toEqual({visible: true, notifiedIds: ['O-066']});
    expect(evaluateOrderAlert(shown, summary, ok)).toBe(shown);
    const closed = dismissOrderAlert(shown);
    expect(closed).toEqual({visible: false, notifiedIds: ['O-066']});
    expect(evaluateOrderAlert(closed, summary, ok)).toBe(closed);
  });
  it('0건이면 자동으로 닫힘', () => {
    const shown = evaluateOrderAlert(initialOrderAlert, summary, ok);
    const done = selectOrderSummary(completeOrder(initialOrdersSlice(), 'O-066', T0).slice);
    expect(evaluateOrderAlert(shown, done, ok)).toEqual({visible: false, notifiedIds: ['O-066']});
  });
  it('코치·overlay·비대시보드 중에는 미루고 조건이 맞으면 띄운다', () => {
    for (const ctx of [{...ok, coachVisible: true}, {...ok, overlayOpen: true}, {...ok, onDashboard: false}])
      expect(evaluateOrderAlert(initialOrderAlert, summary, ctx)).toBe(initialOrderAlert);
  });
  it('주문 상세가 열린 동안 생긴 누락은 notified로만 기록', () => {
    expect(evaluateOrderAlert(initialOrderAlert, summary, {...ok, orderDetailOpen: true, overlayOpen: true}))
      .toEqual({visible: false, notifiedIds: ['O-066']});
  });
});

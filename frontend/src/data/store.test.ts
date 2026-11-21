/** Store mechanics (API-09 v4): immutable snapshots, revision, subscribe, single undo, determinism, memo. */
import { addDays, daysBetween, MONTH_START, TODAY, TOMORROW } from './db/time';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore, DATA_WIDGET_IDS, previewVariants, selectWidget } from './widget-data';

afterEach(() => vi.restoreAllMocks());

describe('snapshots and subscription', () => {
  it('starts at revision 0 with frozen tables; each success makes a new snapshot with revision + 1', () => {
    const store = createWidgetDataStore();
    const s0 = store.getSnapshot();
    expect(s0.revision).toBe(0);
    expect(Object.isFrozen(s0.tables.expense)).toBe(true);
    expect(Object.isFrozen(s0.tables.expense[0])).toBe(true);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.dispatch({ type: 'grants.markReviewed', noticeId: 'sample-grant-1' });
    const s1 = store.getSnapshot();
    expect(s1).not.toBe(s0);
    expect(s1.revision).toBe(1);
    expect(s0.tables.grantReview.find(r => r.noticeId === 'sample-grant-1')).toBeUndefined();
    expect(s1.tables.grantReview.find(r => r.noticeId === 'sample-grant-1')?.reviewStatus).toBe('reviewed');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    store.dispatch({ type: 'grants.markReviewed', noticeId: 'sample-grant-2' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('failures do not change the snapshot, the revision or notify', () => {
    const store = createWidgetDataStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    expect(store.dispatch({ type: 'grants.markReviewed', noticeId: 'missing' })).toEqual({ ok: false, code: 'NOT_FOUND', field: 'noticeId', messageKey: 'data.error.notFound' });
    expect(store.dispatch({ type: 'nope' } as never)).toMatchObject({ ok: false, code: 'VALIDATION', field: 'type' });
    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });
  it('seed overrides replace whole tables', () => {
    const store = createWidgetDataStore({ reservation: [] });
    const view = selectWidget(store.getSnapshot(), 'voice-booking', { kind: 'default' }, 'normal');
    expect(view.status === 'ready' && view.model.todayCount).toBe(0);
  });
});

describe('undo (one token, invalidated by the next success)', () => {
  it('restores the previous tables with a new revision, then the token is spent', () => {
    const store = createWidgetDataStore();
    const r = store.dispatch({ type: 'localChanges.acknowledge', changeId: 'sample-local-2' });
    if (!r.ok || !r.undoToken) throw new Error('expected undo token');
    const undone = store.undo(r.undoToken);
    expect(undone).toEqual({ ok: true, revision: 2, noticeKey: 'data.notice.undone' });
    expect(store.getSnapshot().tables.localChange.find((c) => c.changeId === 'sample-local-2')?.ackedAt).toBeNull();
    expect(store.undo(r.undoToken)).toEqual({ ok: false, code: 'CONFLICT', reason: 'UNDO_UNAVAILABLE', messageKey: 'data.error.undoUnavailable' });
  });
  it('the next successful command (even a non-undoable one) invalidates the token', () => {
    const store = createWidgetDataStore();
    const r = store.dispatch({ type: 'localChanges.acknowledge', changeId: 'sample-local-2' });
    if (!r.ok || !r.undoToken) throw new Error('expected undo token');
    store.dispatch({ type: 'calendar.setSourceVisible', source: 'reservation', visible: true });
    expect(store.undo(r.undoToken)).toMatchObject({ ok: false, code: 'CONFLICT' });
  });
  it('a failed command keeps the token valid; ids created after undo stay unique', () => {
    const store = createWidgetDataStore();
    const a = store.dispatch({ type: 'calendar.addEvent', title: 'A', date: TOMORROW });
    store.dispatch({ type: 'calendar.addEvent', title: '', date: TOMORROW });
    if (!a.ok || !a.undoToken) throw new Error('expected undo token');
    expect(store.undo(a.undoToken).ok).toBe(true);
    const b = store.dispatch({ type: 'calendar.addEvent', title: 'B', date: TOMORROW });
    expect((b as { value: { eventId: string } }).value.eventId).not.toBe((a as { value: { eventId: string } }).value.eventId);
  });
});

describe('determinism and memo', () => {
  it('never reads the clock or randomness; two runs give identical data', () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now used'); });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used'); });
    const a = createWidgetDataStore(), b = createWidgetDataStore();
    for (const id of DATA_WIDGET_IDS) {
      for (const v of ['normal', ...previewVariants(id).map((x) => x.id)]) {
        expect(JSON.stringify(selectWidget(a.getSnapshot(), id, { kind: 'default' }, v))).toBe(JSON.stringify(selectWidget(b.getSnapshot(), id, { kind: 'default' }, v)));
      }
    }
    const command = { type: 'calendar.addEvent', date: TOMORROW, title: '배송 확인' } as const;
    expect(a.dispatch(command).ok).toBe(true);
    expect(b.dispatch(command).ok).toBe(true);
    expect(JSON.stringify(a.getSnapshot())).toBe(JSON.stringify(b.getSnapshot()));
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });
  it('same (snapshot, widget, condition, variant) → same object; equivalent conditions share it; a new revision recomputes', () => {
    const store = createWidgetDataStore();
    const s = store.getSnapshot();
    const v1 = selectWidget(s, 'ledger', { kind: 'default' }, 'normal');
    expect(selectWidget(s, 'ledger', { kind: 'default' }, 'normal')).toBe(v1);
    expect(selectWidget(s, 'ledger', { kind: 'dateRange', start: TODAY, end: TODAY }, 'normal')).toBe(v1);
    expect(Object.isFrozen(v1)).toBe(true);
    const week = selectWidget(s, 'ledger', { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY }, 'normal');
    expect(week).not.toBe(v1);
    store.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'other', amount: 1 });
    expect(selectWidget(store.getSnapshot(), 'ledger', { kind: 'default' }, 'normal')).not.toBe(v1);
  });
  it('rejects unsupported/invalid conditions and unknown widgets as error views', () => {
    const s = createWidgetDataStore().getSnapshot();
    expect(selectWidget(s, 'ledger', { kind: 'dateRange', start: '2026-10-01', end: '2026-10-02' }, 'normal')).toEqual({ status: 'error', featureId: 'ledger', variant: 'normal', messageKey: 'data.error.unsupportedCondition' });
    expect(selectWidget(s, 'ledger', { kind: 'dateRange', start: 'x', end: 'y' }, 'normal')).toMatchObject({ status: 'error', messageKey: 'data.error.invalidCondition' });
    expect(selectWidget(s, 'stock-sync' as never, { kind: 'default' }, 'normal')).toMatchObject({ status: 'error', messageKey: 'data.error.unknownWidget' });
  });
  it('ledger and margin follow the selected period; ranges compare with the previous period when data exists', () => {
    const s = createWidgetDataStore().getSnapshot();
    const week = selectWidget(s, 'ledger', { kind: 'dateRange', start: addDays(TODAY, -6), end: TODAY }, 'normal');
    if (week.status !== 'ready') throw new Error('not ready');
    expect(week.model.sales.net).toBe(6_706_290);
    expect(week.model.trend).toHaveLength(7);
    expect(week.model.comparison?.base).toEqual({ start: addDays(TODAY, -13), end: addDays(TODAY, -7) });
    const month = selectWidget(s, 'ledger', { kind: 'dateRange', start: MONTH_START, end: TODAY }, 'normal');
    expect(month.status === 'ready' && month.model.comparison?.base).toEqual({ start: addDays(MONTH_START, -daysBetween(MONTH_START, TOMORROW)), end: addDays(MONTH_START, -1) });
    const thirty = selectWidget(s, 'ledger', { kind: 'dateRange', start: addDays(TODAY, -29), end: TODAY }, 'normal');
    expect(thirty.status === 'ready' && thirty.model.comparison?.base).toEqual({ start: addDays(TODAY, -59), end: addDays(TODAY, -30) });
    expect(thirty.status === 'ready' && thirty.model.trend).toHaveLength(30);
    const margin30 = selectWidget(s, 'margin', { kind: 'dateRange', start: addDays(TODAY, -29), end: TODAY }, 'normal');
    expect(margin30.status === 'ready' && margin30.model.netSales).toBe(thirty.status === 'ready' ? thirty.model.sales.net : -1);
  });
});

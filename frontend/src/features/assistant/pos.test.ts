import { replyResponse } from './stream-fixture';
import { expect, it, vi } from 'vitest';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { createWidgetDataStore, selectBriefing, selectReservations, TODAY } from '../../data/widget-data';
import { createSessionActions, sessionGateFor } from '../../app/session-actions';
import { orderStatusRuntime } from '../../pos/runtime';
import { timePolicy } from '../../ui';
import { buildAssistantContext, storeFactSource } from './snapshot';
import { createAssistantProvider } from './provider';
import { simpleReply } from './simple';

// Use café orders and keep their bill links while creating the pending-order conditions.
vi.mock('../../pos/seed', async importOriginal => {
  const original = await importOriginal<typeof import('../../pos/seed')>();
  const { POS_NOW } = await import('../../pos/clock');
  return {
    ...original,
    createPosSeed() {
      const pos = original.createPosSeed();
      const preparation = ['accepted', 'preparing', 'accepted', 'completed'] as const;
      return {
        ...pos, orders: pos.orders.map((order, index) => index < preparation.length ? {
          ...order, preparation: preparation[index], orderedAt: orderTime(POS_NOW, [-25, -12, -4, -30][index]),
          preparedAt: index === 1 ? orderTime(POS_NOW, -10) : null, completedAt: index === 3 ? orderTime(POS_NOW, -25) : null,
          completedInRun: false,
        } : order),
      };
    },
  };
});

function orderTime(now: string, offset: number) {
  const date = new Date(now + ':00Z');
  date.setUTCMinutes(date.getUTCMinutes() + offset);
  return date.toISOString().slice(0, 16);
}

// Missing atomic publication or deriving facts from a second order source breaks this calculation.
it('widgetless POS facts and tasks decrease together, undo restores them, and no candidate is produced', async () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => Date.now() });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const runtime = orderStatusRuntime(createSessionActions(run, data).pos);
  const source = storeFactSource(data);
  const facts = () => buildAssistantContext({ source, text: '누락 주문' }).snapshot.find(s => 'sourceId' in s && s.sourceId === 'pos');
  const count = (key: string) => { const entry = facts(); return entry && 'facts' in entry ? entry.facts.find(f => f.key === key)?.value : undefined; };
  const missingTask = () => selectBriefing(data.getSnapshot(), { date: TODAY }).importantAlerts.groups.find(g => g.id === 'tasks')?.items.find(i => i.id === 'pos:missing');
  expect(buildAssistantContext({ source, text: '누락 주문' }).catalog).toHaveLength(17);
  expect(facts()).toMatchObject({ sourceId: 'pos', candidateAllowed: false });
  const missing = run.getState().pos.orders[0];
  const waits = run.getState().pos.orders.filter(order => order.preparation === 'completed' && order.completedAt)
    .map(order => (Date.parse(order.completedAt!.slice(0, 16) + 'Z') - Date.parse(order.orderedAt.slice(0, 16) + 'Z')) / 60000);
  const afterWait = Math.round((waits.reduce((total, wait) => total + wait, 0) + 25) / (waits.length + 1) * 10) / 10;
  expect(count('orders.missing.count')).toBe(1);
  expect(count('orders.open.count')).toBe(3);
  expect(missingTask()).toBeTruthy();
  const before = simpleReply({ source, text: '오늘 누락된 주문 있어?', locale: 'ko', layer: 'management' });
  expect(before.panels).toEqual([]);
  expect(before.answer).toContain(`#${missing.orderNo}`);
  const observations: unknown[] = [];
  const off = data.subscribe(() => observations.push([count('orders.missing.count'), run.getState().pos.orders.find(o => o.orderId === missing.orderId)?.preparation]));
  const command = { type: 'order.complete' as const, orderId: missing.orderId, meta: { runId: run.getState().runId, idempotencyKey: 'finish-missing' } };
  const completed = runtime.execute(command);
  expect(completed.ok).toBe(true);
  expect(observations).toEqual([[0, 'completed']]);
  expect(runtime.execute(command)).toMatchObject({ ok: true, duplicate: true });
  expect(count('orders.missing.count')).toBe(0);
  expect(count('orders.avgWait.minutes')).toBe(afterWait);
  expect(missingTask()).toBeUndefined();
  const after = simpleReply({ source, text: '오늘 누락된 주문 있어?', locale: 'ko', layer: 'management' });
  expect(after.panels).toEqual([]); expect(after.answer).not.toContain(`#${missing.orderNo}`);
  // The real provider still posts source=pos while rejecting an invented order-status widget.
  let posted: unknown;
  const provider = createAssistantProvider({ source, fetcher: async (_url, init) => { posted = JSON.parse(String(init?.body)); return replyResponse({ answer: '누락 의심 주문이 없어요.', panels: [{ featureId: 'ledger', size: { width: 1, height: 1 }, reason: '주문' }] }); } });
  expect((await provider.ask({ text: '누락 주문', signal: new AbortController().signal })).panels).toEqual([]);
  expect(posted).toMatchObject({ snapshot: expect.arrayContaining([expect.objectContaining({ sourceId: 'pos', candidateAllowed: false })]) });
  expect(completed.ok && completed.undoToken && runtime.undo(completed.undoToken)).toMatchObject({ ok: true });
  expect(count('orders.missing.count')).toBe(1); expect(missingTask()).toBeTruthy();
  expect(completed.ok && completed.undoToken && runtime.undo(completed.undoToken)).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
  off(); runtime.dispose(); run.dispose();
});

// Wrong meta guards, deadline handling or command routing must not change order state.
it('status commands validate revisions, retain paused undo and restore the original preparation state', () => {
  vi.useFakeTimers();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => Date.now() });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: sessionGateFor(run), pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const runtime = orderStatusRuntime(createSessionActions(run, data).pos);
  const [missing, preparing, accepted, closed] = run.getState().pos.orders;
  let serial = 0;
  const meta = () => ({ runId: run.getState().runId, idempotencyKey: `state:${++serial}` });
  try {
    expect(runtime.execute({ type: 'order.start', orderId: accepted.orderId, meta: { ...meta(), expectedPosRevision: 99 } })).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    const started = runtime.execute({ type: 'order.start', orderId: accepted.orderId, meta: meta() });
    expect(started).toMatchObject({ ok: true });
    runtime.pauseStatusUndo('focus', true); vi.advanceTimersByTime(7000);
    expect(started.ok && started.undoToken && runtime.undo(started.undoToken)).toMatchObject({ ok: true });
    expect(run.getState().pos.orders.find(order => order.orderId === accepted.orderId)?.preparation).toBe('accepted');
    const hidden = runtime.execute({ type: 'order.complete', orderId: missing.orderId, meta: meta() });
    run.actions.setPageHidden(true); vi.advanceTimersByTime(7000); run.actions.setPageHidden(false);
    expect(hidden.ok && hidden.undoToken && runtime.undo(hidden.undoToken)).toMatchObject({ ok: true });
    const completed = runtime.execute({ type: 'order.complete', orderId: preparing.orderId, meta: meta() });
    expect(completed).toMatchObject({ ok: true });
    expect(runtime.execute({ type: 'order.complete', orderId: preparing.orderId, meta: meta() })).toMatchObject({ ok: false, reason: 'NOT_OPEN' });
    vi.advanceTimersByTime(6001);
    expect(completed.ok && completed.undoToken && runtime.undo(completed.undoToken)).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
    expect(runtime.execute({ type: 'order.reopen', orderId: preparing.orderId, meta: meta() })).toMatchObject({ ok: true });
    expect(run.getState().pos.orders.find(order => order.orderId === preparing.orderId)?.preparation).toBe('preparing');
    expect(runtime.execute({ type: 'order.reopen', orderId: closed.orderId, meta: meta() })).toMatchObject({ ok: false, reason: 'NOT_REOPENABLE' });
  } finally { runtime.dispose(); run.dispose(); vi.useRealTimers(); }
});

// Completing a reservation must not remove its party from today's reservation totals.
it('reservation briefing counts completed attendance while preserving café reservation and party totals', () => {
  const baseline = createWidgetDataStore().getSnapshot();
  const target = selectReservations(baseline, { date: TODAY }).rows.find(row => row.status === 'confirmed')!;
  const before = selectBriefing(baseline, { date: TODAY }).reservations;
  const completed = createWidgetDataStore({ reservation: baseline.tables.reservation.map(row => row.reservationId === target.reservationId ? { ...row, status: 'completed' } : row) });
  expect(selectBriefing(completed.getSnapshot(), { date: TODAY }).reservations).toMatchObject({
    completedCount: before.completedCount + 1, count: before.count, partyTotal: before.partyTotal,
  });
});

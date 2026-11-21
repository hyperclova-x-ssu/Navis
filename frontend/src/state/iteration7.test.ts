import { describe, expect, it } from 'vitest';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { testTime } from '../layout/test-policy';
import { createRunStore } from './index';
import { createTableLayout } from '../layout/table-layout';
import type { RunSessionInput } from '../contracts';

describe('detail presentation preference (API-279)', () => {
  it('starts off, changes only presentation and resets with a new run', () => {
    const context = { screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light' as const };
    const run = createRunStore({ ...context, time: testTime, clock: () => 0 });
    const before = run.getState();
    expect(before.detailDialogFullscreen).toBe(false);
    run.actions.setDetailDialogFullscreen(true);
    const after = run.getState();
    expect(after.detailDialogFullscreen).toBe(true);
    expect(after.overlay).toBe(before.overlay);
    expect(after.boards).toBe(before.boards);
    expect(after.layoutRevision).toBe(before.layoutRevision);
    run.actions.setDetailDialogFullscreen(false);
    expect(run.getState().detailDialogFullscreen).toBe(false);
    run.actions.setDetailDialogFullscreen(true);
    run.actions.resetRun(context);
    expect(run.getState().detailDialogFullscreen).toBe(false);
    run.dispose();
  });
});

it('keeps anonymous eligibility in the run and resets it atomically on order, link and source changes', () => {
  let now = 0;
  const context = { screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light' as const };
  const run = createRunStore({ ...context, time: testTime, clock: () => now });
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
  run.actions.saveOnboardingTables(createTableLayout());
  expect(run.actions.startEmpty()).toBe(true);
  const commit = (input: RunSessionInput) => {
    const s = run.getState();
    const prepared = run.session.prepare({ transactionId: `test:${s.runRevision}`, runId: s.runId, expectedDataRevision: 0, expectedRunRevision: s.runRevision, transitionToken: s.transitionToken }, input);
    if (!prepared.ok) throw new Error(prepared.reason);
    run.session.publish(prepared.change); run.session.flush(prepared.change.transactionId);
  };
  commit({ type: 'update-settings', settings: { ...run.getState().shopSettings, revision: run.getState().shopSettings.revision + 1, cctvPosLinks: [{ zoneId: 'zone-a', tableId: 'T1' }] } });
  run.actions.reconcileLinkedOccupancy({ activeZoneIds: ['zone-a'], elapsedNow: 0 });
  now = 120_000; // The first source observation can arrive well after run creation.
  run.actions.observeLinkedOccupancy({ zoneId: 'zone-a', state: 'occupied', observedAt: '2026-10-26T15:40:00', elapsedNow: 0 });
  const boards = run.getState().boards;
  now = 720_001; run.actions.tick();
  expect(run.getState().linkedOccupancy.seatedWithoutOrder).toEqual([{ zoneId: 'zone-a', tableId: 'T1', since: 120_000 }]);
  expect(run.getState().linkedOccupancy.elapsedNow).toBe(720_001);
  expect(run.getState().boards).toBe(boards);
  const s = run.getState();
  const openBill = { ...s.pos.bills[0], billId: 'linked-test', tableId: 'T1', status: 'open' as const };
  commit({ type: 'pos.commit', expectedPosRevision: s.posRevision, nextPos: { ...s.pos, revision: s.posRevision + 1, bills: [...s.pos.bills, openBill] }, nextUi: s.posUi });
  expect(run.getState().linkedOccupancy.seatedWithoutOrder).toEqual([]);
  const ordered = run.getState();
  commit({ type: 'pos.commit', expectedPosRevision: ordered.posRevision, nextPos: { ...ordered.pos, revision: ordered.posRevision + 1, bills: ordered.pos.bills.filter(b => b.billId !== 'linked-test') }, nextUi: ordered.posUi });
  expect(run.getState().linkedOccupancy.seatedWithoutOrder[0]?.since).toBe(720_001);
  run.actions.reconcileLinkedOccupancy({ activeZoneIds: [], elapsedNow: 720_001 });
  expect(run.getState().linkedOccupancy).toMatchObject({ observations: [], seatedWithoutOrder: [] });
  run.actions.resetRun(context);
  expect(run.getState().linkedOccupancy).toEqual({ observations: [], seatedWithoutOrder: [], elapsedNow: 0 });
  run.dispose();
});

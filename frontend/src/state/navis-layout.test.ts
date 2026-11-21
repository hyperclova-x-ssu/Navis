// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getRegistry } from '../catalog';
import type { Panel } from '../contracts';
import { screenPresets, samePanels } from '../layout';
import { testTime } from '../layout/test-policy';
import { createRunStore } from './index';
import { planNavisLayout, readNavisBoard } from './navis-layout';
import { completeEmptyOnboarding } from './test-fixtures';

export const templatePanels: readonly Panel[] = [
  { featureId: 'briefing', column: 0, row: 0, width: 2, height: 2 },
  { featureId: 'ledger', column: 2, row: 0, width: 2, height: 1 },
  { featureId: 'margin', column: 2, row: 1, width: 2, height: 1 },
  { featureId: 'calendar', column: 4, row: 0, width: 2, height: 2 },
  { featureId: 'inventory-booking', column: 0, row: 2, width: 2, height: 1 },
  { featureId: 'menu', column: 2, row: 2, width: 2, height: 1 },
];

function setup(panels = templatePanels) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light', time: testTime, clock: () => 0 });
  completeEmptyOnboarding(run);
  if (panels.length) run.actions.applyLayoutIntent({ type: 'restore', panels });
  return run;
}

function board(run: ReturnType<typeof setup>) {
  return run.getState().boards.management;
}

describe('Navis layout plan and receipt', () => {
  it('projects the actual open cells and computes push-aside without publishing', () => {
    const run = setup();
    const before = run.getState();
    expect(readNavisBoard(before, 'management', 0)).toMatchObject({ free: 8, columns: 6, rows: 4, pageCount: 1 });
    const result = planNavisLayout(before, 'management', [
      { kind: 'layout', page: 0, intent: { type: 'resize', featureId: 'inventory-booking', width: 3, height: 1 } },
    ]);
    expect(result).toMatchObject({ kind: 'ready', plan: { displaced: ['menu'] } });
    expect(run.getState()).toBe(before);
  });

  it('publishes an arbitrary page move once and restores both pages with the receipt', () => {
    const run = setup();
    for (let index = 1; index < 5; index++) expect(run.actions.addPage()).toMatchObject({ ok: true });
    run.actions.goToPage(0);
    const before = run.getState();
    const result = planNavisLayout(before, 'management', [
      { kind: 'transfer', page: 0, destinationPage: 4, featureId: 'inventory-booking' },
    ], 4);
    if (result.kind !== 'ready') throw new Error(result.kind);
    const published: number[] = [];
    run.subscribe(state => published.push(state.layoutRevision));
    expect(run.actions.commitNavisLayout(result.plan).status).toBe('accepted');
    expect(published).toEqual([before.layoutRevision + 1]);
    expect(board(run)).toMatchObject({ currentPage: 4, pages: [{ panels: expect.not.arrayContaining([expect.objectContaining({ featureId: 'inventory-booking' })]) }, { panels: [] }, { panels: [] }, { panels: [] }, { panels: [{ featureId: 'inventory-booking', column: 0, row: 2 }] }] });
    expect(run.actions.commitNavisLayout(result.plan).code).toBe('STALE_REVISION');
    const token = board(run).notice?.undoToken;
    expect(token).toBeTruthy();
    expect(run.actions.undo(token!).status).toBe('accepted');
    expect(samePanels(board(run).pages[0].panels, templatePanels)).toBe(true);
    expect(board(run).pages[4].panels).toEqual([]);
    expect(run.actions.undo(token!).code).toBe('UNDO_UNAVAILABLE');
  });

  it('undoes all layout steps and retains an appended page', () => {
    const run = setup();
    const result = planNavisLayout(run.getState(), 'management', [
      { kind: 'append' },
      { kind: 'transfer', page: 0, destinationPage: 1, featureId: 'inventory-booking' },
      { kind: 'layout', page: 0, intent: { type: 'resize', featureId: 'briefing', width: 1, height: 1 } },
    ], 1);
    if (result.kind !== 'ready') throw new Error(result.kind);
    expect(run.actions.commitNavisLayout(result.plan).status).toBe('accepted');
    expect(board(run).pages[1].panels).toHaveLength(1);
    expect(run.actions.undo(board(run).undo!.token).status).toBe('accepted');
    expect(board(run).pages).toHaveLength(2);
    expect(board(run).pages[1].panels).toEqual([]);
    expect(samePanels(board(run).pages[0].panels, templatePanels)).toBe(true);
  });

  it('rejects the whole plan when a later step lacks a valid destination', () => {
    const run = setup();
    const before = run.getState();
    const result = planNavisLayout(before, 'management', [
      { kind: 'layout', page: 0, intent: { type: 'remove', featureId: 'margin' } },
      { kind: 'transfer', page: 0, destinationPage: 1, featureId: 'inventory-booking' },
    ]);
    expect(result).toMatchObject({ kind: 'invalid', code: 'NO_NEIGHBOR_PAGE' });
    expect(run.getState()).toBe(before);
  });

  it('leaves both board views in place when adding to an explicit other-layer page', () => {
    const run = setup();
    const before = run.getState();
    const result = planNavisLayout(before, 'marketing', [
      { kind: 'layout', page: 0, intent: { type: 'add-tap', featureId: 'coupon-status' } },
    ]);
    if (result.kind !== 'ready') throw new Error(result.kind);
    expect(run.actions.commitNavisLayout(result.plan).status).toBe('accepted');
    expect(run.getState().activeBoard).toBe('management');
    expect(run.getState().boards.management).toBe(before.boards.management);
    expect(run.getState().boards.marketing.pages[0].panels[0]).toMatchObject({ featureId: 'coupon-status', column: 0, row: 0 });
    expect(run.getState().boards.marketing.notice).toBeNull();
  });

  it('rejects a prepared plan in a detail dialog and while it exits', () => {
    const run = setup();
    const result = planNavisLayout(run.getState(), 'management', [
      { kind: 'layout', page: 0, intent: { type: 'remove', featureId: 'margin' } },
    ]);
    if (result.kind !== 'ready') throw new Error(result.kind);
    expect(run.actions.openDetail('margin', 'margin-detail')).toBe(true);
    const before = run.getState();
    expect(run.actions.commitNavisLayout(result.plan)).toMatchObject({ status: 'rejected', code: 'CANCELLED' });
    expect(run.getState()).toBe(before);
    const token = run.actions.closeOverlay();
    expect(token).toBeTruthy();
    expect(run.actions.commitNavisLayout(result.plan)).toMatchObject({ status: 'rejected', code: 'CANCELLED' });
    run.actions.finishOverlayExit(token!);
    expect(run.actions.commitNavisLayout(result.plan).status).toBe('accepted');
  });
});

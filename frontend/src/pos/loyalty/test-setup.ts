import { afterEach, expect } from 'vitest';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { testTime } from '../../layout/test-policy';
import { createRunStore } from '../../state';
import { createWidgetDataStore } from '../../data/widget-data';
import { createSessionActions, createSessionGate } from '../../app/session-actions';

const disposals: (() => void)[] = [];
afterEach(() => disposals.splice(0).forEach(dispose => dispose()));
export function setup(paymentStyle: 'prepaid' | 'postpaid' = 'prepaid') {
  const gate = createSessionGate();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => 0, theme: 'light', sessionGate: gate });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: gate, pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data, gate), pos = actions.pos;
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle });
  if (run.getState().onboarding.step === 'tables') run.actions.skipOnboardingTables();
  expect(actions.completeOnboarding(null).ok).toBe(true);
  run.actions.skipWidgetCoaches();
  disposals.push(() => { pos.dispose(); run.dispose(); });
  let sequence = 0;
  const meta = (key = `loyalty-${++sequence}`) => ({ runId: run.getState().runId, idempotencyKey: key });
  const add = (menuId = 'm-americano', qty = 1) => pos.execute({ type: 'cart.add', menuId, qty, optionIds: ['m-americano', 'm-latte', 'm-vanilla'].includes(menuId) ? [`${menuId}:temperature:ice`] : [], meta: meta() });
  const finish = (outcome: 'approved' | 'failed' = 'approved') => {
    const attempt = pos.read().posUi.approval!;
    return pos.finishApproval({ runId: pos.read().runId, attemptId: attempt.attemptId, expectedQuoteFingerprint: attempt.quoteFingerprint, outcome });
  };
  return { run, data, actions, pos, meta, add, finish };
}

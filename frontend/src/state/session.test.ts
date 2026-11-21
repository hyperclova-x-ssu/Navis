import { describe, expect, it } from 'vitest';
import type { PreparedChange, RunSessionInput, SessionGate, SessionTransaction } from '../contracts';
import { createRunStore } from './index';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout/presets';
import { testTime } from '../layout/test-policy';

function setup(gate?: SessionGate) {
  let time = 0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => time, theme: 'light', sessionGate: gate });
  run.actions.chooseBusiness('cafe'); run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  const tx = (): SessionTransaction => ({ transactionId: 'test-transaction', runId: run.getState().runId, expectedDataRevision: 0, expectedRunRevision: run.getState().runRevision, transitionToken: run.getState().transitionToken });
  return { run, tx, advance: (ms: number) => { time += ms; run.actions.tick(); } };
}
const empty: RunSessionInput = { type: 'complete-onboarding', templateId: null };
function ticket(result: ReturnType<ReturnType<typeof createRunStore>['session']['prepare']>): PreparedChange {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.change;
}

describe('API-212 run prepare / publish / flush', () => {
  it('준비와 abort는 snapshot·통지·revision에 영향이 없고 publish는 통지를 보류한다', () => {
    const { run, tx } = setup();
    let notifications = 0;
    run.subscribe(() => notifications++);
    const before = run.getState();
    const discarded = ticket(run.session.prepare(tx(), empty));
    expect(run.getState()).toBe(before); expect(notifications).toBe(0);
    run.session.abort(discarded);
    expect(run.session.isCurrent(discarded)).toBe(false);
    run.session.publish(discarded);
    expect(run.getState()).toBe(before);
    const change = ticket(run.session.prepare(tx(), empty));
    expect(run.session.isCurrent(change)).toBe(true);
    run.session.publish(change);
    expect(run.getState()).toMatchObject({ screen: 'dashboard', transactionId: 'test-transaction', businessType: 'cafe', runRevision: before.runRevision + 1 });
    expect(notifications).toBe(0);
    run.session.flush('wrong-transaction'); expect(notifications).toBe(0);
    run.session.flush(change.transactionId); expect(notifications).toBe(1);
    run.session.flush(change.transactionId); expect(notifications).toBe(1);
  });

  it('stale run/revision/전환 token과 중복 ticket을 거절한다', () => {
    const { run, tx } = setup();
    const before = run.getState();
    for (const bad of [{ ...tx(), runId: 'old-run' }, { ...tx(), expectedRunRevision: -1 }, { ...tx(), transitionToken: 'old-token' }]) {
      expect(run.session.prepare(bad, empty)).toMatchObject({ ok: false, code: 'CONFLICT' });
      expect(run.getState()).toBe(before);
    }
    const change = ticket(run.session.prepare(tx(), empty));
    run.actions.selectStartTemplate('B');
    expect(run.session.isCurrent(change)).toBe(false);
    const atStart = run.getState(); run.session.publish(change);
    expect(run.getState()).toBe(atStart);
    const current = ticket(run.session.prepare(tx(), empty));
    run.session.publish(current); run.session.flush(current.transactionId);
    const committed = run.getState();
    run.session.publish(current); run.session.flush(current.transactionId);
    expect(run.getState()).toBe(committed);
  });

  it('flush 중 모든 RunAction 쓰기를 거절하고 구독자 예외 뒤에도 다음 구독자에게 알린다', () => {
    const gate: { phase: SessionGate['phase']; transactionId: string | null } = { phase: 'idle', transactionId: null };
    const { run, tx } = setup(gate);
    gate.phase = 'preparing'; gate.transactionId = 'test-transaction';
    const change = ticket(run.session.prepare(tx(), empty));
    gate.phase = 'publishing'; run.session.publish(change);
    const committed = run.getState();
    let later = 0,attempts:unknown=null;
    run.subscribe(() => {
      if(gate.phase !== 'flushing') return;
      attempts=[run.actions.switchLayer('marketing'),run.actions.startEmpty(),run.actions.setLocale('en')];
      run.actions.setTheme('dark'); run.actions.tick(); run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'dark' });
      throw new Error('예시 구독자 오류');
    });
    run.subscribe(() => later++);
    gate.phase = 'flushing';
    expect(() => run.session.flush(change.transactionId)).not.toThrow();
    expect(attempts).toEqual([false,false,false]);
    expect(later).toBe(1); expect(run.getState()).toBe(committed);
    gate.phase = 'idle'; gate.transactionId = null;
    expect(run.actions.switchLayer('marketing')).toBe(true);
  });

  it('두 snapshot을 먼저 publish한 뒤 첫 구독자부터 같은 transaction을 읽는다',()=>{
    const {run,tx}=setup();
    let companion={transactionId:null as string|null,revision:0},firstObserved:unknown=null;
    const change=ticket(run.session.prepare(tx(),empty));
    run.subscribe(state=>{firstObserved=[state.transactionId,companion.transactionId,state.businessType,companion.revision];});
    companion={transactionId:change.transactionId,revision:1};
    run.session.publish(change);
    expect(firstObserved).toBeNull();
    run.session.flush(change.transactionId);
    expect(firstObserved).toEqual(['test-transaction','test-transaction','cafe',1]);
  });

  it('설정 거울 갱신은 두 보드·페이지·안내·undo를 보존하고 완료 후 업종 액션으로 바꾸지 않는다', () => {
    const { run, tx, advance } = setup(); run.actions.startEmpty();
    run.actions.visualSettled(); advance(400); run.actions.dismissCoach();
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'}); run.actions.visualSettled();
    run.actions.addPage(); run.actions.switchLayer('marketing');
    run.actions.startWithPreset(); run.actions.visualSettled();
    const before = run.getState();
    const change = ticket(run.session.prepare(tx(), { type: 'update-settings', settings: { ...before.shopSettings, businessType: 'retail', paymentStyle: 'postpaid', revision: before.shopSettings.revision + 1 } }));
    run.session.publish(change); run.session.flush(change.transactionId);
    expect(run.getState().businessType).toBe('retail');
    expect(run.getState().boards).toBe(before.boards);
    expect(run.getState().onboarding).toBe(before.onboarding);
    expect(run.getState().layoutRevision).toBe(before.layoutRevision);
    const committed = run.getState(); run.actions.chooseBusiness('beauty');
    expect(run.getState()).toBe(committed);
  });
});

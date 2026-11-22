import { describe, expect, it } from 'vitest';
import { createRunStore } from './index';
import { screenPresets } from '../layout/presets';
import { testTime } from '../layout/test-policy';
import { getRegistry } from '../catalog';

const setup = () => {
  let time = 0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => time, theme: 'light' });
  return { run, advance: (ms: number) => { time += ms; run.actions.tick(); } };
};
const start = (run: ReturnType<typeof createRunStore>) => {
  run.actions.chooseBusiness('cafe');
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
};

describe('반복 5 온보딩 초안과 단계 경계', () => {
  it('완료 전 초안만 바꾸고 이전 이동과 꺼진 테이블 단계를 처리한다', () => {
    const { run } = setup();
    expect(run.getState().onboarding).toMatchObject({ step: 'business', selectedTemplateId: null, applyToken: null });
    run.actions.chooseBusiness('cafe');
    expect(run.getState()).toMatchObject({ screen: 'business-question', businessType: null, onboarding: { step: 'payment', draft: { businessType: 'cafe', paymentStyle: null } } });
    run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
    expect(run.getState().onboarding.step).toBe('start');
    run.actions.onboardingBack();
    expect(run.getState().onboarding.step).toBe('payment');
    run.actions.onboardingBack();
    expect(run.getState().onboarding).toMatchObject({ step: 'business', draft: { businessType: 'cafe', paymentStyle: 'prepaid' } });
    run.actions.skipBusiness();
    run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
    expect(run.getState().onboarding.step).toBe('start');
    expect(run.getState().businessType).toBeNull();
  });

  it('켜진 테이블 초안을 보관하고 다음에 선택은 배치 없이 진행한다', () => {
    const { run } = setup();
    run.actions.chooseBusiness('cafe');
    run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
    const tables = run.getState().onboarding.draft.tableLayout!;
    expect(tables.tables.map(t => t.seats)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 6]);
    expect(run.actions.saveOnboardingTables({ ...tables, tables: tables.tables.map((t, i) => i === 0 ? { ...t, seats: 3 } : t) })).toBe(true);
    run.actions.onboardingBack();
    expect(run.getState().onboarding.step).toBe('tables');
    expect(run.getState().onboarding.draft.tableLayout!.tables[0].seats).toBe(3);
    expect(run.actions.skipOnboardingTables()).toBe(true);
    expect(run.getState().onboarding).toMatchObject({ step: 'start', draft: { tableLayout: null } });
  });

  it('현재 단계에 맞지 않는 답과 잘못된 배치는 snapshot과 revision을 바꾸지 않는다', () => {
    const { run } = setup();
    const first = run.getState();
    expect(run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' })).toBe(false);
    expect(run.actions.startEmpty()).toBe(false);
    expect(run.getState()).toBe(first);
    run.actions.chooseBusiness('cafe');
    run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
    const before = run.getState(), layout = before.onboarding.draft.tableLayout!;
    expect(run.actions.saveOnboardingTables({ ...layout, tables: [{ ...layout.tables[0], seats: 0 }] })).toBe(false);
    expect(run.getState()).toBe(before);
    run.actions.skipOnboardingTables();
    const atStart = run.getState();
    expect(run.actions.skipOnboardingTables()).toBe(false);
    run.actions.chooseBusiness('retail');
    expect(run.getState()).toBe(atStart);
  });

  it('빈 시작은 투어 없이 F-03과 업종별 시작 3개를 유지하고 재시작은 초안을 지운다', () => {
    const { run, advance } = setup();
    start(run);
    expect(run.actions.startEmpty()).toBe(true);
    expect(run.getState()).toMatchObject({ screen: 'dashboard', businessType: 'cafe', onboarding: { step: 'done' }, templateTour: null, layoutRevision: 0 });
    expect(run.actions.startEmpty()).toBe(false);
    run.actions.visualSettled(); advance(400);
    expect(run.getState().guidance.active).toBe('choose-feature');
    run.actions.dismissCoach();
    expect(run.actions.startWithThree().status).toBe('accepted');
    expect(run.getState().panels.map(p => p.featureId)).toEqual(['ledger', 'margin', 'calendar']);
    const id = run.getState().runId;
    run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light' });
    expect(run.getState().runId).not.toBe(id);
    expect(run.getState()).toMatchObject({ screen: 'business-question', businessType: null, onboarding: { step: 'business', draft: { businessType: null, paymentStyle: null, tableLayout: null }, selectedTemplateId: null, applyToken: null }, templateTour: null });
  });

  it('테이블 다음에 뒤 이전은 편집 가능한 기본 초안을 다시 보여 준다',()=>{
    const {run}=setup();run.actions.chooseBusiness('cafe');run.actions.setOnboardingAnswer({paymentStyle:'postpaid'});
    run.actions.skipOnboardingTables();run.actions.onboardingBack();
    expect(run.getState().onboarding.step).toBe('tables');
    expect(run.getState().onboarding.draft.tableLayout!.tables.reduce((sum,t)=>sum+t.seats,0)).toBe(30);
  });

  it('낡은 화면 완료 콜백은 새 전환과 새 실행을 준비 완료로 바꾸지 않는다',()=>{
    const {run}=setup();const first=run.getState();
    start(run);run.actions.startEmpty();
    const dashboard=run.getState();
    run.actions.visualSettled({runId:first.runId,transitionToken:first.transitionToken});
    expect(run.getState()).toBe(dashboard);
    run.actions.visualSettled({runId:dashboard.runId,transitionToken:dashboard.transitionToken});
    expect(run.getState().guidance.dashboardReady).toBe(true);
    run.actions.resetRun({screenPreset:screenPresets.A,catalog:getRegistry('A'),theme:'light'});
    const fresh=run.getState();
    run.actions.visualSettled({runId:dashboard.runId,transitionToken:dashboard.transitionToken});
    expect(run.getState()).toBe(fresh);
  });
});

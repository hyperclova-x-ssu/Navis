import { completeEmptyOnboarding } from './test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunStore, attachRunTimers, selectCommonNotice } from './index';
import { screenPresets } from '../layout/presets';
import { getRegistry } from '../catalog';
import { testTime as timePolicy } from '../layout/test-policy';

afterEach(() => vi.useRealTimers());
const setup = () => createRunStore({ screenPreset: screenPresets.B, catalog: getRegistry('B'), time: timePolicy, theme: 'light', clock: () => Date.now() });

describe('timer notifications (RV-CORE-1)', () => {
  it('starts the template tour no earlier than 400ms and within one timer step with a fractional delay', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let offset = 0;
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => Date.now() + offset });
    run.actions.chooseBusiness('cafe'); run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
    run.actions.applyManagementTemplate('A');
    const { runId, onboarding } = run.getState();
    run.actions.templateAssembled({ runId, applyToken: onboarding.applyToken! });
    offset = 0.4;
    const starts: number[] = [];
    const unsubscribe = run.subscribe(state => { if (state.templateTour?.status === 'active') starts.push(Date.now() + offset); });
    const delays: number[] = [];
    const stop = attachRunTimers(run, { schedule: (fn, delay) => { delays.push(delay); return setTimeout(fn, Math.trunc(delay)); }, cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) });
    expect(delays[0]).toBe(400);
    vi.advanceTimersByTime(399);
    expect(run.getState().templateTour?.status).toBe('waiting');
    vi.advanceTimersByTime(1);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeGreaterThanOrEqual(400);
    expect(starts[0]).toBeLessThan(401);
    stop(); unsubscribe(); run.dispose();
  });

  it('does not publish an early tick whose only change would be notice remaining time', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let clock = 0;
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => clock });
    run.actions.chooseBusiness('cafe'); run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
    run.actions.applyManagementTemplate('A');
    const { runId, onboarding } = run.getState();
    run.actions.templateAssembled({ runId, applyToken: onboarding.applyToken! });
    const before = run.getState(); const listener = vi.fn(); const unsubscribe = run.subscribe(listener);
    expect(before.templateTour?.status).toBe('waiting');
    expect(selectCommonNotice(before)).not.toBeNull();
    clock = 399.6; run.actions.tick();
    expect(run.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    clock = 400; run.actions.tick();
    expect(run.getState().templateTour?.status).toBe('active');
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(1600);
    unsubscribe(); run.dispose();
  });

  it('preserves the six-second common notice through overlapping pauses and resumes', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const run = setup(); completeEmptyOnboarding(run, 'cafe');
    const stop = attachRunTimers(run, { schedule: (fn, delay) => setTimeout(fn, delay), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) });
    run.actions.showNotice({ kind: 'success', messageKey: 'work.result' });
    vi.advanceTimersByTime(1000); run.actions.pauseUndo('toast-focus');
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(5000);
    run.actions.setPageHidden(true); run.actions.resumeUndo('toast-focus');
    vi.advanceTimersByTime(10000);
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(5000);
    run.actions.setPageHidden(false);
    vi.advanceTimersByTime(4999); expect(selectCommonNotice(run.getState())).not.toBeNull();
    run.actions.pauseUndo('toast-focus'); expect(selectCommonNotice(run.getState())?.remainingMs).toBe(1);
    vi.advanceTimersByTime(1000); run.actions.resumeUndo('toast-focus');
    vi.advanceTimersByTime(1); expect(selectCommonNotice(run.getState())).toBeNull();
    stop(); run.dispose();
  });

  it('keeps four-second board errors and two-second edit completion notices', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const run = setup(); completeEmptyOnboarding(run, 'cafe');
    const stop = attachRunTimers(run, { schedule: (fn, delay) => setTimeout(fn, delay), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) });
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'ai-response' });
    expect(run.getState().notice?.messageKey).toBe('other-layer');
    vi.advanceTimersByTime(3999); expect(run.getState().notice).not.toBeNull();
    vi.advanceTimersByTime(1); expect(run.getState().notice).toBeNull();
    run.actions.enterEditing(); run.actions.finishEditing();
    expect(run.getState().notice).toBeNull();
    stop(); run.dispose();
  });

  it.each(['coach-queue','edit','undo','notice','settings','drawer','detail','hidden','input'] as const)('keeps no-op ticks stable while blocked by %s (RV-FIX-3)', blocker => {
    vi.useFakeTimers();vi.setSystemTime(0);
    const run=setup(),a=run.actions;completeEmptyOnboarding(run, 'cafe');a.visualSettled();
    vi.setSystemTime(400);a.tick();a.dismissCoach();a.startWithThree();a.visualSettled();
    vi.setSystemTime(600);a.tick();
    if(blocker==='edit')a.enterEditing();
    if(blocker==='settings')a.openSettings();
    if(blocker==='drawer')a.openDrawer('money');
    if(blocker==='detail')a.openDetail('ledger','panel-ledger');
    if(blocker==='hidden')a.setPageHidden(true);
    if(blocker==='input')a.inputStarted({kind:'pointer',id:1});
    if(blocker==='undo')a.pauseUndo('toast-focus');
    if(blocker==='notice')a.applyLayoutIntent({type:'add-tap',featureId:'ledger'});
    const before=run.getState();let notifications=0;const stop=run.subscribe(()=>notifications++);
    for(let i=0;i<100;i++){vi.setSystemTime(600+i);a.tick();}
    expect(run.getState()).toBe(before);expect(notifications).toBe(0);stop();run.dispose();
  });
  it('reschedules an early timer even when its tick has no state transition', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const run = setup(); completeEmptyOnboarding(run, 'cafe'); run.actions.visualSettled();
    const pending: { fn: () => void; delay: number }[] = [];
    const stop = attachRunTimers(run, { schedule: (fn, delay) => pending.push({ fn, delay }), cancel: () => {} });
    expect(pending[0].delay).toBe(400);
    vi.setSystemTime(350); pending[0].fn();
    expect(pending.at(-1)!.delay).toBe(50);
    vi.setSystemTime(400); pending.at(-1)!.fn();
    expect(run.getState().guidance.active).toBe('choose-feature');
    stop();
  });
  it('keeps the state object and subscribers unchanged for ticks with no transition', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const run = setup(); const before = run.getState(); const listener = vi.fn();
    const unsubscribe = run.subscribe(listener);
    for (let i = 0; i < 100; i++) { vi.setSystemTime(i); run.actions.tick(); }
    expect(run.getState()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not schedule a blocked coach repeatedly and resumes its queue after dismissal', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const run = setup();
    const schedule = vi.fn((fn: () => void, delay: number) => setTimeout(fn, delay));
    const stop = attachRunTimers(run, { schedule, cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) });
    completeEmptyOnboarding(run, 'cafe'); run.actions.visualSettled();
    vi.advanceTimersByTime(timePolicy.coachFirstMs); run.actions.dismissCoach();
    run.actions.startWithThree(); run.actions.visualSettled();
    vi.advanceTimersByTime(timePolicy.coachGapMs);
    expect(run.getState().guidance.active).toBe('move-panel');
    expect(run.getState().guidance.queue).toEqual(['resize-panel']);
    const listener = vi.fn(); const unsubscribe = run.subscribe(listener); schedule.mockClear();
    vi.advanceTimersByTime(1000);
    expect(listener.mock.calls.length).toBeLessThanOrEqual(1);
    expect(schedule.mock.calls.length).toBeLessThanOrEqual(1);
    run.actions.dismissCoach();run.actions.enterEditing(); vi.advanceTimersByTime(timePolicy.coachGapMs);
    expect(run.getState().guidance.active).toBe('resize-panel');
    unsubscribe(); stop();
  });
});

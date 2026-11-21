import { completeEmptyOnboarding, updateSettingsForTest } from './test-fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CoachStep, FeatureId, Panel } from '../contracts';
import { createRunStore, attachRunTimers } from './index';
import { testTime } from '../layout/test-policy';
import { screenPresets } from '../layout/presets';
import { getRegistry } from '../catalog';
describe.each(['A','B'] as const)('%s run semantics',presetId=>{
let now=0;
const setup=()=>createRunStore({screenPreset:screenPresets[presetId],catalog:getRegistry(presetId),time:testTime,clock:()=>now,theme:'light'});
const pointer={kind:'pointer',id:1} as const;
const key={kind:'keyboard',id:'Enter'} as const;
let run:ReturnType<typeof setup>;
const advance=(ms:number)=>{now+=ms;run.actions.tick();};
function enter(){completeEmptyOnboarding(run, 'cafe');run.actions.visualSettled();advance(400);}
function finishCoaching(){
  enter();run.actions.dismissCoach();run.actions.startWithThree();run.actions.visualSettled();advance(200);
  // F-03 resize/move steps, then one explanation per started widget (F-21): dismiss each as it appears.
  run.actions.skipWidgetCoaches();advance(200);
  run.actions.clearNotice();run.actions.finishEditing();
}
beforeEach(()=>{now=0;run=setup();});
describe('run boundary and atomic layout state',()=>{
  it('creates a new empty memory run, keeps settings changes independent, resets on revisit',()=>{
    const first=run.getState().runId;
    expect(run.getState()).toMatchObject({screen:'business-question',panels:[],businessType:null,layoutRevision:0,undo:null});
    enter();run.actions.startWithThree();
    const before=run.getState();
    updateSettingsForTest(run, 'fitness');run.actions.setTheme('dark');run.actions.setTextScale(125);run.actions.setReducedMotion(true);
    expect(run.getState().panels).toEqual(before.panels);expect(run.getState().guidance).toEqual(before.guidance);
    run.actions.resetRun({screenPreset:screenPresets[presetId],catalog:getRegistry(presetId),theme:'light'});expect(run.getState().runId).not.toBe(first);expect(run.getState().panels).toEqual([]);
    expect(setup().getState().runId).not.toBe(run.getState().runId);
  });
  it('handles start repetition atomically and preserves both panel milestones in FIFO',()=>{
    enter();run.actions.dismissCoach();
    expect(run.actions.startWithThree().status).toBe('accepted');
    const s=run.getState();expect(s.starter).toBe('running');expect(s.panels).toHaveLength(3);
    expect(run.actions.startWithThree().status).toBe('unchanged');expect(run.getState().layoutRevision).toBe(1);
    expect(run.getState().guidance.queue).toEqual(['move-panel','resize-panel']);
    advance(1000);expect(run.getState().guidance.active).toBe(null);
    run.actions.visualSettled();expect(run.getState().starter).toBe('completed');
    expect(run.getState().guidance.active).toBe('move-panel');
    run.actions.dismissCoach();run.actions.enterEditing();advance(199);expect(run.getState().guidance.active).toBe(null);
    advance(1);expect(run.getState().guidance.active).toBe('resize-panel');
  });
  it('preserves confirmed panels and revision on duplicate, unsupported size and capacity failure',()=>{
    const a=run.actions;
    a.applyLayoutIntent({type:'add-tap',featureId:'ledger'});
    let before=run.getState();
    expect(a.applyLayoutIntent({type:'add-tap',featureId:'ledger'})).toMatchObject({status:'unchanged',code:'DUPLICATE',highlightFeatureId:'ledger'});
    expect(run.getState().panels).toEqual(before.panels);expect(run.getState().layoutRevision).toBe(before.layoutRevision);
    expect(a.applyLayoutIntent({type:'resize',featureId:'ledger',width:0,height:4}).code).toBe('INVALID_SIZE');
    const full:readonly Panel[]=[{featureId:'margin',column:0,row:0,width:4,height:4},{featureId:'members',column:4,row:0,width:presetId==='A'?2:4,height:4},...(presetId==='B'?[{featureId:'calendar' as const,column:0,row:4,width:4,height:1},{featureId:'ledger' as const,column:4,row:4,width:4,height:1}]:[])];
    a.applyLayoutIntent({type:'restore',panels:full});before=run.getState();
    expect(a.applyLayoutIntent({type:'add-tap',featureId:'tax'}).code).toBe('NO_CAPACITY');
    expect(run.getState().panels).toEqual(before.panels);expect(run.getState().layoutRevision).toBe(before.layoutRevision);
    expect(run.getState().notice?.kind).toBe('error');expect(run.getState().undo).toBe(null);
  });
  it('preview is noncommitting, outside/cancel roll back and gesture tokens commit at most once',()=>{
    const a=run.actions;a.applyLayoutIntent({type:'add-tap',featureId:'ledger'});const before=run.getState();
    let token=a.beginPreview({source:'drawer',pointerId:1,intent:{type:'add-tap',featureId:'calendar'}})!;
    expect(run.getState().panels).toEqual(before.panels);
    expect(a.commitPreview(token,false).code).toBe('OUTSIDE_GRID');expect(run.getState().panels).toEqual(before.panels);
    token=a.beginPreview({source:'panel',pointerId:1,intent:{type:'move',featureId:'ledger',column:0,row:0}})!;
    a.cancelPreview(token);expect(run.getState().layoutRevision).toBe(before.layoutRevision);
    token=a.beginPreview({source:'drawer',pointerId:1,intent:{type:'add-tap',featureId:'calendar'}})!;
    expect(a.beginPreview({source:'drawer',pointerId:2,intent:{type:'add-tap',featureId:'tax'}})).toBe(null);
    expect(a.commitPreview(token).status).toBe('accepted');expect(a.commitPreview(token).status).not.toBe('accepted');
    expect(run.getState().panels).toHaveLength(2);
  });
  it('retains the drawer visual exit while the same drag continues',()=>{
    enter();run.actions.openDrawer('recommended');
    const token=run.actions.beginPreview({source:'drawer',pointerId:1,intent:{type:'add-tap',featureId:'ledger'}})!;
    expect(run.getState().overlay.type).toBe('none');
    expect(run.getState().exitingOverlay?.type).toBe('drawer');
    expect(run.getState().exitPendingToken).not.toBe(null);
    expect(run.getState().gesturePreview?.token).toBe(token);
    expect(run.actions.commitPreview(token).status).toBe('accepted');
  });
  it('commits exactly the successful preview, and consumes caller-provided gesture tokens',()=>{
    const a=run.actions;
    const request={source:'drawer',pointerId:1,token:'one-drag',intent:{type:'add-tap',featureId:'ledger'}} as const;
    const token=a.beginPreview(request)!;
    const candidate=a.updatePreview(token,{type:'add-tap',featureId:'ledger'});
    const committed=a.commitPreview(token);
    expect(committed.panels).toEqual(candidate.panels);expect(committed.displacements).toEqual(candidate.displacements);
    expect(a.beginPreview(request)).toBe(null);
  });
  it('stale previews never overwrite a newer confirmed change',()=>{
    const a=run.actions;const token=a.beginPreview({source:'drawer',pointerId:1,intent:{type:'add-tap',featureId:'ledger'}})!;
    a.applyLayoutIntent({type:'add-tap',featureId:'calendar'});
    expect(a.commitPreview(token).status).toBe('rejected');expect(run.getState().panels.map(p=>p.featureId)).toEqual(['calendar']);
  });
  it('restores feature, priority and size once without rewinding guidance/business/theme',()=>{
    enter();const a=run.actions;
    const snapshot:readonly Panel[]=[{featureId:'calendar',column:0,row:0,width:2,height:2},{featureId:'ledger',column:3,row:2,width:1,height:1},{featureId:'margin',column:4,row:0,width:2,height:1}];
    a.applyLayoutIntent({type:'restore',panels:snapshot});a.visualSettled();a.dismissCoach();
    a.applyLayoutIntent({type:'remove',featureId:'ledger'});const token=run.getState().undo!.token;
    updateSettingsForTest(run, 'beauty');a.setTheme('dark');const guidance=run.getState().guidance;
    expect(a.undo(token).status).toBe('accepted');expect(run.getState().panels).toEqual(snapshot);
    expect(run.getState()).toMatchObject({businessType:'beauty',theme:'dark'});expect(run.getState().guidance.coach).toEqual(guidance.coach);
    const revision=run.getState().layoutRevision;
    expect(a.undo(token).code).toBe('UNDO_UNAVAILABLE');expect(run.getState().layoutRevision).toBe(revision);
  });
  it('replaces undo on a successful resize and leaves milestone progress intact after starting again',()=>{
    enter();run.actions.startWithThree();const token=run.getState().undo!.token;
    run.actions.applyLayoutIntent({type:'resize',featureId:'calendar',width:2,height:1});
    expect(run.actions.undo(token).code).toBe('UNDO_UNAVAILABLE');
    run.actions.applyLayoutIntent({type:'restore',panels:[]});run.actions.visualSettled();
    expect(run.getState().starter).toBe('ready');run.actions.startWithThree();
    const milestones=run.getState().guidance.panelMilestones;
    run.actions.undo(run.getState().undo!.token);expect(run.getState().panels).toEqual([]);
    expect(run.getState().guidance.panelMilestones).toEqual(milestones);
  });
});
describe('interaction edge cases',()=>{
  it('preserves the first hint across onboarding input and consumes it once in the dashboard',()=>{
    run.actions.inputStarted(pointer);run.actions.inputEnded(pointer);enter();
    expect(run.getState().guidance.firstHintSeen).toBe(false);
    expect(run.actions.markFirstHintSeen()).toBe(false);advance(200);
    expect(run.actions.markFirstHintSeen()).toBe(true);expect(run.actions.markFirstHintSeen()).toBe(false);
  });
  it('consumes repeated keydown and concurrent input throughout a wake sequence',()=>{
    finishCoaching();advance(1200);const out=run.actions.closeOverlay()!;run.actions.finishOverlayExit(out);advance(30000);
    expect(run.actions.inputStarted(key)).toBe(true);expect(run.actions.inputStarted(key)).toBe(true);
    expect(run.actions.inputStarted({kind:'keyboard',id:'Space'})).toBe(true);
    expect(run.actions.applyLayoutIntent({type:'add-tap',featureId:'tax'}).code).toBe('CANCELLED');
    expect(run.actions.inputEnded(key)).toBe(true);expect(run.actions.inputStarted(key)).toBe(false);
  });
  it('rejects an out-of-grid resize without changing any panel or revision',()=>{
    const a=run.actions;
    a.applyLayoutIntent({type:'restore',panels:[{featureId:'margin',column:5,row:3,width:1,height:1}]});
    const before=run.getState();
    expect(a.applyLayoutIntent({type:'resize',featureId:'margin',width:4,height:4}).code).toBe('OUTSIDE_GRID');
    expect(run.getState().panels).toEqual(before.panels);expect(run.getState().layoutRevision).toBe(before.layoutRevision);
  });
  it('does not enter idle while a pointer is held, a page is hidden, or a notice is visible',()=>{
    finishCoaching();advance(1200);const out=run.actions.closeOverlay()!;run.actions.finishOverlayExit(out);
    run.actions.inputStarted(pointer);advance(60000);expect(run.getState().idle.mode).toBe('active');
    run.actions.inputEnded(pointer);advance(29999);expect(run.getState().idle.mode).toBe('active');
    run.actions.setPageHidden(true);advance(60000);expect(run.getState().idle.mode).toBe('active');
    run.actions.setPageHidden(false);run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});advance(799);
    expect(run.getState().notice).not.toBe(null);expect(run.getState().idle.mode).toBe('active');
    advance(1);advance(29999);expect(run.getState().idle.mode).toBe('active');advance(1);expect(run.getState().idle.mode).toBe('idle');
  });
});
describe('single state-owned undo deadline',()=>{
  it('pauses for focus, touch and hidden page, and resumes only after every reason clears',()=>{
    const a=run.actions;a.applyLayoutIntent({type:'add-tap',featureId:'ledger'});const token=run.getState().undo!.token;
    advance(2000);a.pauseUndo('toast-focus');a.pauseUndo('toast-touch');a.setPageHidden(true);
    advance(60000);expect(run.getState().undo?.remainingMs).toBe(4000);
    a.resumeUndo('toast-focus');a.resumeUndo('toast-touch');advance(10000);expect(run.getState().undo).not.toBe(null);
    a.setPageHidden(false);advance(3999);expect(a.undo(token).status).toBe('accepted');
  });
  it('expires exactly at deadline and old tokens cannot undo a subsequent action',()=>{
    const a=run.actions;a.applyLayoutIntent({type:'add-tap',featureId:'ledger'});const old=run.getState().undo!.token;
    a.applyLayoutIntent({type:'add-tap',featureId:'calendar'});expect(a.undo(old).code).toBe('UNDO_UNAVAILABLE');
    const token=run.getState().undo!.token;advance(6000);expect(a.undo(token).code).toBe('UNDO_UNAVAILABLE');expect(run.getState().panels).toHaveLength(2);
  });
});
describe('safe guidance, briefing and idle coordination',()=>{
  it('shows one coach, waits for settled visual/input and reanchors after removal',()=>{
    enter();expect(run.getState().guidance.active).toBe('choose-feature');
    run.actions.openDrawer('recommended');expect(run.getState().guidance.coach['choose-feature']).toBe('dismissed');
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'tax'});run.actions.inputStarted(pointer);const exit=run.actions.closeOverlay('drag-start')!;run.actions.visualSettled();advance(1000);run.actions.finishOverlayExit(exit);
    expect(run.getState().guidance.active).toBe(null);run.actions.inputEnded(pointer);expect(run.getState().guidance.active).toBe('move-panel');
    run.actions.applyLayoutIntent({type:'remove',featureId:'tax'});expect(run.getState().guidance.active).toBe(null);
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'calendar'});run.actions.visualSettled();advance(200);
    expect(run.getState().guidance.targetFeatureId).toBe('calendar');
  });
  it('waits for every blocker and uninterrupted safe time before one briefing',()=>{
    finishCoaching();const a=run.actions;
    expect(run.getState().guidance.coach).toEqual({'choose-feature':'dismissed','resize-panel':'dismissed','move-panel':'dismissed'});
    advance(1000);a.openSettings();advance(10000);expect(run.getState().briefing).toBe('pending');
    const exit=a.closeOverlay()!;advance(10000);expect(run.getState().briefing).toBe('pending');expect(run.getState().idle.blockedReasons).toContain('overlay-exit');
    a.finishOverlayExit('stale');expect(run.getState().exitPendingToken).toBe(exit);
    a.finishOverlayExit(exit);advance(1199);expect(run.getState().briefing).toBe('pending');advance(1);expect(run.getState().overlay.type).toBe('briefing');
    const panels=run.getState().panels;const out=a.closeOverlay()!;a.finishOverlayExit(out);advance(100000);
    expect(run.getState().briefing).toBe('dismissed');expect(run.getState().panels).toEqual(panels);
  });
  it('does not start idle time while editing, input, notices, hidden pages or visual exit block',()=>{
    finishCoaching();advance(1200);const exit=run.actions.closeOverlay()!;run.actions.finishOverlayExit(exit);
    run.actions.enterEditing();advance(60000);expect(run.getState().idle.mode).toBe('active');run.actions.finishEditing();run.actions.clearNotice();
    advance(29999);expect(run.getState().idle.mode).toBe('active');advance(1);expect(run.getState().idle.mode).toBe('idle');
  });
  it.each([pointer,key])('consumes the entire first wake sequence %j and permits the next input',input=>{
    finishCoaching();advance(1200);const out=run.actions.closeOverlay()!;run.actions.finishOverlayExit(out);advance(30000);
    expect(run.getState().idle.mode).toBe('idle');
    expect(run.actions.inputStarted(input)).toBe(true);expect(run.getState().idle.mode).toBe('active');
    expect(run.actions.consumeInput(input,'move')).toBe(true);expect(run.actions.inputEnded(input)).toBe(true);
    expect(run.actions.consumeInput(input,'click')).toBe(true);
    expect(run.actions.inputStarted(input)).toBe(false);expect(run.actions.inputEnded(input)).toBe(false);
  });
  it('consumes detail close input while permitting fresh reverse/open and ignores stale exit callbacks',()=>{
    enter();run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});run.actions.applyLayoutIntent({type:'add-tap',featureId:'calendar'});
    run.actions.openDetail('ledger','panel-ledger');const exit=run.actions.closeOverlay('outside',pointer)!;
    expect(run.getState().overlay.type).toBe('none');expect(run.getState().exitPendingToken).toBe(exit);
    expect(run.actions.openDetail('calendar','panel-calendar')).toBe(false);
    expect(run.actions.inputEnded(pointer)).toBe(true);expect(run.actions.consumeInput(pointer,'click')).toBe(true);
    run.actions.inputStarted(pointer);expect(run.actions.openDetail('ledger','panel-ledger')).toBe(true);
    run.actions.finishOverlayExit(exit);expect(run.getState().overlay.type).toBe('detail');
    run.actions.closeOverlay();run.actions.inputStarted({kind:'pointer',id:2});expect(run.actions.openDetail('calendar','panel-calendar')).toBe(true);
    expect(run.getState().exitPendingToken).toBe(null);
  });
  it('never rewinds coaches or briefing when panels are removed/undone',()=>{
    finishCoaching();advance(1200);const exit=run.actions.closeOverlay()!;run.actions.finishOverlayExit(exit);
    const before=run.getState().guidance.coach;
    for(const featureId of run.getState().panels.map(p=>p.featureId))run.actions.applyLayoutIntent({type:'remove',featureId});
    run.actions.undo(run.getState().undo!.token);run.actions.visualSettled();advance(100000);
    expect(run.getState().guidance.coach).toEqual(before);expect(run.getState().briefing).toBe('dismissed');
  });
  it('uses a cancellable injected scheduler for state deadlines and disposes it',()=>{
    let callback:(()=>void)|undefined;let cancelled=0;
    const stop=attachRunTimers(run,{schedule:fn=>{callback=fn;return 1;},cancel:()=>{cancelled++;}});
    completeEmptyOnboarding(run, null);run.actions.visualSettled();expect(callback).toBeDefined();now=400;callback!();
    expect(run.getState().guidance.active).toBe('choose-feature');run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});stop();expect(cancelled).toBeGreaterThan(0);
  });
});
});
// Compile-time consumer examples keep stable public identifier types visible to following tasks.
const _types: readonly [CoachStep,FeatureId] = ['resize-panel','ledger'];
void _types;

it('shows arrival briefing while resize guidance waits for editing',()=>{
 let now=0;const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:testTime,clock:()=>now,theme:'light'});
 const tick=(ms:number)=>{now+=ms;run.actions.tick();};completeEmptyOnboarding(run,'cafe');run.actions.visualSettled();tick(400);run.actions.dismissCoach();run.actions.startWithThree();run.actions.visualSettled();tick(200);
 expect(run.getState().guidance.active).toBe('move-panel');run.actions.dismissCoach();tick(200);
 for(let i=0;i<6;i++){if(run.getState().guidance.activeWidget)run.actions.dismissCoach();tick(200);}
 expect(run.getState().guidance.coach['resize-panel']).toBe('queued');tick(6000);tick(1200);expect(run.getState().briefing).toBe('visible');
});

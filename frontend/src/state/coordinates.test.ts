import { completeEmptyOnboarding } from './test-fixtures';
import { describe,expect,it } from 'vitest';
import { createRunStore } from './index';
import { screenPresets } from '../layout/presets';
import { preview } from '../layout';
import { getRegistry } from '../catalog';
import { testTime } from '../layout/test-policy';
import type { LayoutAdapter,LayoutWorkerRequest,LayoutWorkerResponse,Panel } from '../contracts';
function setup(presetId:'A'|'B'='B'){
  let now=0;const requests:{request:LayoutWorkerRequest;receive:(r:LayoutWorkerResponse)=>void}[]=[];
  const adapter:LayoutAdapter={ready:()=>Promise.resolve(),submit:(request,receive)=>requests.push({request,receive}),cancel:()=>{},dispose:()=>{}};
  const run=createRunStore({screenPreset:screenPresets[presetId],catalog:getRegistry(presetId),time:testTime,theme:'light',clock:()=>now,layoutAdapter:adapter});
  const answer=(index:number)=>{const {request,receive}=requests[index];receive({...request,result:preview(request.beforePanels,request.intent,screenPresets[presetId].grid,getRegistry(presetId))});};
  return {run,requests,answer,advance:(ms:number)=>{now+=ms;run.actions.tick();}};
}
const p=(featureId:Panel['featureId'],column:number,row:number,width=1,height=1):Panel=>({featureId,column,row,width,height});
describe.each(['A','B'] as const)('%s coordinate store',preset=>{
  it('discards an older candidate after a newer request and never compounds a previous preview',()=>{
    const {run,answer,requests}=setup(preset),a=run.actions;
    const before=[p('ledger',1,1),p('calendar',3,1),p('tax',4,1)];a.applyLayoutIntent({type:'restore',panels:before});
    const token=a.beginPreview({source:'panel',pointerId:7,intent:{type:'move',featureId:'calendar',column:1,row:1}})!;
    answer(0);expect(run.getState().gesturePreview?.candidatePanels).toContainEqual(p('ledger',1,0));
    a.updatePreview(token,{type:'move',featureId:'calendar',column:4,row:1});
    expect(requests[1].request.beforePanels).toEqual(before);expect(run.getState().gesturePreview?.candidatePanels).toEqual(before);
    answer(0);expect(run.getState().gesturePreview?.status).toBe('pending');
    a.commitPreview(token);answer(1);
    expect(run.getState().panels).toContainEqual(p('ledger',1,1));expect(run.getState().panels).toContainEqual(p('calendar',4,1));
  });
  it('keeps the snapshot when Worker computation fails and blocks finishing a pending release',()=>{
    const {run,requests}=setup(preset),a=run.actions;
    a.applyLayoutIntent({type:'add-drop',featureId:'ledger',column:1,row:1});const before=run.getState();
    const token=a.beginPreview({source:'drawer',pointerId:7,intent:{type:'add-drop',featureId:'margin',column:1,row:1}})!;
    a.commitPreview(token);expect(a.finishEditing()).toBe(false);expect(run.getState().idle.blockedReasons).toContain('layout-pending');
    expect(a.openSettings()).toBe(false);expect(a.openDrawer('money')).toBe(false);
    const {request,receive}=requests[0];receive({...request,result:{status:'rejected',valid:false,code:'INTERNAL_LAYOUT_ERROR',panels:before.panels,displacements:[],usedCells:1,remainingCells:screenPresets[preset].grid.columns*screenPresets[preset].grid.rows-1}});
    expect(run.getState().panels).toEqual(before.panels);expect(run.getState().layoutRevision).toBe(before.layoutRevision);expect(run.getState().undo).toBe(before.undo);
    expect(run.getState().notice).toMatchObject({kind:'error',messageKey:'INTERNAL_LAYOUT_ERROR'});expect(run.getState().gesturePreview).toBeNull();
  });
  it('gives move, resize, push-aside and remove one exact snapshot undo each',()=>{
    const {run,answer,requests}=setup(preset);const a=run.actions;
    const before=[p('ledger',1,1),p('calendar',2,1),p('tax',5,3)];
    a.applyLayoutIntent({type:'restore',panels:before});
    for(const intent of [{type:'move',featureId:'ledger',column:2,row:1},{type:'resize',featureId:'ledger',width:2,height:1},{type:'remove',featureId:'ledger'}] as const){
      const revision=run.getState().layoutRevision;
      const result=a.applyLayoutIntent(intent);if(result.status==='pending')answer(requests.length-1);
      expect(run.getState().layoutRevision).toBe(revision+1);const token=run.getState().undo!.token;
      expect(a.undo(token).status).toBe('accepted');expect(run.getState().panels).toEqual(before);
      expect(a.undo(token).code).toBe('UNDO_UNAVAILABLE');
    }
  });
  it('keeps candidates based on the initial snapshot and defers release until the newest answer',()=>{
    const {run,answer,requests}=setup(preset);const a=run.actions;
    const before=[p('ledger',1,1),p('calendar',3,1)];a.applyLayoutIntent({type:'restore',panels:before});
    const revision=run.getState().layoutRevision;
    const token=a.beginPreview({source:'panel',pointerId:7,intent:{type:'move',featureId:'calendar',column:1,row:1}})!;
    expect(run.getState().gesturePreview?.status).toBe('pending');expect(run.getState().panels).toEqual(before);
    a.updatePreview(token,{type:'move',featureId:'calendar',column:1,row:1});expect(requests).toHaveLength(1);
    a.updatePreview(token,{type:'move',featureId:'calendar',column:1,row:1});
    expect(a.commitPreview(token).status).toBe('pending');expect(run.getState().gesturePreview?.pendingCommit).toBe(true);
    answer(0);expect(run.getState().layoutRevision).toBe(revision+1);expect(run.getState().panels).toContainEqual(p('calendar',1,1));
    expect(a.commitPreview(token).code).toBe('CANCELLED');expect(run.getState().layoutRevision).toBe(revision+1);
    a.undo(run.getState().undo!.token);expect(run.getState().panels).toEqual(before);
  });
  it('discards stale identity, cancels a pending release on new input or viewport and keeps undo',()=>{
    const {run,answer,requests}=setup(preset);const a=run.actions;
    a.applyLayoutIntent({type:'add-drop',featureId:'ledger',column:1,row:1});const previousUndo=run.getState().undo;const previousPanels=run.getState().panels;
    const token=a.beginPreview({source:'drawer',pointerId:7,intent:{type:'add-drop',featureId:'margin',column:1,row:1}})!;
    const active=requests[0];active.receive({...active.request,runId:'old',result:preview(active.request.beforePanels,active.request.intent,screenPresets[preset].grid,getRegistry(preset))});
    expect(run.getState().gesturePreview?.status).toBe('pending');
    a.commitPreview(token);a.inputStarted({kind:'pointer',id:8});answer(0);
    expect(run.getState().panels).toEqual(previousPanels);expect(run.getState().undo).toBe(previousUndo);
    a.inputEnded({kind:'pointer',id:8});
    const next=a.beginPreview({source:'drawer',pointerId:9,intent:{type:'add-drop',featureId:'margin',column:1,row:1}})!;
    a.commitPreview(next);a.cancelPreviewForViewportChange();answer(1);
    expect(run.getState().panels).toEqual(previousPanels);expect(a.consumeInput({kind:'pointer',id:9},'click')).toBe(true);
  });
});
it('unchanged/failed/cancelled attempts preserve the prior undo and notice identity',()=>{
  const {run}=setup();const a=run.actions;a.applyLayoutIntent({type:'add-drop',featureId:'ledger',column:3,row:2});
  const undo=run.getState().undo,notice=run.getState().notice;
  expect(a.applyLayoutIntent({type:'move',featureId:'ledger',column:3,row:2}).status).toBe('unchanged');
  expect(run.getState().undo).toBe(undo);expect(run.getState().notice).toBe(notice);
  a.applyLayoutIntent({type:'resize',featureId:'ledger',width:4,height:4});expect(run.getState().undo).toBe(undo);
});
it('failed preview guard does not complete the active coach',()=>{
  let now=0;const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:testTime,theme:'light',clock:()=>now,previewGuard:()=>false});
  const a=run.actions;completeEmptyOnboarding(run, 'cafe');a.visualSettled();now=400;a.tick();a.dismissCoach();a.startWithThree();a.visualSettled();now=600;a.tick();
  expect(run.getState().guidance.active).toBe('move-panel');a.dismissCoach();a.enterEditing();now=800;a.tick();
  expect(run.getState().guidance.active).toBe('resize-panel');
  expect(a.beginPreview({source:'resize',pointerId:1,intent:{type:'resize',featureId:'ledger',width:2,height:1}})).toBeNull();
  expect(a.coachedAction('resize-panel')).toBe(false);expect(run.getState().guidance.active).toBe('resize-panel');
});
it('rejects the B geometric failure after pending release, retains undo, and restores the exact 25-cell source',()=>{
  const {run,answer}=setup('B'),a=run.actions;
  const original=[p('ledger',0,0,4,4),p('margin',4,1),p('calendar',5,0,1,4),p('members',6,0,1,4)];
  a.applyLayoutIntent({type:'restore',panels:original});
  a.applyLayoutIntent({type:'move',featureId:'margin',column:4,row:0});const before=run.getState();
  expect(a.applyLayoutIntent({type:'resize',featureId:'margin',width:4,height:4}).status).toBe('pending');
  answer(0);expect(run.getState().notice?.messageKey).toBe('NO_CAPACITY');
  expect(run.getState().panels).toEqual(before.panels);expect(run.getState().undo).toBe(before.undo);expect(run.getState().layoutRevision).toBe(before.layoutRevision);
  a.undo(before.undo!.token);expect(run.getState().panels).toEqual(original);
});
it('disposes the Worker and makes old deadline callbacks inert',()=>{
  const {run,advance}=setup(),a=run.actions;completeEmptyOnboarding(run, 'cafe');a.visualSettled();
  const before=run.getState();run.dispose();advance(10000);
  expect(run.getState()).toBe(before);expect(run.nextDeadline()).toBeNull();
  a.resetRun({screenPreset:screenPresets.A,catalog:getRegistry('A'),theme:'dark'});expect(run.getState()).toBe(before);
});
it.each(['resolve','reject'] as const)('invalidates an old Worker startup %s when reset changes the run',async mode=>{
  let resolveReady:()=>void=()=>{},rejectReady:(error:Error)=>void=()=>{};
  const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const adapter:LayoutAdapter={ready:()=>ready,submit:()=>{},cancel:()=>{},dispose:()=>{}};
  const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:testTime,clock:()=>0,theme:'light',layoutAdapter:adapter});
  const pending=run.prepareLayout();run.actions.resetRun({screenPreset:screenPresets.B,catalog:getRegistry('B'),theme:'dark'});
  if(mode==='resolve')resolveReady();else rejectReady(new Error('old startup'));
  expect(await pending).toBe(false);expect(run.getState().notice).toBeNull();
});

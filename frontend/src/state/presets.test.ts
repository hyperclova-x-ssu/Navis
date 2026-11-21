import { completeEmptyOnboarding } from './test-fixtures';
import { describe, expect, it } from 'vitest';
import { createRunStore } from './index';
import { screenPresets, selectScreenPreset } from '../layout/presets';
import { getRegistry, getLayerCatalog } from '../catalog';
import { testTime } from '../layout/test-policy';
import type { Panel } from '../contracts';

describe.each(['A','B'] as const)('%s run context', presetId => {
  const make=()=>createRunStore({screenPreset:screenPresets[presetId],catalog:getRegistry(presetId),time:testTime,clock:()=>0,theme:'light'});
  it('uses its explicit catalog for all reads and rejects unknown ids',()=>{
    const catalog=getRegistry(presetId).filter(f=>f.id!=='tax');
    const run=createRunStore({screenPreset:screenPresets[presetId],catalog,time:testTime,clock:()=>0,theme:'light'});
    expect(run.actions.applyLayoutIntent({type:'add-tap',featureId:'tax'}).code).toBe('UNKNOWN_FEATURE');
    expect(run.actions.startWithThree().panels).toHaveLength(3);
    expect(run.catalog).toBe(catalog);expect(run.getState().screenPreset).toBe(screenPresets[presetId]);
  });
  it('keeps preset, revision, panels, undo and overlay when the viewport crosses selection boundaries', () => {
    const run=make();
    // Every management widget (16) on the management board: a dense committed state.
    const panels:readonly Panel[]=getLayerCatalog(presetId,'management').map((f,i)=>({featureId:f.id,column:i%screenPresets[presetId].grid.columns,row:Math.floor(i/screenPresets[presetId].grid.columns),width:1,height:1}));
    expect(run.actions.applyLayoutIntent({type:'restore',panels}).status).toBe('accepted');
    run.actions.applyLayoutIntent({type:'remove',featureId:panels[0].featureId});
    run.actions.openSettings();
    const before=run.getState();
    expect(selectScreenPreset({width:presetId==='A'?2560:1000,height:presetId==='A'?1440:600})).toBe(screenPresets[presetId==='A'?'B':'A']);
    run.actions.setTheme('dark');run.actions.setTextScale(125);run.actions.setReducedMotion(true);
    expect(run.getState()).toMatchObject({runId:before.runId,screenPreset:before.screenPreset,panels:before.panels,layoutRevision:before.layoutRevision,undo:before.undo,overlay:before.overlay,guidance:before.guidance});
    expect(run.actions.undo(before.undo!.token).panels).toEqual(panels);
  });
  it('cancels only an in-flight candidate on viewport change and consumes its remaining up/click', () => {
    const run=make();run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});
    const before=run.getState();
    run.actions.inputStarted({kind:'pointer',id:7});
    const token=run.actions.beginPreview({source:'resize',pointerId:7,intent:{type:'resize',featureId:'ledger',width:2,height:2}})!;
    run.actions.cancelPreviewForViewportChange();
    expect(run.getState()).toMatchObject({screenPreset:before.screenPreset,panels:before.panels,layoutRevision:before.layoutRevision,undo:before.undo,gesturePreview:null,edit:{mode:'edit',gesture:null}});
    expect(run.actions.commitPreview(token).code).toBe('CANCELLED');
    expect(run.actions.inputEnded({kind:'pointer',id:7})).toBe(true);
    expect(run.actions.consumeInput({kind:'pointer',id:7},'click')).toBe(true);
    expect(run.actions.inputStarted({kind:'pointer',id:8})).toBe(false);
    expect(run.actions.beginPreview({source:'panel',pointerId:8,intent:{type:'move',featureId:'ledger',column:0,row:0}})).not.toBeNull();
  });
  it('replaces preset/catalog and all run state atomically on a new run, invalidating old callbacks', () => {
    const run=make();completeEmptyOnboarding(run, 'cafe');run.actions.startWithThree();
    run.actions.openSettings();const oldExit=run.actions.closeOverlay()!;
    const old=run.getState();
    const next=presetId==='A'?'B':'A';
    const observed:string[]=[];
    const stop=run.subscribe(s=>observed.push(`${s.screenPreset.id}:${run.catalog[0].presetId}:${s.panels.length}`));
    run.actions.resetRun({screenPreset:screenPresets[next],catalog:getRegistry(next),theme:'dark',reducedMotion:true});
    expect(observed).toEqual([`${next}:${next}:0`]);
    expect(run.getState()).toMatchObject({screenPreset:screenPresets[next],screen:'business-question',panels:[],businessType:null,textScale:100,theme:'dark',reducedMotion:true,layoutRevision:0,undo:null,gesturePreview:null,overlay:{type:'none'},briefing:'pending'});
    expect(run.getState().runId).not.toBe(old.runId);
    run.actions.finishOverlayExit(oldExit);
    expect(run.actions.undo(old.undo!.token).code).toBe('UNDO_UNAVAILABLE');
    stop();
  });
  it('rejects mismatched preset/catalog before publishing or resetting a run', () => {
    const wrong=getRegistry(presetId==='A'?'B':'A');
    expect(()=>createRunStore({screenPreset:screenPresets[presetId],catalog:wrong,time:testTime,clock:()=>0,theme:'light'})).toThrow(/preset/i);
    const run=make();const before=run.getState();
    expect(()=>run.actions.resetRun({screenPreset:screenPresets[presetId],catalog:wrong,theme:'dark'})).toThrow(/preset/i);
    expect(run.getState()).toBe(before);
  });
});

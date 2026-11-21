import { describe, expect, it } from 'vitest';
import { createRunStore, selectCommonNotice, selectTemplateTour } from './index';
import { screenPresets } from '../layout/presets';
import { getRegistry } from '../catalog';
import { testTime } from '../layout/test-policy';

function setup() {
  let time = 0;
  const run = createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:testTime,clock:()=>time,theme:'light'});
  run.actions.chooseBusiness('cafe'); run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});
  return {run,advance:(ms:number)=>{time+=ms;run.actions.tick();}};
}

describe('템플릿 원자 배치와 독립 투어',()=>{
  it('관리 첫 페이지에 한 번 쓰고 중복·stale apply와 비어 있지 않은 다른 페이지를 거절한다',()=>{
    const {run}=setup();
    expect(run.actions.applyManagementTemplate('A', -1).code).toBe('STALE_REVISION');
    const before=run.getState();
    expect(run.actions.applyManagementTemplate('A').status).toBe('accepted');
    expect(run.getState().panels.map(p=>p.featureId)).toEqual(['briefing','ledger','margin','calendar','inventory-booking','menu']);
    expect(run.getState()).toMatchObject({layoutRevision:1,starter:'completed',undo:null,onboarding:{step:'applying',selectedTemplateId:'A'}});
    expect(run.getState().boards.marketing).toBe(before.boards.marketing);
    const applied=run.getState();
    expect(run.actions.applyManagementTemplate('A').status).toBe('rejected');
    expect(run.getState()).toBe(applied);
    const other=setup().run;
    other.actions.addPage(); other.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'}); other.actions.goToPage(0);
    const occupied=other.getState();
    expect(other.actions.applyManagementTemplate('A').status).toBe('rejected');
    expect(other.getState()).toBe(occupied);
  });

  it('완료 토스트 게시에서 정확히 400ms 뒤 투어를 열고 F-03 첫째·둘째 대상을 따른다',()=>{
    const {run,advance}=setup(); run.actions.applyManagementTemplate('A');
    run.actions.visualSettled();
    const {runId,onboarding}=run.getState();
    advance(1000);
    expect(run.getState().templateTour?.status).toBe('waiting');
    expect(run.getState().guidance.active).toBeNull();
    expect(run.actions.templateAssembled({runId,applyToken:onboarding.applyToken!})).toBe(true);
    const posted=run.getState(); expect(selectCommonNotice(posted)?.undo).toBeUndefined();
    expect(run.actions.templateAssembled({runId,applyToken:onboarding.applyToken!})).toBe(false);
    expect(run.getState()).toBe(posted);
    advance(399); expect(run.getState().templateTour?.status).toBe('waiting');
    advance(1); expect(run.getState().templateTour).toMatchObject({status:'active',index:0,readyAt:1400});
    expect(selectTemplateTour(run.getState())).toEqual({current:1,total:6,targetFeatureId:'briefing',coachKey:'widget.briefing.coach'});
    expect(run.getState().idle.mode).toBe('active');
    expect(run.actions.switchLayer('marketing')).toBe(false);
    expect(run.actions.openDrawer('recommended')).toBe(false);
    expect(run.actions.openClosing('closing')).toBe(false);
    expect(run.actions.goToPage(0)).toBe(false);
    expect(run.actions.nextTemplateTour()).toBe(true);
    expect(run.getState().templateTour?.index).toBe(1);
    expect(run.actions.closeTemplateTour()).toBe(true);
    expect(run.getState().guidance.widgetQueue).toEqual([]);
    for(const id of ['briefing','ledger','margin','calendar','inventory-booking','menu'] as const) expect(run.getState().guidance.widgetCoach[id]).toBe('dismissed');
    advance(400); expect(run.getState().guidance.active).toBe('choose-feature');
    run.actions.dismissCoach(); advance(200);
    expect(run.getState().guidance).toMatchObject({active:'move-panel',targetFeatureId:'briefing'});
    run.actions.dismissCoach();run.actions.enterEditing(); advance(200);
    expect(run.getState().guidance).toMatchObject({active:'resize-panel',targetFeatureId:'briefing'});
    run.actions.dismissCoach();run.actions.finishEditing(); run.actions.clearNotice(); advance(1200);
    expect(run.getState().briefing).toBe('visible');
    const exit=run.actions.closeOverlay()!; run.actions.finishOverlayExit(exit); advance(10000);
    expect(run.getState().briefing).toBe('dismissed');
  });

  it('템플릿 완료 알림은 공용 업무 알림과 별도로 2초 뒤 닫힌다',()=>{
    const {run,advance}=setup();run.actions.applyManagementTemplate('A');
    const {runId,onboarding}=run.getState();
    run.actions.templateAssembled({runId,applyToken:onboarding.applyToken!});
    advance(1999);expect(selectCommonNotice(run.getState())).not.toBeNull();
    advance(1);expect(selectCommonNotice(run.getState())).toBeNull();
  });

  it('old run/token 완료와 투어 밖 다음·닫기는 0변경이다',()=>{
    const {run}=setup(); run.actions.applyManagementTemplate('A');
    const old=run.getState(), token=old.onboarding.applyToken!;
    expect(run.actions.templateAssembled({runId:old.runId,applyToken:'wrong'})).toBe(false);
    expect(run.actions.nextTemplateTour()).toBe(false);
    expect(run.actions.closeTemplateTour()).toBe(false);
    expect(run.getState()).toBe(old);
    run.actions.resetRun({screenPreset:screenPresets.A,catalog:getRegistry('A'),theme:'light'});
    const fresh=run.getState();
    expect(run.actions.templateAssembled({runId:old.runId,applyToken:token})).toBe(false);
    expect(run.getState()).toBe(fresh);
  });

  it('viewport 변경은 같은 배치를 완료시키고 템플릿을 비워도 첫 시작·F-21 안내를 재생하지 않는다',()=>{
    const {run,advance}=setup();run.actions.applyManagementTemplate('A');
    const panels=run.getState().panels,revision=run.getState().layoutRevision;
    run.actions.cancelPreviewForViewportChange();
    expect(run.getState().onboarding.step).toBe('done');
    expect(run.getState().panels).toBe(panels);expect(run.getState().layoutRevision).toBe(revision);
    const completion=selectCommonNotice(run.getState())!.id;
    run.actions.cancelPreviewForViewportChange();
    expect(selectCommonNotice(run.getState())!.id).toBe(completion);
    advance(400);run.actions.closeTemplateTour();advance(400);run.actions.skipWidgetCoaches();
    for(const featureId of panels.map(p=>p.featureId))run.actions.applyLayoutIntent({type:'remove',featureId});
    expect(run.getState().starter).toBe('completed');
    expect(run.actions.startWithThree().status).toBe('unchanged');
    expect(run.actions.markFirstHintSeen()).toBe(false);
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'inventory-booking'});
    expect(run.getState().guidance.widgetQueue).toEqual([]);
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'suppliers'});
    expect(run.getState().guidance.widgetQueue).toEqual(['suppliers']);
  });
});

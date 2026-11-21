import { describe, expect, it } from 'vitest';
import type { DetailReturnState } from '../contracts';
import { createRunStore, selectCommonNotice, selectDetailReturn, selectDetailViewState } from './index';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout/presets';
import { testTime } from '../layout/test-policy';

function setup() {
  let time=0;
  const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:testTime,clock:()=>time,theme:'light'});
  run.actions.chooseBusiness('cafe');run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});run.actions.startEmpty();
  return {run,advance:(ms:number)=>{time+=ms;run.actions.tick();}};
}
const parent:DetailReturnState={ref:{featureId:'ledger',view:'expenses'},tab:'expenses',query:'우유',sort:{columnId:'amount',direction:'desc'},filters:{period:'today'},expandedRowIds:['e-1'],selectedRowId:'e-1',scrollTop:320,scrollLeft:48,focusKey:'row-e-1'};

describe('공용 마감 창과 출처 복귀',()=>{
  it('온보딩에서는 열리지 않고 세 레이어에서 편집·제스처를 끝내 같은 창을 연다',()=>{
    const {run}=setup();
    run.actions.resetRun({screenPreset:screenPresets.A,catalog:getRegistry('A'),theme:'light'});
    expect(run.actions.openClosing('closing')).toBe(false);
    run.actions.skipBusiness();run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});run.actions.startEmpty();
    for(const layer of ['orders-payment','marketing','management'] as const){
      expect(run.actions.switchLayer(layer)).toBe(true);
      expect(run.actions.openClosing('closing')).toBe(true);
      expect(run.getState().overlay).toEqual({type:'closing',returnFocusKey:'closing'});
      const exit=run.actions.closeOverlay('Esc')!;run.actions.finishOverlayExit(exit);
    }
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});
    run.actions.enterEditing();
    const token=run.actions.beginPreview({source:'panel',pointerId:1,intent:{type:'move',featureId:'ledger',column:1,row:0}})!;
    const panels=run.getState().panels;
    expect(run.actions.openClosing('closing')).toBe(true);
    expect(run.getState()).toMatchObject({edit:{mode:'view',gesture:null,selectedFeatureId:null},gesturePreview:null,overlay:{type:'closing'}});
    expect(run.getState().panels).toBe(panels);
    expect(run.actions.commitPreview(token).status).toBe('rejected');
  });

  it('상세 한 단계 연결과 마감에서 원래 표·탭·행·스크롤·focus로 돌아온다',()=>{
    const {run}=setup();
    expect(run.actions.openDetailRef(parent.ref,'panel-ledger')).toBe(true);
    expect(run.actions.rememberDetailState(parent)).toBe(true);
    expect(run.actions.openLinkedDetail({featureId:'suppliers',view:'orders'})).toBe(true);
    expect(selectDetailReturn(run.getState())).toEqual(parent);
    expect(run.actions.detailBack()).toBe(true);
    expect(selectDetailViewState(run.getState())).toEqual(parent);
    const source=run.getState();
    expect(run.actions.openClosing('ledger-closing')).toBe(true);
    expect(run.getState().overlay).toMatchObject({type:'closing',returnTo:parent});
    const input={kind:'keyboard',id:'Escape'} as const;
    run.actions.closeOverlay('Esc',input);
    expect(run.getState().overlay).toEqual(source.overlay);
    expect(selectDetailViewState(run.getState())).toEqual(parent);
    expect(run.getState().boards).toBe(source.boards);
    expect(run.actions.consumeInput(input,'click')).toBe(true);
    const exit=run.actions.closeOverlay()!;run.actions.finishOverlayExit(exit);
    expect(selectDetailViewState(run.getState())).toBeNull();
    expect(selectDetailReturn(run.getState())).toBeNull();
  });
});

describe('공용 notice와 보드 배치 undo의 독립 수명',()=>{
  it('마감 알림은 닫고 보드로 돌아가도 유지하고 hover/focus/숨김에 시간을 멈춘다',()=>{
    const {run,advance}=setup();
    run.actions.openClosing('closing');
    run.actions.showNotice({kind:'success',messageKey:'closing.done',undo:{target:'data',token:'close-token'}});
    const first=selectCommonNotice(run.getState())!;
    advance(1000);run.actions.closeOverlay();
    expect(selectCommonNotice(run.getState())?.id).toBe(first.id);
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(5000);
    run.actions.pauseUndo('toast-focus');advance(10000);
    expect(selectCommonNotice(run.getState())?.undo?.token).toBe('close-token');
    run.actions.setPageHidden(true);run.actions.resumeUndo('toast-focus');advance(10000);
    expect(selectCommonNotice(run.getState())?.id).toBe(first.id);
    run.actions.setPageHidden(false);advance(4999);
    expect(selectCommonNotice(run.getState())?.id).toBe(first.id);
    advance(1);expect(selectCommonNotice(run.getState())).toBeNull();
  });

  it.each(['success','complete','error'] as const)('undo 없는 %s 업무·마감 알림을 6초 동안 표시한다',kind=>{
    const {run,advance}=setup();
    run.actions.showNotice({kind,messageKey:'work.result'});
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(6000);
    advance(5999);expect(selectCommonNotice(run.getState())).not.toBeNull();
    advance(1);expect(selectCommonNotice(run.getState())).toBeNull();
  });

  it('undo 없는 공용 알림의 hover·focus와 숨김 정지는 남은 시간을 함께 보존한다',()=>{
    const {run,advance}=setup();run.actions.showNotice({kind:'complete',messageKey:'closing.undone'});
    advance(1000);run.actions.pauseUndo('toast-focus');
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(5000);
    advance(10000);
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(5000);
    run.actions.setPageHidden(true);run.actions.resumeUndo('toast-focus');
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(5000);
    advance(10000);
    expect(selectCommonNotice(run.getState())?.remainingMs).toBe(5000);
    run.actions.setPageHidden(false);advance(4999);
    expect(selectCommonNotice(run.getState())).not.toBeNull();
    advance(1);expect(selectCommonNotice(run.getState())).toBeNull();
  });

  it('보드 오류와 편집 완료 알림은 각각 4초와 2초를 유지한다',()=>{
    const {run,advance}=setup();
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'ai-response'});
    expect(run.getState().notice?.messageKey).toBe('other-layer');
    advance(3999);expect(run.getState().notice).not.toBeNull();
    advance(1);expect(run.getState().notice).toBeNull();
    run.actions.enterEditing();run.actions.finishEditing();
    expect(run.getState().notice).toBeNull();
  });

  it('닫기 예시 재시도는 해당 선택만 정상으로 돌리고 반복 선택은 0변경이다',()=>{
    const {run}=setup();run.actions.setPreviewFamily('error');run.actions.setPreviewVariant('ledger','no-sales');run.actions.setClosingPreview('no-payments');
    run.actions.resetClosingPreview();
    expect(run.getState().preview).toEqual({family:'error',overrides:{ledger:'no-sales'},closing:'normal'});
    const before=run.getState();run.actions.resetClosingPreview();
    expect(run.getState()).toBe(before);
  });

  it('숨긴 페이지에서 새로 게시한 undo 없는 공용 안내도 남은 시간을 보존한다',()=>{
    const {run,advance}=setup();run.actions.setPageHidden(true);
    run.actions.showNotice({kind:'complete',messageKey:'saved'});
    advance(20000);
    expect(selectCommonNotice(run.getState())).toMatchObject({remainingMs:6000,expiresAt:Infinity});
    run.actions.setPageHidden(false);advance(5999);
    expect(selectCommonNotice(run.getState())).not.toBeNull();
    advance(1);expect(selectCommonNotice(run.getState())).toBeNull();
  });

  it('공용 토스트가 보이는 동안 각 보드 layout undo를 보존하고 교체 뒤 남은 시간부터 재개한다',()=>{
    const {run,advance}=setup();
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});
    const layoutToken=run.getState().undo!.token,boardNotice=run.getState().notice!.id;
    advance(1000);
    run.actions.showNotice({kind:'success',messageKey:'closing.done',undo:{target:'data',token:'data-token'}});
    advance(20000); // Shell notice expires after six seconds; a late tick must resume the board at that deadline.
    expect(run.getState().undo).toBeNull();
    run.actions.applyLayoutIntent({type:'add-tap',featureId:'calendar'});
    const second=run.getState().undo!.token;
    advance(1000);run.actions.showNotice({kind:'success',messageKey:'closing.done',undo:{target:'data',token:'new-token'}});
    run.actions.pauseUndo('toast-focus');advance(20000);run.actions.setPageHidden(true);advance(20000);
    expect(run.getState().undo?.token).toBe(second);
    run.actions.setPageHidden(false);run.actions.resumeUndo('toast-focus');
    run.actions.clearNotice();
    expect(run.getState().notice?.id).not.toBe(boardNotice);
    expect(run.getState().undo?.token).toBe(second);
    advance(4999);expect(run.getState().undo?.token).toBe(second);
    advance(1);expect(run.getState().undo).toBeNull();
    expect(run.actions.undo(layoutToken).code).toBe('UNDO_UNAVAILABLE');
  });
});


it('dismisses the previous notice when another detail opens while preserving its undo token',()=>{
 const {run}=setup();run.actions.applyLayoutIntent({type:'add-tap',featureId:'ledger'});
 const token=run.getState().undo?.token;expect(run.getState().notice).not.toBeNull();
 expect(run.actions.openDetail('ledger','panel-ledger')).toBe(true);
 expect(run.getState().notice).toBeNull();expect(run.getState().undo?.token).toBe(token);
});

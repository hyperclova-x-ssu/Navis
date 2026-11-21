import { planCustomOrderCommand, planCustomSettlement, quoteCustomSettlement, planCustomReversal, quoteCustomReversal } from '../data/iteration7/custom-orders';
import type { CustomOrderCommand, CustomCommandValue, CustomPlanResult, CustomSettlementQuote, CustomReversalQuote, CustomMethodAllocation } from '../data/iteration7/custom-orders';
import { selectCustomOrderRead, applyCustomMoney } from '../data/pos/projection';
import { setCctvPosLink as planLink, pruneCctvPosLinks as pruneLinks } from '../data/iteration7/table-links';
import type { SetCctvPosLinkInput } from '../data/iteration7/table-links';
import { createContext, useContext } from 'react';
import type { ManagementTemplateId, PreparedChange, RunStore, SessionGate, SessionTransaction, ShopSettings } from '../contracts';
import { selectPosDataRead, tableLayoutEnabled } from '../data/widget-data';
import type { DataCommandResult, DataSessionInput, WidgetDataStore } from '../data/widget-data';
import type { PosCommandValue, PosDataRead, PosPlan, PosReadSnapshot, PosResult } from '../contracts/pos';
import { createPosRuntime, type PosRuntime } from '../pos/runtime';
import { canonical, freezePos, posFailure } from '../pos/domain/common';
import manifest from '../data/db/generated/manifest.json';
import { selectPosReservations } from '../data/derive/reservations';
import { normalizePosSettings } from '../pos/tables/preferences';
import { allocatePosAmount, distributePosAmount } from '../pos/domain/money';
import { businessNow } from '../pos/clock';
import { selectMoneyRead, applyMoneyPlanToPos, synchronizeCustomMoney } from '../data/pos/projection';
import { planBeginSettlementApproval, planFinishSettlementApproval, quoteSettlement as quoteMoneySettlement, quoteMoneyReversal, planMoneyReversal, planAbandonSettlement, planRecognizeCustomPickup, selectMoneyReceipt, planMembershipServiceDay, quoteMembershipUse } from '../data/iteration7/accounting';
import { getPaymentBillId } from '../pos/loyalty';
import { quotePosSettlement } from '../pos/domain/iteration7';
import type { MoneyRead, MoneyPlan, MoneyCompletion, MoneyState, SettlementQuote, SettlementTarget, SettlementAllocation, MoneyReversalQuote } from '../data/iteration7/accounting/types';
import { checkReversiblePickup } from '../data/commands/custom-order-guard'; // D-326.

type MutableGate = { phase: SessionGate['phase']; transactionId: string | null };
export const createSessionGate = (): MutableGate => ({ phase: 'idle', transactionId: null });
const gates = new WeakMap<RunStore, MutableGate>();
export function registerSessionGate(run: RunStore, gate: MutableGate) { gates.set(run, gate); }
export function sessionGateFor(run: RunStore): MutableGate {
  let gate = gates.get(run);
  if (!gate) { gate = createSessionGate(); gates.set(run, gate); }
  return gate;
}
export type SessionStamp = Omit<SessionTransaction, 'transactionId'>;
export type CustomCommandResult = Exclude<DataCommandResult,{readonly ok:true}> | (Extract<DataCommandResult,{readonly ok:true}> & {readonly value?:CustomCommandValue});
export interface CustomApprovalState {
  readonly status:'pending'|'succeeded'|'failed'; readonly runId:string; readonly attemptId:string;
  readonly quote:CustomSettlementQuote; readonly idempotencyKey:string; readonly generation:number;
  readonly result?:CustomCommandResult;
}
export interface CustomCoordinator {
  read():ReturnType<typeof selectCustomOrderRead>;
  subscribe(listener:()=>void):()=>void;
  dispatch(command:CustomOrderCommand):CustomCommandResult;
  approval():CustomApprovalState|null;
  quoteSettlement(input:{readonly customOrderId:string;readonly allocations:readonly CustomMethodAllocation[]}):CustomSettlementQuote;
  beginApproval(input:{readonly quote:CustomSettlementQuote;readonly idempotencyKey:string}):DataCommandResult;
  finishApproval(input:{readonly runId:string;readonly attemptId:string;readonly outcome:'approved'|'failed'}):CustomCommandResult;
  dismissApproval():boolean;
  quoteReversal(input:{readonly customOrderId:string;readonly kind:'cancellation'|'refund';readonly amount?:number}):CustomReversalQuote;
  reverse(input:{readonly quote:CustomReversalQuote;readonly idempotencyKey:string;readonly cancelOrder?:boolean}):CustomCommandResult;
}
export interface SessionActions {
  readonly money: MoneyCoordinator;
  readonly custom:CustomCoordinator;
  setCctvPosLink(input:SetCctvPosLinkInput,activeZoneIds:readonly string[]):DataCommandResult;
  pruneCctvPosLinks(activeZoneIds:readonly string[]):DataCommandResult;
  readonly pos: PosRuntime;
  commit(plan: PosPlan, expected: PosReadSnapshot): PosResult<PosCommandValue>;
  capture(): SessionStamp;
  completeOnboarding(templateId: ManagementTemplateId | null, expected?: SessionStamp): DataCommandResult;
  updateSettings(settings: ShopSettings, expected?: SessionStamp): DataCommandResult;
}
const conflict = (reason: string): DataCommandResult => ({ ok: false, code: 'CONFLICT', reason, messageKey: 'run.session.conflict' });
/** API-212: every validation is finished before the two silent reference swaps. */
export function createSessionActions(run: RunStore, data: WidgetDataStore, gate = sessionGateFor(run)): SessionActions {
  let sequence = 0,moneyDisposed=false;
  let approval:CustomApprovalState|null=null;
  const customListeners=new Set<()=>void>();
  let moneyApproval:MoneyApprovalState|null=null, pendingMoney:MoneyState|null=null;
  const customBusy=()=>approval?.status==='pending'||moneyApproval?.status==='pending';
  const emitCustom=()=>{for(const listener of [...customListeners]){try{listener();}catch{/* Keep notification fanout coherent. */}}};
  const capture = (): SessionStamp => ({ runId: run.getState().runId, expectedDataRevision: data.getSnapshot().revision, expectedRunRevision: run.getState().runRevision, transitionToken: run.getState().transitionToken });
  const success=():DataCommandResult=>{const snapshot=data.getSnapshot(),settings=snapshot.tables.shopSettings,enabled=tableLayoutEnabled(settings);return {ok:true,revision:snapshot.revision,value:{shopSettingsRevision:settings.revision,tableLayoutEnabled:enabled,totalSeats:enabled?settings.tableLayout!.tables.reduce((n,t)=>n+t.seats,0):manifest.store.seats}};};
  const transact = (input: Parameters<RunStore['session']['prepare']>[1], command: DataSessionInput, expected = capture(), transactionId?: string): DataCommandResult => {
    if (gate.phase !== 'idle') return conflict('TRANSACTION_BUSY');
    if(customBusy() && input.type!=='pos.commit')return conflict(moneyApproval?.status==='pending'?'UNPAID_BILLS':'APPROVAL_BUSY');
    const current = capture();
    if (Object.keys(current).some(k => current[k as keyof SessionStamp] !== expected[k as keyof SessionStamp]) || data.getSnapshot().runId !== expected.runId) return conflict('STALE_REVISION');
    if(input.type==='update-settings'){const source=data.getSnapshot().tables.shopSettings;const settings=input.settings;if(run.getState().onboarding.step==='done'&&(!run.getState().templateTour||run.getState().templateTour?.status==='completed')&&run.getState().shopSettings.revision===source.revision&&settings.revision===source.revision+1&&settings.businessType===source.businessType&&settings.paymentStyle===source.paymentStyle&&canonical(settings.tableLayout)===canonical(source.tableLayout)&&canonical(settings.posPreferences)===canonical(source.posPreferences)&&canonical(settings.cctvPosLinks ?? [])===canonical(source.cctvPosLinks ?? []))return success();}
    const tx: SessionTransaction = { ...expected, transactionId: transactionId ?? `${expected.runId}:session:${++sequence}` };
    let runChange: PreparedChange | undefined, dataChange: PreparedChange | undefined;
    gate.phase = 'preparing'; gate.transactionId = tx.transactionId;
    try {
      const r = run.session.prepare(tx, input);
      if (!r.ok) return r;
      runChange = r.change;
      const d = data.session.prepare(tx, command);
      if (!d.ok) return d;
      dataChange = d.change;
      if (!run.session.isCurrent(runChange) || !data.session.isCurrent(dataChange) || Object.keys(expected).some(k => capture()[k as keyof SessionStamp] !== expected[k as keyof SessionStamp])) return conflict('STALE_REVISION');
      gate.phase = 'publishing';
      data.session.publish(dataChange); run.session.publish(runChange);
      gate.phase = 'flushing';
      // Run remains published/busy during the first data notification, even for isolated stores without a gate.
      try { data.session.flush(tx.transactionId); } finally { run.session.flush(tx.transactionId); }
      return success();
    } finally {
      if (gate.phase === 'preparing') { if (runChange) run.session.abort(runChange); if (dataChange) data.session.abort(dataChange); }
      gate.phase = 'idle'; gate.transactionId = null;
    }
  };
  const commit = (plan: PosPlan, expected: PosReadSnapshot): PosResult<PosCommandValue> => {
    if (gate.phase !== 'idle') return posFailure('TRANSACTION_BUSY', 'CONFLICT');
    const state = run.getState(), snapshot = data.getSnapshot();
    if (state.runId !== expected.runId) return posFailure('STALE_RUN', 'CONFLICT');
    if (state.runRevision !== expected.runRevision || state.posRevision !== expected.posRevision || state.pos !== expected.pos || state.posUi !== expected.posUi || snapshot.revision !== expected.dataRevision || expected.data.source !== snapshot) return posFailure('STALE_REVISION', 'CONFLICT');
    // Legacy receipt callers publish their already validated kitchen/restock plan together with
    // the matching canonical original-allocation correction; they never form a second ledger.
    if(snapshot.pos?.money && plan.nextPos.money===expected.pos.money){
      const added=[...plan.nextPos.cancellations.filter(c=>!expected.pos.cancellations.some(o=>o.cancellationId===c.cancellationId)).map(c=>({id:c.cancellationId,paymentId:c.paymentId,methods:c.methodAmounts,kind:'cancel' as const,amount:c.amount,lines:c.allocations.filter(a=>a.qty>0).map(a=>({allocationId:a.allocationId??expected.pos.billAllocations.find(x=>x.billId===c.billId&&x.orderLineId===a.lineId)!.allocationId,quantity:a.qty}))})),...plan.nextPos.refunds.filter(c=>!expected.pos.refunds.some(o=>o.refundId===c.refundId)).map(c=>({id:c.refundId,paymentId:c.paymentId,methods:c.methodAmounts,kind:'refund' as const,amount:c.amount,lines:[]}))];
      let moneyRead=selectMoneyRead(snapshot,expected.scenario);
      for(const correction of added){
        const original=moneyRead.state.payments.find(p=>p.paymentId===correction.paymentId);if(!original)continue;
        // The legacy quote already checked per-line kitchen/restock eligibility.
        const source=moneyRead.state.settlements.find(s=>s.settlementId===original.settlementId)?.sourceRef;
        const preparedRead={...moneyRead,sources:moneyRead.sources.map(s=>s.sourceRef.id===source?.id?{...s,prepared:correction.kind==='refund',lines:s.lines.map(l=>({...l,prepared:correction.kind==='refund'}))}:s)};
        const fullPaymentReturn=correction.amount===original.amount-moneyRead.state.corrections.filter(c=>c.settlementId===original.settlementId).flatMap(c=>c.realMethodReturns).reduce((n,s)=>n+s.amount,0);
        const quote=quoteMoneyReversal(preparedRead,{paymentId:correction.paymentId,kind:correction.kind,...(fullPaymentReturn?{}:correction.lines.length?{lines:correction.lines}:{amount:correction.amount})});
        const planned=planMoneyReversal(preparedRead,{quote,meta:{runId:expected.runId,idempotencyKey:`legacy-return:${correction.id}`}});if(!planned.ok)return planned;
        // Legacy method selection has already been checked against the original receipt.
        // Keep that selection when the canonical proportional quote chooses another method.
        let nextMoney=planned.nextState;
        const returned=nextMoney.corrections.at(-1)!;
        if(correction.methods.length && canonical(correction.methods)!==canonical(returned.realMethodReturns)){
          const settlement=moneyRead.state.settlements.find(s=>s.settlementId===original.settlementId)!;
          const allocationEffects=returned.originalAllocationEffects.filter(e=>settlement.allocations.find(a=>a.allocationId===e.allocationId)?.kind!=='method');
          const recognitionEffects=[...returned.recognitionEffects];
          for(const allocation of settlement.allocations.filter(a=>a.kind==='method')){
            const amount=correction.methods.find(m=>m.method===allocation.method)?.amount??0;
            if(amount)allocationEffects.push({allocationId:allocation.allocationId!,amount});
            const origins=moneyRead.state.recognitions.filter(r=>r.settlementAllocationId===allocation.allocationId&&!r.originalRecognitionId);
            const amounts=allocatePosAmount(amount,origins.map(r=>({id:r.recognitionId,amount:r.amount+moneyRead.state.recognitions.filter(c=>c.originalRecognitionId===r.recognitionId).reduce((n,c)=>n+c.amount,0)})));
            for(let i=0;i<recognitionEffects.length;i++)if(origins.some(r=>r.recognitionId===recognitionEffects[i].originalRecognitionId))recognitionEffects[i]={...recognitionEffects[i],amount:-(amounts[recognitionEffects[i].originalRecognitionId!]??0)};
          }
          const replacement={...returned,originalAllocationEffects:allocationEffects,realMethodReturns:correction.methods,recognitionEffects};
          nextMoney={...nextMoney,corrections:nextMoney.corrections.map(c=>c===returned?replacement:c),recognitions:nextMoney.recognitions.map(r=>recognitionEffects.find(c=>c.recognitionId===r.recognitionId)??r)};
        }
        if(fullPaymentReturn&&correction.lines.length){
          // The receipt planner owns its frozen per-share physical quantities. Reuse those
          // effects while the money planner returns the entire original settlement value.
          const current=nextMoney.corrections.at(-1)!;
          const settlement=moneyRead.state.settlements.find(s=>s.settlementId===original.settlementId)!;
          const sourceLines=settlement.sourceSnapshot?.lines??[];
          const origins=moneyRead.state.recognitions.filter(r=>!r.originalRecognitionId&&sourceLines.some(l=>l.allocationId===r.billAllocationId));
          const recognitionEffects=[...current.recognitionEffects];
          for(const line of correction.lines){
            const rows=origins.filter(r=>r.billAllocationId===line.allocationId);
            const prior=(id:string)=>moneyRead.state.recognitions.filter(r=>r.originalRecognitionId===id);
            const metric=(get:(r:typeof rows[number])=>number)=>{
              const weights=rows.map(r=>({id:r.recognitionId,amount:Math.max(0,get(r)+prior(r.recognitionId).reduce((n,c)=>n+get(c),0))}));
              const total=weights.reduce((n,w)=>n+w.amount,0),qty=rows.reduce((n,r)=>n+(r.quantity??0)+prior(r.recognitionId).reduce((n,c)=>n+(c.quantity??0),0),0);
              return allocatePosAmount(qty?Math.floor(total*line.quantity/qty):0,weights);
            };
            const quantities=metric(r=>r.quantity??0),gross=metric(r=>r.gross??0),cost=metric(r=>r.cost??0);
            const direct=metric(r=>r.discountBySource?.direct??0),coupon=metric(r=>r.discountBySource?.coupon??0),membership=metric(r=>r.discountBySource?.membership??0);
            for(const row of rows){const existing=recognitionEffects.findIndex(r=>r.originalRecognitionId===row.recognitionId);const effect={...(existing<0?{...row,recognitionId:`${current.correctionId}:${row.recognitionId}`,at:current.at,originalRecognitionId:row.recognitionId,amount:0}:recognitionEffects[existing]),quantity:-quantities[row.recognitionId],gross:-gross[row.recognitionId],cost:row.cost===null?null:-cost[row.recognitionId],discountBySource:{direct:-direct[row.recognitionId],coupon:-coupon[row.recognitionId],membership:-membership[row.recognitionId]}};if(existing<0)recognitionEffects.push(effect);else recognitionEffects[existing]=effect;}
          }
          const lineEffects=correction.lines.flatMap(q=>{const line=sourceLines.find(l=>l.allocationId===q.allocationId);return line?[{allocationId:q.allocationId,orderLineId:line.orderLineId,menuId:line.menuId,quantity:-q.quantity,stock:(line.recipe??[]).map(r=>({itemId:r.itemId,deltaBase:r.quantityBase*q.quantity}))}]:[];});
          const replacement={...current,quantityReturns:correction.lines,lineEffects,recognitionEffects};
          nextMoney={...nextMoney,corrections:nextMoney.corrections.map(c=>c===current?replacement:c),recognitions:[...nextMoney.recognitions.filter(r=>!current.recognitionEffects.some(c=>c.recognitionId===r.recognitionId)),...recognitionEffects]};
          const uses=nextMoney.uses.map(use=>{
            if(use.canceledAt)return use;
            const allocations=nextMoney.settlements.flatMap(s=>s.allocations).filter(a=>a.useId===use.useId);
            const valueReturned=allocations.length>0&&allocations.every(a=>nextMoney.corrections.flatMap(c=>c.originalAllocationEffects).filter(e=>e.allocationId===a.allocationId).reduce((n,e)=>n+e.amount,0)>=a.amount);
            const quantityReturned=use.coveredQuantities.every(q=>nextMoney.corrections.flatMap(c=>c.quantityReturns??[]).filter(e=>e.allocationId===q.allocationId).reduce((n,e)=>n+e.quantity,0)>=q.quantity);
            const sourceIds=new Set(nextMoney.settlements.filter(s=>s.allocations.some(a=>a.useId===use.useId)).map(s=>s.sourceRef.id));
            const sourceReturned=nextMoney.settlements.filter(s=>sourceIds.has(s.sourceRef.id)).every(s=>nextMoney.corrections.filter(c=>c.settlementId===s.settlementId).reduce((n,c)=>n+c.amount,0)>=s.amount);
            return valueReturned&&quantityReturned&&sourceReturned?{...use,canceledAt:current.at}:use;
          });
          nextMoney={...nextMoney,uses};
        }
        moneyRead={...preparedRead,state:nextMoney,revision:moneyRead.revision+1};
      }
      if(added.length)plan={...plan,nextPos:synchronizeCustomMoney({...plan.nextPos,money:moneyRead.state})};
    }
    // Runtime acknowledges no-change commands itself, retaining their keys without a commit.
    if (plan.nextPos === expected.pos) return plan.result;
    const transactionId = `${expected.runId}:session:${++sequence}`;
    const result = { ...plan.result, transactionId };
    const nextPos = { ...plan.nextPos, commandLedger: plan.nextPos.commandLedger.map(record => record.result === plan.result ? { ...record, result } : record) };
    const outcome = transact({ type: 'pos.commit', expectedPosRevision: expected.posRevision, nextPos, nextUi: plan.nextUi, nextSettings: plan.dataChanges?.settings },
      { type: 'pos.commit', expectedPosRevision: expected.posRevision, nextPos, dataChanges: plan.dataChanges }, capture(), transactionId);
    if (!outcome.ok) return { ...outcome, reason: outcome.reason ?? outcome.code };
    return result;
  };
  let lastSnapshot: ReturnType<WidgetDataStore['getSnapshot']> | undefined, posData: PosDataRead;
  const readData = () => {
    const snapshot = data.getSnapshot();
    if (snapshot !== lastSnapshot) { posData = freezePos({ ...selectPosDataRead(snapshot), reservations: selectPosReservations(snapshot, {}) }); lastSnapshot = snapshot; }
    return posData;
  };
  const pos = createPosRuntime({ run, readData, subscribeData: data.subscribe, commit,onDispose:()=>{moneyDisposed=true;}, moneyCommand:command=>legacyMoneyCommand(command), isBusy: () => gate.phase !== 'idle' || customBusy() });
  const initialRunId=run.getState().runId;
  const customFailure=(reason:string):CustomCommandResult=>({ok:false,code:'CONFLICT',reason,messageKey:reason==='QUOTE_CHANGED'?'data.custom.error.QUOTE_CHANGED':'run.session.conflict'});
  const guardCustom=():CustomCommandResult|null=> {
    if(run.getState().runId!==initialRunId)return customFailure('STALE_RUN');
    if(gate.phase!=='idle')return customFailure('TRANSACTION_BUSY');
    if(run.getState().posUi.approval?.status==='pending')return customFailure('APPROVAL_BUSY');
    if(pos.read().data.dayClosed)return customFailure('DAY_CLOSED');
    if(pos.read().scenario!=='normal')return customFailure('DATA_UNAVAILABLE');
    return null;
  };
  const ledger=(command:{readonly type:string;readonly idempotencyKey:string},result:DataCommandResult)=>({key:`${initialRunId}:${command.type}:${command.idempotencyKey}`,fingerprint:canonical(Object.fromEntries(Object.entries(command).filter(([key])=>key!=='baseRevision'))),result});
  function applyCustom(plan:CustomPlanResult,command:{readonly type:string;readonly idempotencyKey?:string;readonly reversiblePickup?:true}):CustomCommandResult {
    if(!plan.ok)return plan;
    if(!plan.changed){const result:CustomCommandResult={ok:true,revision:data.getSnapshot().revision,value:plan.value};data.remember(command,result);return result;}
    const expected=pos.read();
    let next=applyCustomMoney(expected.pos,plan.moneyEffects);
    if(expected.pos.money && command.type==='customOrder.receive'){
      const id=plan.value.customOrderId!;
      const recognition=planRecognizeCustomPickup(money.read(),{customOrderId:id,meta:{runId:initialRunId,idempotencyKey:command.idempotencyKey!}});
      if(!recognition.ok)return recognition;
      next=synchronizeCustomMoney({...expected.pos,money:recognition.nextState,revision:expected.pos.revision+1});
    }
    const nextPos=next===expected.pos?{...next,revision:next.revision+1}:next;
    // D-326 uses the widget's recognition plan and attaches a receipt only to the card entry.
    const pickupRecognitionId = command.reversiblePickup ? nextPos.customRecognitions?.find(row =>
      row.source === 'custom_pickup' && row.sourceId === plan.value.customOrderId && row.originalRecognitionId === null)?.recognitionId : undefined;
    if (command.reversiblePickup && !pickupRecognitionId) return customFailure('STALE_REVISION');
    const pickupUndo = pickupRecognitionId ? { token: `data-undo:${initialRunId}:pickup:${++sequence}`, recognitionId: pickupRecognitionId } : undefined;
    const result:CustomCommandResult={ok:true,revision:expected.dataRevision+1,
      value: pickupRecognitionId ? { ...plan.value, recognitionId: pickupRecognitionId } : plan.value, noticeKey:'data.custom.notice.changed',
      ...(pickupUndo ? { undoToken: pickupUndo.token } : {}) };
    const outcome=commit({nextPos,nextUi:expected.posUi,result:{ok:true,status:'applied',value:null,posRevision:nextPos.revision,dataRevision:expected.dataRevision+1},dataChanges:{custom:plan,...(command.idempotencyKey?{customLedger:ledger({...command,idempotencyKey:command.idempotencyKey},result)}:{}), ...(pickupUndo ? { pickupUndo } : {}) }},expected);
    return outcome.ok?result:outcome;
  }
  const custom:CustomCoordinator={
    read:()=>selectCustomOrderRead(data.getSnapshot()),
    subscribe(listener){const offData=data.subscribe(listener),offRun=run.subscribe(listener);customListeners.add(listener);return ()=>{offData();offRun();customListeners.delete(listener);};},
    approval:()=>approval,
    dispatch(command){
      const replay=data.replay(command);if(replay)return replay as CustomCommandResult;
      const blocked=guardCustom();if(blocked)return blocked;
      if(customBusy())return customFailure('APPROVAL_BUSY');
      if(command.type!=='customOrder.receive')return data.dispatch(command) as CustomCommandResult;
      const read = custom.read();
      if ('reversiblePickup' in command && command.reversiblePickup === true) {
        const blocked = checkReversiblePickup(read, command.customOrderId);
        if (blocked) return blocked;
        return applyCustom(planCustomOrderCommand(read, command), { ...command, reversiblePickup: true });
      }
      return applyCustom(planCustomOrderCommand(read,command),command);
    },
    quoteSettlement:input=>quoteCustomSettlement(custom.read(),input),
    beginApproval(input){
      const command={type:'customOrder.settle',...input};
      const replay=data.replay(command);if(replay)return replay;
      const blocked=guardCustom();if(blocked)return blocked;
      if(!input.idempotencyKey?.trim())return customFailure('KEY_REQUIRED');
      if(customBusy())return approval && approval.idempotencyKey===input.idempotencyKey && canonical(approval.quote)===canonical(input.quote)?{ok:true,revision:data.getSnapshot().revision,value:{runId:approval.runId,attemptId:approval.attemptId},duplicate:true}:customFailure('APPROVAL_BUSY');
      const current=quoteCustomSettlement(custom.read(),{customOrderId:input.quote.target.customOrderId,allocations:input.quote.allocations});
      if(canonical(current)!==canonical(input.quote))return customFailure('QUOTE_CHANGED');
      if(!current.canSubmit)return current.issues[0];
      approval=freezePos({status:'pending',runId:initialRunId,attemptId:`${initialRunId}:custom-attempt:${++sequence}`,quote:current,idempotencyKey:input.idempotencyKey,generation:pos.read().data.closingGeneration});
      emitCustom();return {ok:true,revision:data.getSnapshot().revision,value:{runId:approval.runId,attemptId:approval.attemptId}};
    },
    finishApproval(input){
      const attempt=approval;
      if(!attempt || attempt.status!=='pending' || input.runId!==initialRunId || input.runId!==run.getState().runId || input.attemptId!==attempt.attemptId)return customFailure('STALE_ATTEMPT');
      let result=guardCustom();
      if(!result && attempt.generation!==pos.read().data.closingGeneration)result=customFailure('STALE_ATTEMPT');
      if(!result && input.outcome!=='approved')result=customFailure('APPROVAL_FAILED');
      if(!result){const command={type:'customOrder.settle',quote:attempt.quote,idempotencyKey:attempt.idempotencyKey};
        result=applyCustom(planCustomSettlement(custom.read(),{quote:attempt.quote,idempotencyKey:attempt.idempotencyKey,settlementId:`${attempt.attemptId}:settlement`,paymentId:`${attempt.attemptId}:payment`}),command);}
      approval=freezePos({...attempt,status:result.ok?'succeeded':'failed',result});emitCustom();return result;
    },
    dismissApproval(){if(customBusy())return false;approval=null;emitCustom();return true;},
    quoteReversal:input=>quoteCustomReversal(custom.read(),input),
    reverse(input){const command={type:'customOrder.reverse',...input};const replay=data.replay(command);if(replay)return replay as CustomCommandResult;const blocked=guardCustom();if(blocked)return blocked;if(customBusy())return customFailure('APPROVAL_BUSY');return applyCustom(planCustomReversal(custom.read(),input),command);},
  };
  let lastMoneySnapshot:ReturnType<WidgetDataStore['getSnapshot']>|undefined,lastMoneyRunId:string|undefined,lastMoneyPreview:unknown,cachedMoney:MoneyRead,pendingRead:MoneyRead|undefined,pendingReadState:MoneyState|null=null;
  const moneyRead=():MoneyRead=>{const snapshot=data.getSnapshot(),preview=pos.read().scenario,runId=run.getState().runId;if(snapshot!==lastMoneySnapshot||preview!==lastMoneyPreview||runId!==lastMoneyRunId){const source=selectMoneyRead(snapshot,preview);cachedMoney=runId===initialRunId?source:freezePos({...source,runId,scenario:'error',dayClosed:true});lastMoneyRunId=runId;lastMoneySnapshot=snapshot;lastMoneyPreview=preview;pendingRead=undefined;}if(pendingMoney){if(!pendingRead||pendingReadState!==pendingMoney){pendingRead={...cachedMoney,state:{...cachedMoney.state,attempt:pendingMoney.attempt}};pendingReadState=pendingMoney;}return pendingRead;}return cachedMoney;};
  const moneyResult=(value:SharedMoneyCompletion,status:'applied'|'unchanged'|'pending'='applied'):Extract<PosResult<SharedMoneyCompletion>,{ok:true}>=>({ok:true,status,value,posRevision:run.getState().posRevision,dataRevision:data.getSnapshot().revision});
  const applyMoney=(planned:MoneyPlan,customPlan?:CustomPlanResult):PosResult<SharedMoneyCompletion>=>{
    if(moneyDisposed||run.getState().runId!==initialRunId||data.getSnapshot().runId!==initialRunId)return posFailure('STALE_RUN','CONFLICT');
    if(!planned.ok)return planned;
    const expected=pos.read();
    if((planned.nextState===expected.pos.money||!planned.changed&&planned.nextState.commands===expected.pos.money?.commands&&planned.nextState.attempt===expected.pos.money?.attempt)&&!customPlan)return {...moneyResult(planned.value,'unchanged'),...(planned.duplicate?{duplicate:true}:{})};
    let nextPos=applyMoneyPlanToPos(expected,planned);
    const service=planMembershipServiceDay({...moneyRead(),state:nextPos.money!,dayClosed:false},{date:nextPos.businessDate});
    if(service.ok)nextPos=synchronizeCustomMoney({...nextPos,money:service.nextState});
    if(expected.posUi.approval?.attemptId===moneyApproval?.attemptId&&planned.value.paymentId){
      const oldId=planned.value.paymentId,number=Math.max(0,...expected.pos.payments.map(p=>Number(/^P-(\d+)$/.exec(p.paymentId)?.[1]??0)))+1,paymentId=`P-${String(number).padStart(3,'0')}`;
      planned={...planned,value:{...planned.value,paymentId}};
      nextPos={...nextPos,payments:nextPos.payments.map(p=>p.paymentId!==oldId?p:{...p,paymentId,transactionNo:`거래-${nextPos.businessDate.replaceAll('-','')}-${String(number).padStart(4,'0')}`,approvalNo:`예시-${String(number).padStart(6,'0')}`}),receipts:nextPos.receipts.map(r=>r.paymentId===oldId?{...r,paymentId}:r),money:{...nextPos.money!,payments:nextPos.money!.payments.map(p=>p.paymentId===oldId?{...p,paymentId}:p),commands:nextPos.money!.commands.map(c=>c.value.paymentId===oldId?{...c,value:{...c.value,paymentId}}:c)}};
    }
    const orderNo=planned.value.billId?nextPos.orders.filter(o=>o.originBillId===planned.value.billId).at(-1)?.orderNo:undefined;
    const legacyAttempt=expected.posUi.approval;
    const nextUi={...expected.posUi,cartUndo:null,tablesUndo:null,...(legacyAttempt&&legacyAttempt.attemptId===moneyApproval?.attemptId?{approval:{...legacyAttempt,status:'succeeded' as const,result:{ok:true as const,status:'applied' as const,posRevision:nextPos.revision,dataRevision:expected.dataRevision+1,value:{paymentId:planned.value.paymentId,billId:planned.value.billId!,orderIds:orderNo?nextPos.orders.filter(o=>o.originBillId===planned.value.billId).map(o=>o.orderId):planned.value.orderIds??[],settled:planned.value.settled??false,remaining:planned.value.remaining??0}}}}:{})};
    const result=commit({nextPos,nextUi,result:{ok:true,status:'applied',value:null,posRevision:nextPos.revision,dataRevision:expected.dataRevision+1},...(customPlan?{dataChanges:{custom:customPlan}}:{})},expected);
    return result.ok?{...moneyResult({...planned.value,...(orderNo?{orderNo,orderIds:nextPos.orders.filter(o=>o.originBillId===planned.value.billId).map(o=>o.orderId)}:{})}),...(planned.duplicate?{duplicate:true}:{})}:result;
  };
  const customMoneyPlan=(state:MoneyState,settlementId:string,cancelOrder=false):CustomPlanResult|undefined=>{
    const settlement=state.settlements.find(s=>s.settlementId===settlementId);if(settlement?.purpose!=='custom_order')return;
    const current=custom.read(),order=current.tables.customOrder.find(o=>o.customOrderId===settlement.sourceRef.id);if(!order)return;
    if(cancelOrder&&(order.stage==='received_by_customer'||state.corrections.filter(c=>c.settlementId===settlementId).reduce((n,c)=>n+c.amount,0)!==settlement.amount))return {ok:false,code:'CONFLICT',reason:'INVALID_STAGE_TRANSITION',messageKey:'data.custom.error.INVALID_STAGE_TRANSITION'};
    const correction=state.corrections.filter(c=>c.settlementId===settlementId).at(-1);
    const stage=cancelOrder?'canceled' as const:order.stage==='payment_pending'?'in_production' as const:order.stage;
    return {ok:true,changed:true,undoable:false,value:{customOrderId:order.customOrderId,stage,settlementId},moneyEffects:{settlements:[],payments:[],recognitions:[],corrections:[]},tables:{...current.tables,customOrder:current.tables.customOrder.map(o=>o===order?{...o,stage,settlementId,history:[...o.history,{historyId:`money-history:${settlementId}:${state.corrections.length}`,at:businessNow(),kind:correction?'refunded':'settled',stage,quoteRevision:o.quoteRevision,detail:String(correction?.amount??settlement.amount),referenceId:correction?.correctionId??settlementId}]}:o),reservation:cancelOrder?current.tables.reservation.map(r=>r.kind==='pickup'&&r.customOrderId===order.customOrderId?{...r,status:'canceled' as const,updatedAt:businessNow()}:r):current.tables.reservation}};
  };
  const money:MoneyCoordinator={
    read:moneyRead,subscribe:custom.subscribe,approval:()=>run.getState().runId===initialRunId&&!moneyDisposed?moneyApproval:null,
    quoteSettlement:input=>quoteMoneySettlement(moneyRead(),input),
    quoteSale(input){
      const read=moneyRead(),quote=quotePosSettlement(read,pos.read(),input),source=read.sources.find(s=>s.billId===input.billId);
      const candidates=source?.membershipContributions?.length?[...input.allocations,...source.membershipContributions.map(c=>({kind:read.state.memberships.find(p=>p.membershipId===c.membershipId)?.kind==='count'?'membership_count' as const:'membership_period' as const,amount:c.recognizedAmount,membershipId:c.membershipId,billAllocationId:c.allocationId,quantity:c.quantity,useId:c.useId}))]:quote.allocations;
      const allocations=candidates.filter(a=>!a.useId||!read.state.uses.some(u=>u.useId===a.useId&&!u.canceledAt&&u.coveredQuantities.some(c=>c.allocationId===a.billAllocationId)));
      return quoteMoneySettlement(read,{target:quote.target,allocations});
    },
    beginApproval(input){
      if(moneyDisposed||run.getState().runId!==initialRunId)return posFailure('STALE_RUN','CONFLICT');
      if(gate.phase!=='idle'||approval?.status==='pending')return posFailure('APPROVAL_BUSY','CONFLICT');
      if(moneyApproval?.status==='failed'&&moneyApproval.attemptId===`settlement-attempt:${run.getState().runId}:${input.idempotencyKey}`)return canonical(moneyApproval.quote)===canonical(input.quote)?moneyApproval.result!:posFailure('IDEMPOTENCY_MISMATCH','CONFLICT');
      const planned=planBeginSettlementApproval(moneyRead(),{quote:input.quote,meta:{runId:run.getState().runId,idempotencyKey:input.idempotencyKey}});
      if(!planned.ok)return planned;
      if(planned.duplicate&&!planned.attemptId)return {...moneyResult(planned.value,'unchanged'),duplicate:true};
      pendingMoney=planned.nextState;moneyApproval=freezePos({status:'pending',runId:run.getState().runId,attemptId:planned.attemptId!,quote:input.quote});
      emitCustom();return {...moneyResult({attemptId:planned.attemptId} as SharedMoneyCompletion,'pending'),value:{attemptId:planned.attemptId},...(planned.duplicate?{duplicate:true}:{})};
    },
    finishApproval(input){
      const attempt=moneyApproval;
      if(moneyDisposed||input.runId!==run.getState().runId||run.getState().runId!==initialRunId||data.getSnapshot().runId!==initialRunId)return posFailure('STALE_RUN','CONFLICT');
      if(!attempt||attempt.runId!==input.runId||attempt.attemptId!==input.attemptId)return posFailure('STALE_ATTEMPT','CONFLICT');
      if(attempt.status!=='pending')return attempt.result?.ok?{...attempt.result,duplicate:true}:attempt.result??posFailure('STALE_ATTEMPT','CONFLICT');
      const planned=planFinishSettlementApproval(moneyRead(),{...input,expectedQuoteFingerprint:pendingMoney?.attempt?.fingerprint??''});
      const customPlan=planned.ok&&planned.value.settlementId?customMoneyPlan(planned.nextState,planned.value.settlementId):undefined;
      const result=customPlan&&!customPlan.ok?customPlan:applyMoney(planned,customPlan);
      const normalized:PosResult<SharedMoneyCompletion>=result.ok?'status' in result?result:moneyResult({}):result;
      pendingMoney=null;moneyApproval=freezePos({...attempt,status:normalized.ok?'succeeded':'failed',result:normalized});emitCustom();return normalized;
    },
    dismissApproval(){if(moneyApproval?.status==='pending')return false;pendingMoney=null;moneyApproval=null;emitCustom();return true;},
    receipt:input=>selectMoneyReceipt(moneyRead(),input),
    quoteReversal:input=>quoteMoneyReversal(moneyRead(),input),
    reverse(input){if(moneyDisposed||run.getState().runId!==initialRunId)return posFailure('STALE_RUN','CONFLICT');const command={type:'money.reverse',...input};const replay=data.replay(command);if(replay)return replay.ok?{...moneyResult(replay.value as SharedMoneyCompletion,'unchanged'),duplicate:true}:{...replay,reason:replay.reason??replay.code};if(customBusy())return posFailure('APPROVAL_BUSY','CONFLICT');const planned=planMoneyReversal(moneyRead(),{quote:input.quote,meta:{runId:run.getState().runId,idempotencyKey:input.idempotencyKey}});if(!planned.ok)return planned;if(planned.duplicate)return {...moneyResult(planned.value,'unchanged'),duplicate:true};const customPlan=customMoneyPlan(planned.nextState,input.quote.settlementId,input.cancelOrder);const result=customPlan&&!customPlan.ok?customPlan:applyMoney(planned,customPlan);if(result.ok)data.remember(command,{ok:true,revision:result.dataRevision,value:result.value});return result;},
    quotePartialCancellation(billId){
      const source=moneyRead(),read={...source,sources:source.sources.map(s=>s.billId===billId?{...s,prepared:false}:s)},settlements=read.state.settlements.filter(s=>s.billId===billId&&!read.state.corrections.some(c=>c.settlementId===s.settlementId&&c.amount===s.amount));
      const quotes=settlements.map(s=>quoteMoneyReversal(read,{settlementId:s.settlementId,kind:'cancel'}));
      const partial=run.getState().pos.bills.find(b=>b.billId===billId)?.status==='partial';
      const issues=[...quotes.flatMap(q=>q.issues),...(!partial?[posFailure('NOT_PARTIAL')]:[])];
      const value={quoteRevision:read.revision,billId,settlementIds:settlements.map(s=>s.settlementId),kind:'cancel' as const,amount:quotes.reduce((n,q)=>n+q.amount,0),remainingRefundable:quotes.reduce((n,q)=>n+q.remainingRefundable,0),realMethodReturns:quotes.flatMap(q=>q.realMethodReturns),accountEffects:quotes.flatMap(q=>q.accountEffects),membershipEffects:quotes.flatMap(q=>q.membershipEffects),recognitionEffects:quotes.flatMap(q=>q.recognitionEffects),canSubmit:!issues.length,issues};
      return {...value,quoteId:canonical(value)};
    },
    cancelPartial(input){
      if(moneyDisposed||run.getState().runId!==initialRunId)return posFailure('STALE_RUN','CONFLICT');
      const command={type:'money.abandon',...input},replay=data.replay(command);if(replay)return replay.ok?{...moneyResult(replay.value as SharedMoneyCompletion,'unchanged'),duplicate:true}:{...replay,reason:replay.reason??replay.code};
      const billId=moneyRead().state.settlements.find(s=>input.quote.settlementIds.includes(s.settlementId))?.billId;if(!billId)return posFailure('NOT_PARTIAL');
      const current=money.quotePartialCancellation(billId);if(current.quoteId!==input.quote.quoteId)return posFailure('QUOTE_CHANGED','CONFLICT');if(!current.canSubmit)return current.issues[0];
      const source=moneyRead(),planned=planAbandonSettlement({...source,sources:source.sources.map(s=>s.billId===billId?{...s,prepared:false}:s)},{sourceRef:{kind:'bill',id:billId},meta:{runId:run.getState().runId,idempotencyKey:input.idempotencyKey}});if(!planned.ok)return planned;
      const expected=pos.read(),next=applyMoneyPlanToPos(expected,planned),bill=next.bills.find(b=>b.billId===billId)!;
      const nextPos={...next,bills:bill.cartId?next.bills.filter(b=>b.billId!==billId):next.bills.map(b=>b.billId===billId?{...b,status:'open' as const,requestedAt:undefined,splitPlan:undefined,settlementLines:[]}:b),cart:{...next.cart,lock:null,revision:next.cart.revision+1},tableSessions:next.tableSessions.map(s=>s.billId===billId?{tableId:s.tableId,billId,cleaning:false}:s)};
      const outcome=commit({nextPos,nextUi:{...expected.posUi,cartUndo:null,tablesUndo:null},result:{ok:true,status:'applied',value:null,posRevision:nextPos.revision,dataRevision:expected.dataRevision+1}},expected);if(!outcome.ok)return outcome;const result=moneyResult({billId,settled:false,remaining:bill.splitPlan?.parts.reduce((n,p)=>n+p.amount,0)??0});data.remember(command,{ok:true,revision:result.dataRevision,value:result.value});return result;
    },
    materializeServiceDay:date=>applyMoney(planMembershipServiceDay(moneyRead(),{date})),
  };
  const legacyMoneyResults=new Map<string,{readonly fingerprint:string;readonly scenario:string;readonly generation:number;readonly result:PosResult<PosCommandValue>}>();
  function legacyMoneyCommand(command:import('../contracts/pos').PosSessionCommand):PosResult<PosCommandValue>|undefined {
    if(!run.getState().pos.money)return;
    const resultAsPos=(result:PosResult<SharedMoneyCompletion>):PosResult<PosCommandValue>=>result.ok?{...result,value:{...result.value,billId:result.value.billId??'',orderIds:result.value.orderIds??[],remaining:result.value.remaining??0,settled:result.value.settled??false}}:result;
    if(gate.phase!=='idle')return posFailure('TRANSACTION_BUSY','CONFLICT');
    let guardedKey:string|undefined,guardedFingerprint:string|undefined;
    if(command.type==='bill.confirmZero'||command.type==='bill.cancelPartial'){
      const expected=pos.read();
      if(command.meta.runId!==expected.runId)return posFailure('STALE_RUN','CONFLICT');
      if(!command.meta.idempotencyKey?.trim())return posFailure('IDEMPOTENCY_KEY_REQUIRED');
      guardedKey=canonical([command.meta.runId,command.type,command.meta.idempotencyKey]);
      guardedFingerprint=canonical({type:command.type,billId:command.billId,...(command.type==='bill.cancelPartial'?{confirmed:command.confirmed}:{})});
      const prior=legacyMoneyResults.get(guardedKey);
      if(prior){
        if(prior.scenario!==expected.scenario||prior.generation!==expected.data.closingGeneration)return posFailure('STALE_REVISION','CONFLICT');
        return prior.fingerprint===guardedFingerprint&&prior.result.ok?{...prior.result,duplicate:true}:posFailure('IDEMPOTENCY_MISMATCH','CONFLICT');
      }
      if(command.meta.expectedPosRevision!==undefined&&command.meta.expectedPosRevision!==expected.posRevision||command.meta.expectedDataRevision!==undefined&&command.meta.expectedDataRevision!==expected.dataRevision)return posFailure('STALE_REVISION','CONFLICT');
    }
    const rememberLegacy=(result:PosResult<PosCommandValue>)=>{if(result.ok&&guardedKey&&guardedFingerprint){const expected=pos.read();legacyMoneyResults.set(guardedKey,{fingerprint:guardedFingerprint,scenario:expected.scenario,generation:expected.data.closingGeneration,result});}return result;};
    if(command.type==='approval.begin'){
      if(command.meta.runId!==run.getState().runId)return posFailure('STALE_RUN','CONFLICT');
      const expected=pos.read(),billId='billId'in command?command.billId:getPaymentBillId(expected);
      if(command.quoteRevision!==('cartId'in command?expected.pos.cart.revision:expected.posRevision))return posFailure('QUOTE_CHANGED','CONFLICT');
      if(command.meta.expectedPosRevision!==undefined&&command.meta.expectedPosRevision!==expected.posRevision||command.meta.expectedDataRevision!==undefined&&command.meta.expectedDataRevision!==expected.dataRevision)return posFailure('STALE_REVISION','CONFLICT');
      const partId=command.partId??expected.pos.bills.find(b=>b.billId===billId)?.splitPlan?.parts.find(p=>p.status==='unpaid')?.partId;
      let quote=money.quoteSale({billId,partId,allocations:command.splits.map(s=>({kind:'method' as const,...s}))});
      const covered=quote.allocations.filter(a=>a.kind==='membership_count').reduce((n,a)=>n+a.amount,0),requested=command.splits.reduce((n,s)=>n+s.amount,0);
      if(covered>0&&requested===quote.amountDue){const amounts=distributePosAmount(requested-covered,command.splits.map((s,i)=>({id:String(i),amount:s.amount})));quote=money.quoteSale({billId,partId,allocations:command.splits.flatMap((s,i)=>amounts[String(i)]?[{kind:'method' as const,method:s.method,amount:amounts[String(i)]}]:[])});}

      const result=money.beginApproval({quote,idempotencyKey:command.meta.idempotencyKey});if(!result.ok)return result;
      if(result.duplicate&&result.status!=='pending')return resultAsPos(result);
      const attempt=money.approval()!;
      run.actions.setPosUi({...run.getState().posUi,approval:{attemptId:attempt.attemptId,runId:attempt.runId,meta:command.meta,cartId:expected.pos.cart.cartId,billId,partId,splits:command.splits,quoteFingerprint:pendingMoney!.attempt!.fingerprint,payloadFingerprint:canonical(command),scenario:expected.scenario,closingGeneration:expected.data.closingGeneration,status:'pending'}},expected.runId);
      return {...result,value:{attemptId:attempt.attemptId,status:'pending'}};
    }
    if(command.type==='approval.finish'){
      const pending=run.getState().posUi.approval;
      if(!pending||pending.attemptId!==command.attemptId||pending.quoteFingerprint!==command.expectedQuoteFingerprint)return posFailure('STALE_ATTEMPT','CONFLICT');
      const result=money.finishApproval(command);
      if(!result.ok&&pending.status==='pending')run.actions.setPosUi({...run.getState().posUi,approval:{...pending,status:'failed',result}},command.runId);
      return resultAsPos(result);
    }
    if(command.type==='bill.confirmZero'){
      const quote=money.quoteSale({billId:command.billId,allocations:[]});if(!quote.canSubmit)return quote.issues[0];
      const begin=money.beginApproval({quote,idempotencyKey:command.meta.idempotencyKey});if(!begin.ok)return begin;
      const pending=money.approval()!;return rememberLegacy(resultAsPos(money.finishApproval({runId:pending.runId,attemptId:pending.attemptId,outcome:'approved'})));
    }
    if(command.type==='bill.cancelPartial'){
      if(!command.confirmed)return posFailure('CONFIRMATION_REQUIRED');
      return rememberLegacy(resultAsPos(money.cancelPartial({quote:money.quotePartialCancellation(command.billId),idempotencyKey:command.meta.idempotencyKey})));
    }
  }
  data.bindMembershipDispatch(command=>{
    const contextRequired:DataCommandResult={ok:false,code:'CONFLICT',reason:'POS_CONTEXT_REQUIRED',messageKey:'data.money.error.POS_CONTEXT_REQUIRED',details:{route:'orders-payment'}};
    const toData=(result:PosResult<SharedMoneyCompletion>):DataCommandResult=>result.ok?{ok:true,revision:result.dataRevision,value:result.value,...(result.duplicate?{duplicate:true}:{})}:result;
    if(command.type==='memberships.useOnce'){
      if(!command.billId||!command.allocationId)return contextRequired;
      const read=money.read(),pass=read.state.memberships.find(p=>p.membershipId===command.membershipId),source=read.sources.find(s=>s.billId===command.billId);
      if(!pass||!source)return contextRequired;
      const use=quoteMembershipUse(read,{membershipId:pass.membershipId,source,allocationId:command.allocationId,quantity:command.quantity??1});
      if(!use.canSubmit)return use.issues[0];
      const quote=money.quoteSale({billId:command.billId,allocations:[{kind:pass.kind==='count'?'membership_count':'membership_period',amount:use.recognizedAmount,membershipId:pass.membershipId,billAllocationId:command.allocationId,quantity:command.quantity??1}]});
      return toData(money.beginApproval({quote,idempotencyKey:command.idempotencyKey}));
    }
    const use=money.read().state.uses.find(u=>u.useId===command.useId);
    if(use&&use.at.slice(0,10)!==money.read().businessDate)return {ok:false,code:'VALIDATION',messageKey:'data.error.cancelSameDayOnly',reason:'SAME_DAY_REQUIRED'};
    const pass=money.read().state.memberships.find(p=>p.membershipId===use?.membershipId);if(pass&&!money.read().members.some(m=>m.memberId===pass.memberId))return posFailure('MEMBER_NOT_FOUND','CONFLICT');
    if(!use)return contextRequired;if(use.canceledAt)return {ok:true,revision:data.getSnapshot().revision,duplicate:true};
    const settlement=money.read().state.settlements.find(s=>s.allocations.some(a=>a.useId===use.useId));if(!settlement)return contextRequired;
    const prepared=money.read().sources.find(s=>s.sourceRef.id===settlement.sourceRef.id)?.prepared;
    return toData(money.reverse({quote:money.quoteReversal({settlementId:settlement.settlementId,kind:prepared?'refund':'cancel'}),idempotencyKey:command.idempotencyKey??`restore-use:${use.useId}`}));
  });
  data.bindMoneyBusy(()=>moneyApproval?.status==='pending');
  data.bindCustomDispatch(command=>custom.dispatch(command),()=>approval?.status==='pending', (token, nextPos) => {
    const blocked = guardCustom();
    if (blocked) return blocked;
    if (customBusy()) return customFailure('APPROVAL_BUSY');
    const { posRevision, posUi } = run.getState();
    const command = { type: 'pos.commit' as const, expectedPosRevision: posRevision, nextPos };
    const result = transact({ ...command, nextUi: posUi }, { ...command, undoPickupToken: token });
    return result.ok ? { ok: true, revision: result.revision, noticeKey: 'data.notice.undone' } : result;
  });
  return {
    capture, commit, pos, custom, money,
    setCctvPosLink(input,activeZoneIds){
      const command={type:'settings.setCctvPosLink',...input};const replay=data.replay(command);if(replay)return replay;
      const planned=planLink(data.getSnapshot().tables.shopSettings,input,activeZoneIds);if(!planned.ok)return planned;
      const result:DataCommandResult={ok:true,revision:data.getSnapshot().revision+(planned.status==='applied'?1:0),value:planned.value};
      if(planned.status==='unchanged'){data.remember(command,result);return result;}
      const source=planned.settings;
      const outcome=transact({type:'update-settings',settings:source},{type:'shop.updateSettings',...source,paymentStyle:source.paymentStyle!,baseRevision:data.getSnapshot().revision,commandRecord:ledger(command,result)});
      return outcome.ok?result:outcome;
    },
    pruneCctvPosLinks(activeZoneIds){const current=data.getSnapshot().tables.shopSettings;const settings=pruneLinks(current,activeZoneIds);return settings===current?success():transact({type:'update-settings',settings},{type:'shop.updateSettings',...settings,paymentStyle:settings.paymentStyle!,baseRevision:data.getSnapshot().revision});},
    completeOnboarding(templateId, expected) {
      const { onboarding: { draft }, shopSettings } = run.getState();
      const { posPreferences } = normalizePosSettings({ ...draft, revision: shopSettings.revision + 1 });
      return transact({ type: 'complete-onboarding', templateId }, { type: 'onboarding.setAnswers', ...draft, posPreferences, paymentStyle: draft.paymentStyle!, baseRevision: data.getSnapshot().revision }, expected);
    },
    updateSettings(settings, expected) {
      settings = normalizePosSettings({ ...settings, cctvPosLinks:settings.cctvPosLinks ?? data.getSnapshot().tables.shopSettings.cctvPosLinks, posPreferences: settings.posPreferences ?? data.getSnapshot().tables.shopSettings.posPreferences });
      return transact({ type: 'update-settings', settings }, { type: 'shop.updateSettings', ...settings, paymentStyle: settings.paymentStyle!, baseRevision: data.getSnapshot().revision }, expected);
    },
  };
}
export const SessionActionsContext = createContext<SessionActions | null>(null);
export const SessionActionsProvider = SessionActionsContext.Provider;
export function useSessionActions(): SessionActions {
  const actions = useContext(SessionActionsContext);
  if (!actions) throw new Error('SessionActionsProvider가 필요해요');
  return actions;
}

export type SharedMoneyCompletion=MoneyCompletion&{readonly orderNo?:number};
export interface MoneyApprovalState {
  readonly status:'pending'|'succeeded'|'failed';readonly runId:string;readonly attemptId:string;readonly quote:SettlementQuote;
  readonly result?:PosResult<SharedMoneyCompletion>;
}
export interface PartialMoneyReversalQuote {
  readonly quoteId:string;readonly quoteRevision:number;readonly billId:string;readonly settlementIds:readonly string[];readonly kind:'cancel';readonly amount:number;readonly remainingRefundable:number;
  readonly realMethodReturns:MoneyReversalQuote['realMethodReturns'];readonly accountEffects:MoneyReversalQuote['accountEffects'];readonly membershipEffects:MoneyReversalQuote['membershipEffects'];readonly recognitionEffects:MoneyReversalQuote['recognitionEffects'];readonly canSubmit:boolean;readonly issues:MoneyReversalQuote['issues'];
}
export interface MoneyCoordinator {
  read():MoneyRead;subscribe(listener:()=>void):()=>void;approval():MoneyApprovalState|null;
  quoteSettlement(input:{readonly target:SettlementTarget;readonly allocations:readonly SettlementAllocation[]}):SettlementQuote;
  quoteSale(input:{readonly billId:string;readonly partId?:string;readonly allocations:readonly SettlementAllocation[]}):SettlementQuote;
  beginApproval(input:{readonly quote:SettlementQuote;readonly idempotencyKey:string}):PosResult<SharedMoneyCompletion&{readonly attemptId?:string}>;
  finishApproval(input:{readonly runId:string;readonly attemptId:string;readonly outcome:'approved'|'failed'}):PosResult<SharedMoneyCompletion>;
  dismissApproval():boolean;
  receipt(input:{readonly settlementId?:string;readonly paymentId?:string}):ReturnType<typeof selectMoneyReceipt>;
  quoteReversal(input:MoneyReversalQuote['input']):MoneyReversalQuote;
  reverse(input:{readonly quote:MoneyReversalQuote;readonly idempotencyKey:string;readonly cancelOrder?:boolean}):PosResult<SharedMoneyCompletion>;
  quotePartialCancellation(billId:string):PartialMoneyReversalQuote;
  cancelPartial(input:{readonly quote:Pick<PartialMoneyReversalQuote,'quoteId'|'settlementIds'>;readonly idempotencyKey:string}):PosResult<SharedMoneyCompletion>;
  materializeServiceDay(date:string):PosResult<SharedMoneyCompletion>;
}

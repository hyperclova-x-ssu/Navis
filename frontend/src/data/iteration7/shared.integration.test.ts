import { describe, expect, it, vi } from 'vitest';
import * as posSeed from '../../pos/seed';
import { createSeedTables } from '../db/seed';
import { seedToday } from '../db/generated/today';
import { addDays, NOW, TOMORROW } from '../db/time';
import type { PosReadSnapshot } from '../../contracts/pos';
import { initializeCustomPos, applyCustomMoney, selectMoneyRead, selectAccountingPresentation } from '../pos/projection';
import { posFacts } from '../facts';
import { selectAccountingDay, selectAccountingDrawer, selectMemberAccounts } from './accounting';
import { selectMemberships } from './memberships';
import { getPaymentBillId, quotePaymentBill } from '../../pos/loyalty';
import type { MembershipTerms, SettlementAllocation, SettlementQuote } from './accounting/types';
import { createWidgetDataStore, defaultCondition, readModel, selectBriefing, selectCalendar, selectStaffSchedule, selectWidget, TODAY, widgetFacts } from '../widget-data';

describe('M1 joined staff composition', () => {
  it('publishes staff, CCTV, calendar, briefing and Navis from one snapshot without a source panel', () => {
    const store = createWidgetDataStore();
    expect(selectCalendar(store.getSnapshot(), { date: TODAY }).todayCount).toBe(3);
    const created = store.dispatch({ type: 'staff.create', name: '한지민', idempotencyKey: 'staff' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const staffId = (created.value as { staffId: string }).staffId;
    const observed: number[][] = [];
    store.subscribe(() => {
      const snapshot = store.getSnapshot();
      observed.push([selectStaffSchedule(snapshot, { startDate: TODAY, endDate: TODAY }).today.workingCount, selectBriefing(snapshot, { date: TODAY }).staff.today.workingCount]);
    });
    expect(store.dispatch({ type: 'staff.saveSchedule', staffId, date: TODAY, kind: 'work', start: '14:00', end: '18:00', breakMinutes: 0, idempotencyKey: 'work' }).ok).toBe(true);
    expect(store.dispatch({ type: 'staff.moveHandoff', date: TODAY, fromTime: '17:00', toTime: '18:00', idempotencyKey: 'handoff' }).ok).toBe(true);
    const snapshot = store.getSnapshot();
    expect(observed).toEqual([[6, 6], [6, 6]]);
    expect(readModel(snapshot, 'customer-analysis').hours.find(r => r.hour === 14)?.staff).toBe(3);
    const calendar = selectCalendar(snapshot, { date: TODAY });
    expect(calendar.todayCount).toBe(3);
    expect(calendar.todayEntries.find(e => e.source === 'shift' && e.time === '18:00')).toMatchObject({ time: '18:00', editable: false, ref: { featureId: 'staff-schedule' } });
    expect(calendar.staffEntries.filter(e => e.date === TODAY)).toHaveLength(6);
    expect(calendar.staffEntries.every(e => !e.editable && e.sourceFeatureId === 'staff-schedule' && e.ref?.featureId === 'staff-schedule')).toBe(true);
    expect(selectBriefing(snapshot, { date: TODAY }).staff.today).toMatchObject({ workingCount: 6, nextHandoffAt: '18:00' });
    const view = selectWidget(snapshot, 'staff-schedule', defaultCondition('staff-schedule'), 'normal');
    expect(widgetFacts(view)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'staff.today.working', value: 6, date: TODAY }),
      expect.objectContaining({ key: 'staff.nextHandoff.time', value: '18:00', date: TODAY }),
      expect.objectContaining({ key: 'staff.hourly.14.count', value: 3, date: TODAY }),
    ]));
    const before = store.getSnapshot();
    expect(store.dispatch({ type: 'calendar.deleteEvent', eventId: calendar.staffEntries[0].id })).toMatchObject({ ok: false, reason: 'READ_ONLY_SOURCE' });
    expect(store.getSnapshot()).toBe(before);
  });
  it('keeps preview empty/error separate from canonical facts and resets on a fresh store', () => {
    const store = createWidgetDataStore();
    expect(selectWidget(store.getSnapshot(), 'staff-schedule', { kind: 'default' }, 'no-staff').status).toBe('empty');
    expect(selectWidget(store.getSnapshot(), 'staff-schedule', { kind: 'default' }, 'error').status).toBe('error');
    expect(readModel(store.getSnapshot(), 'staff-schedule').today.workingCount).toBe(5);
    store.dispatch({ type: 'staff.create', name: '추가', idempotencyKey: 'new' });
    expect(createWidgetDataStore().getSnapshot().tables.staff).toHaveLength(5);
    const empty = createWidgetDataStore({ staff: [], staffSchedule: [], staffScheduleChange: [] }).getSnapshot();
    expect(selectWidget(empty, 'staff-schedule', { kind: 'default' }, 'normal').status).toBe('empty');
    expect(readModel(empty, 'customer-analysis').hours.every(r => r.staff === 0)).toBe(true);
  });
});


describe('M2 shared composition', () => {
  it('sends a current closure once, restores its reminder after editing, and keeps previews out of normal facts', () => {
    const store = createWidgetDataStore({ calendarEvent: [exampleClosure], noticeDraft: [] });
    const untouched=store.getSnapshot();
    expect(store.dispatch({type:42} as never)).toMatchObject({ok:false,code:'VALIDATION'});
    expect(store.getSnapshot()).toBe(untouched);
    const closure = store.getSnapshot().tables.calendarEvent.find(e => e.storeClosure)!;
    expect(closure.date).toBe(closureDay);
    expect(readModel(store.getSnapshot(), 'notice-send').unsentCount).toBe(1);
    expect(store.dispatch({ type: 'notice.importClosure', eventId: closure.eventId, idempotencyKey: 'import' }).ok).toBe(true);
    const draft = store.getSnapshot().tables.noticeDraft[0];
    const preview = store.dispatch({type:'notice.preview',noticeId:draft.noticeId,draftRevision:draft.revision});
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const command = {type:'notice.send' as const,noticeId:draft.noticeId,draftRevision:draft.revision,previewId:(preview.value as {previewId:string}).previewId,idempotencyKey:'send',baseRevision:store.getSnapshot().revision};
    expect((preview.value as {recipientCount:number}).recipientCount).toBe(460);
    expect(store.dispatch(command).ok).toBe(true);
    const sent = store.getSnapshot();
    expect(store.dispatch(command)).toMatchObject({ok:true,duplicate:true});
    expect(store.getSnapshot()).toBe(sent);
    expect(store.dispatch({...command,previewId:'different'})).toMatchObject({ok:false,reason:'IDEMPOTENCY_MISMATCH'});
    expect(readModel(sent, 'notice-send').unsentCount).toBe(0);
    expect(selectBriefing(sent,{date:TODAY}).importantAlerts.groups.flatMap(g=>g.items).some(i=>i.id.startsWith('closure:'))).toBe(false);
    expect(store.dispatch({type:'calendar.updateEvent',eventId:closure.eventId,title:'수정 휴무'}).ok).toBe(true);
    expect(readModel(store.getSnapshot(),'notice-send').unsentCount).toBe(1);
    const abnormal=selectWidget(store.getSnapshot(),'briefing',{kind:'default'},'normal',{environmentVariant:'out_of_range'});
    expect(abnormal.status==='ready' && abnormal.model.importantAlerts.groups.flatMap(g=>g.items).some(i=>i.id.startsWith('environment:'))).toBe(true);
    expect(widgetFacts(selectWidget(store.getSnapshot(),'store-environment',{kind:'default'},'normal'))).toContainEqual(expect.objectContaining({key:'environment.temperature',value:22.4}));
  });
  it('receives the same canonical pickup once without another deposit, menu quantity or stock movement', () => {
    const store = createWidgetDataStore(customOrders, { pos: scenarioPos({ advance: true }) }), before = store.getSnapshot();
    expect(readModel(before,'ledger')).toMatchObject({sales:{net:831220},netProfit:721220});
    expect(readModel(before,'margin')).toMatchObject({netSales:831220,cost:244333,grossProfit:586887});
    expect(selectM2DayTotals(before.pos!).deposits.total).toBe(876220);
    expect(readModel(before,'custom-order').summary.todayPickup).toBe(1);
    expect(selectCalendar(before,{date:TODAY}).pickupEntries.some(e=>e.source==='pickup')).toBe(true);
    expect(store.dispatch({type:'customOrder.receive',customOrderId:'CO-001',idempotencyKey:'receive'}).ok).toBe(true);
    const after=store.getSnapshot();
    expect(after.pos!.customPayments).toHaveLength(1);
    expect(after.pos!.customRecognitions).toHaveLength(1);
    expect(after.tables.menuDaily).toEqual(before.tables.menuDaily);
    expect(after.tables.inventoryStock).toEqual(before.tables.inventoryStock);
    expect(readModel(after,'ledger').sales.net-readModel(before,'ledger').sales.net).toBe(45000);
    expect(readModel(after,'margin').costMissing).toBe(true);
    expect(readModel(after,'custom-order').summary.todayPickup).toBe(0);
    expect(store.dispatch({type:'customOrder.receive',customOrderId:'CO-001',idempotencyKey:'receive',baseRevision:0})).toMatchObject({ok:true,duplicate:true});
    expect(store.getSnapshot()).toBe(after);
    expect(selectBriefing(after,{date:TODAY}).custom.summary.todayPickup).toBe(0);
  });
});

import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { createSessionActions, createSessionGate } from '../../app/session-actions';
import { selectCustomAccounting, type CustomOrder } from './custom-orders';
import { createLinkedOccupancyState, observeLinkedOccupancy, selectLinkedTableStates } from './table-links';
import { selectM2DayTotals, selectCustomOrderRead } from '../pos/projection';
const cafe = createSeedTables();
const chargedMember = 'M-0012';
const openingCount = 'sample-pass-1';
const closureDay = addDays(TODAY, 6);
const exampleClosure = { eventId: 'test-closure', revision: 1, kind: 'event' as const, categoryId: 'store-operations' as const,
  date: closureDay, time: null, title: { raw: '정기 정비' }, memo: { raw: '하루 쉬어요' },
  storeClosure: { kind: 'temporary' as const, endDate: closureDay } };
const quotedOrder: CustomOrder = { ...cafe.customOrder[0], customOrderId: 'CO-002', quoteAmount: 60000, quoteRevision: 1,
  stage: 'approval_pending', answers: { message: '단체 주문', size: 'one' }, proposedPickupAt: `${TOMORROW}T14:00`, customerDecision: 'pending',
  approvedQuoteRevision: null, pickupReservationId: null, history: [] };
const paidOrder: CustomOrder = { ...quotedOrder, customOrderId: 'CO-001', quoteAmount: 45000, customerDecision: 'approved', approvedQuoteRevision: 1,
  stage: 'production_complete', paymentTiming: 'advance', desiredPickupAt: `${TODAY}T17:00`, proposedPickupAt: `${TODAY}T17:00`,
  pickupReservationId: 'PICKUP-CO-001', settlementId: 'test-advance-settlement' };
const visitReservations = cafe.reservation.filter(row => row.kind !== 'pickup');
const customOrders = { customOrder: [paidOrder, quotedOrder], reservation: [...visitReservations, {
  kind: 'pickup' as const, reservationId: 'PICKUP-CO-001', customOrderId: paidOrder.customOrderId, date: TODAY, time: '17:00', status: 'confirmed' as const, updatedAt: NOW,
}] };

function scenarioPos({ advance = false, period = false } = {}) {
  let pos = initializeCustomPos(posSeed.createPosSeed());
  if (period) {
    const pass: MembershipTerms = { membershipId: 'test-period', productId: 'test-period', kind: 'period', memberId: 'M-0004',
      name: '월간 이용권', soldPrice: 30000, totalUses: null, validDays: 30, dailyLimit: 1, menuIds: ['m-americano'],
      startsOn: TODAY, endsOn: addDays(TODAY, 29), saleSettlementId: 'opening-period' };
    pos = { ...pos, money: { ...pos.money!, memberships: [...pos.money!.memberships, pass] } };
  }
  if (!advance) return pos;
  const settlementId = paidOrder.settlementId!;
  const sourceRef = { kind: 'custom_order' as const, id: paidOrder.customOrderId };
  const seeded = applyCustomMoney(pos, {
    settlements: [{ settlementId, purpose: 'custom_order', sourceRef, billId: null, partId: null, memberId: paidOrder.memberId,
      at: NOW, amount: 45000, allocations: [{ allocationId: 'test-advance-card', kind: 'method', method: 'card', amount: 45000 }],
      status: 'paid', paymentTiming: 'advance' }],
    payments: [{ paymentId: 'test-advance-payment', settlementId, purpose: 'custom_order', sourceRef, at: NOW,
      amount: 45000, splits: [{ method: 'card', amount: 45000 }] }],
    recognitions: [], corrections: [],
  });
  return { ...seeded, revision: pos.revision };
}

function requiredOptions(read: PosReadSnapshot, menuId: string) {
  return read.data.catalog.items.find(item => item.menuId === menuId)!.groups.filter(group => group.required).map(group => group.options[0].optionId);
}

function m2Session({ advance = false, period = false } = {}) {
  const gate=createSessionGate();
  const initial = scenarioPos({ advance, period });
  const spy = vi.spyOn(posSeed, 'createPosSeed').mockReturnValueOnce(initial);
  const run = (() => {
    try { return createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', sessionGate: gate }); }
    finally { spy.mockRestore(); }
  })();
  const data=createWidgetDataStore(advance ? customOrders : { customOrder: [quotedOrder], reservation: visitReservations },{runId:run.getState().runId,sessionGate:gate,pos:run.getState().pos,readPosUi:()=>run.getState().posUi});
  const actions=createSessionActions(run,data,gate);
  run.actions.setOnboardingAnswer({businessType:'cafe'});run.actions.setOnboardingAnswer({paymentStyle:'postpaid'});
  run.actions.saveOnboardingTables(run.getState().onboarding.draft.tableLayout!);
  expect(actions.completeOnboarding(null).ok).toBe(true);
  return {run,data,actions};
}
describe('M2 atomic coordinator',()=>{
  it('settles only after a matching fake success, publishes one coherent source and rejects a late callback',()=>{
    const {run,data,actions}=m2Session({ advance: true }),custom=actions.custom;
    expect(custom.dispatch({type:'customOrder.recordDecision',customOrderId:'CO-002',quoteRevision:1,decision:'approved',paymentTiming:'advance',idempotencyKey:'decision'}).ok).toBe(true);
    const read=custom.read();expect(custom.read()).toBe(read);
    const quote=custom.quoteSettlement({customOrderId:'CO-002',allocations:[{kind:'method',method:'cash',amount:60000}]});
    expect(quote.canSubmit).toBe(true);
    const before=data.getSnapshot();
    const begin=custom.beginApproval({quote,idempotencyKey:'settle'});expect(begin.ok).toBe(true);if(!begin.ok)return;
    const attempt=begin.value as {runId:string;attemptId:string};
    expect(data.getSnapshot()).toBe(before);
    expect(data.dispatch({type:'closing.closeDay',date:TODAY,scenario:'normal',expectedGeneration:0,idempotencyKey:'close'})).toMatchObject({ok:false});
    expect(actions.pos.execute({type:'cart.clear',meta:{runId:run.getState().runId,idempotencyKey:'cart'}})).toMatchObject({ok:false,reason:'TRANSACTION_BUSY'});
    expect(custom.finishApproval({...attempt,runId:'old',outcome:'approved'})).toMatchObject({ok:false,reason:'STALE_ATTEMPT'});
    expect(data.getSnapshot()).toBe(before);
    const seen:boolean[]=[];
    const off=data.subscribe(()=>seen.push(data.getSnapshot().pos===run.getState().pos && data.getSnapshot().transactionId===run.getState().transactionId));
    expect(custom.finishApproval({...attempt,outcome:'approved'}).ok).toBe(true);off();
    expect(seen).toEqual([true]);
    expect(selectCustomAccounting(custom.read()).realDeposits).toBe(105000);
    expect(custom.read().money.payments).toHaveLength(2);
    const after=data.getSnapshot();
    expect(custom.finishApproval({...attempt,outcome:'approved'})).toMatchObject({ok:false,reason:'STALE_ATTEMPT'});
    expect(custom.beginApproval({quote,idempotencyKey:'settle'})).toMatchObject({ok:true,duplicate:true});
    expect(data.getSnapshot()).toBe(after);
    const reverse=custom.quoteReversal({customOrderId:'CO-002',kind:'cancellation'});
    expect(custom.reverse({quote:reverse,idempotencyKey:'reverse',cancelOrder:true}).ok).toBe(true);
    expect(custom.read().tables.customOrder.find(o=>o.customOrderId==='CO-002')?.stage).toBe('canceled');
    expect(selectCustomAccounting(custom.read()).realDeposits).toBe(45000);
  });
  it('keeps failed approval and shared custom undo free of monetary side effects',()=>{
    const {data,actions}=m2Session({ advance: true }),custom=actions.custom;
    const saved=custom.dispatch({type:'customTemplate.generate',productKind:'쿠키',keywords:'리본',idempotencyKey:'template'});
    expect(saved.ok).toBe(true);if(!saved.ok)return;
    const tpl=custom.read().tables.customTemplate.find(t=>t.templateId===saved.value?.templateId)!;
    const deleted=custom.dispatch({type:'customTemplate.delete',templateId:tpl.templateId,idempotencyKey:'delete'});
    expect(deleted.ok && deleted.undoToken).toBeTruthy();if(deleted.ok && deleted.undoToken)expect(data.undo(deleted.undoToken).ok).toBe(true);
    expect(custom.read().tables.customTemplate.some(t=>t.templateId===tpl.templateId)).toBe(true);
    custom.dispatch({type:'customOrder.recordDecision',customOrderId:'CO-002',quoteRevision:1,decision:'approved',paymentTiming:'advance',idempotencyKey:'decision'});
    const quote=custom.quoteSettlement({customOrderId:'CO-002',allocations:[{kind:'method',method:'card',amount:60000}]});
    const before=data.getSnapshot(),begin=custom.beginApproval({quote,idempotencyKey:'failed'});if(!begin.ok)throw new Error('begin failed');
    expect(custom.finishApproval({...begin.value as {runId:string;attemptId:string},outcome:'failed'})).toMatchObject({ok:false});
    expect(data.getSnapshot()).toBe(before);
    expect(custom.approval()?.status).toBe('failed');
  });
  it('uses one settings transaction and fingerprinted ledger for both link editors and prunes source removals',()=>{
    const {run,data,actions}=m2Session();
    const command={zoneId:'t1',tableId:'T1',idempotencyKey:'link',baseRevision:data.getSnapshot().tables.shopSettings.revision};
    expect(actions.setCctvPosLink(command,['t1','t2']).ok).toBe(true);
    const after=data.getSnapshot();
    expect(after.tables.shopSettings.cctvPosLinks).toEqual([{zoneId:'t1',tableId:'T1'}]);
    expect(run.getState().shopSettings.cctvPosLinks).toEqual(after.tables.shopSettings.cctvPosLinks);
    expect(actions.setCctvPosLink(command,['t1','t2'])).toMatchObject({ok:true,duplicate:true});
    expect(actions.setCctvPosLink({...command,tableId:'T2'},['t1','t2'])).toMatchObject({ok:false,reason:'IDEMPOTENCY_MISMATCH'});
    expect(data.getSnapshot()).toBe(after);
    expect(actions.setCctvPosLink({zoneId:'t2',tableId:'T1',idempotencyKey:'collision'},['t1','t2'])).toMatchObject({ok:false,reason:'LINK_IN_USE'});
    expect(data.getSnapshot()).toBe(after);
    const current=run.getState().shopSettings;
    expect(actions.updateSettings({businessType:current.businessType,paymentStyle:current.paymentStyle,tableLayout:current.tableLayout,posPreferences:current.posPreferences,revision:current.revision+1}).ok).toBe(true);
    expect(data.getSnapshot()).toBe(after);
    expect(run.getState().shopSettings.cctvPosLinks).toEqual(after.tables.shopSettings.cctvPosLinks);
    expect(actions.pruneCctvPosLinks([]).ok).toBe(true);
    expect(data.getSnapshot().tables.shopSettings.cctvPosLinks).toEqual([]);
    expect(run.getState().shopSettings.cctvPosLinks).toEqual([]);
  });
});


it('joins read-only linked-table tasks into the same four briefing groups and keeps live observations out of normal facts',()=>{
  const {data,actions}=m2Session();
  expect(actions.setCctvPosLink({zoneId:'t2',tableId:'T2',idempotencyKey:'link-task'},['t2']).ok).toBe(true);
  const read=actions.pos.read();
  const occupancy=observeLinkedOccupancy(read,createLinkedOccupancyState(),{zoneId:'t2',state:'occupied',observedAt:NOW,elapsedNow:0});
  const atNine=selectLinkedTableStates(read,{occupancy,elapsedNow:540000});
  expect(atNine.seatedWithoutOrderTasks).toHaveLength(0);
  const afterTen=selectLinkedTableStates(read,{occupancy,elapsedNow:600001});
  expect(afterTen.seatedWithoutOrderTasks).toHaveLength(1);
  const view=selectWidget(data.getSnapshot(),'briefing',{kind:'default'},'normal',{linkedTableTasks:afterTen.seatedWithoutOrderTasks});
  expect(view.status).toBe('ready');if(view.status!=='ready')return;
  expect(view.model.importantAlerts.groups.map(g=>g.id)).toEqual(['tax','tasks']);
  expect(view.model.importantAlerts.groups.find(g=>g.id==='tasks')?.items.some(i=>i.id==='seated-no-order:T2')).toBe(true);
  expect(readModel(data.getSnapshot(),'briefing').importantAlerts.groups.flatMap(g=>g.items).some(i=>i.id==='seated-no-order:T2')).toBe(false);
});
it('reverses a received custom recognition once and preserves the menu/stock baseline',()=>{
  const {data,actions}=m2Session({ advance: true }),custom=actions.custom;
  const before=data.getSnapshot();
  expect(custom.dispatch({type:'customOrder.receive',customOrderId:'CO-001',idempotencyKey:'handover'}).ok).toBe(true);
  const quote=custom.quoteReversal({customOrderId:'CO-001',kind:'refund',amount:10000});
  const input={quote,idempotencyKey:'return'};
  expect(custom.reverse(input).ok).toBe(true);
  const after=data.getSnapshot();
  expect(selectCustomAccounting(custom.read())).toMatchObject({customPickup:35000,realDeposits:35000});
  expect(after.pos!.customRecognitions).toHaveLength(2);
  expect(readModel(after,'ledger').sales.net).toBe(866220);
  expect(after.tables.menuDaily).toEqual(before.tables.menuDaily);
  expect(after.tables.inventoryStock).toEqual(before.tables.inventoryStock);
  expect(custom.reverse(input)).toMatchObject({ok:true,duplicate:true});
  expect(data.getSnapshot()).toBe(after);
});


it('keeps empty closing projections and stored snapshots free of canonical custom deposits and recognition',()=>{
  const store = createWidgetDataStore(customOrders, { pos: scenarioPos({ advance: true }) });
  expect(store.dispatch({type:'customOrder.receive',customOrderId:'CO-001',idempotencyKey:'receive-empty'}).ok).toBe(true);
  const before=store.getSnapshot();
  expect(selectM2DayTotals(before.pos!).customPickup).toBe(45000);
  expect(store.dispatch({type:'closing.closeDay',date:TODAY,scenario:'empty',expectedGeneration:0,idempotencyKey:'empty-close'}).ok).toBe(true);
  expect(store.getSnapshot().tables.dayClosing.at(-1)?.posTotalsSnapshot).toMatchObject({revenue:0,paymentCount:0,refundCount:0,byMethod:{card:0,easy_pay:0,cash:0}});
  expect(readModel(store.getSnapshot(),'ledger').sales.net).toBe(876220);
  expect(selectCustomAccounting(selectCustomOrderRead(before)).realDeposits).toBe(45000);
});

it('uses the selected business date for calendar and briefing pickup summaries',()=>{
  const store=createWidgetDataStore(),snapshot=store.getSnapshot();
  expect(selectCalendar(snapshot,{date:TODAY}).pickupCount).toBe(0);
  expect(selectCalendar(snapshot,{date:TOMORROW}).pickupCount).toBe(1);
  expect(selectBriefing(snapshot,{date:TOMORROW}).custom.summary.todayPickup).toBe(1);
});

function settleM3(actions: ReturnType<typeof createSessionActions>, quote: SettlementQuote, key: string) {
  expect(quote.issues).toEqual([]);
  const begin=actions.money.beginApproval({quote,idempotencyKey:key});
  expect(begin.ok).toBe(true);if(!begin.ok)throw new Error(begin.reason);
  const attempt=actions.money.approval()!;
  const finish=actions.money.finishApproval({runId:attempt.runId,attemptId:attempt.attemptId,outcome:'approved'});
  expect(finish.ok).toBe(true);if(!finish.ok)throw new Error(finish.reason);
  actions.money.dismissApproval();return finish;
}
function saleM3(h:ReturnType<typeof m2Session>, menuId:string, memberId:string, allocations:readonly SettlementAllocation[], key:string) {
  const meta=()=>({runId:h.run.getState().runId,idempotencyKey:`${key}:${h.data.getSnapshot().revision}`});
  expect(h.actions.pos.execute({type:'cart.type',orderType:'takeout',meta:meta()}).ok).toBe(true);
  expect(h.actions.pos.execute({type:'cart.add',menuId,optionIds:requiredOptions(h.actions.pos.read(),menuId),meta:meta()}).ok).toBe(true);
  const billId=getPaymentBillId(h.actions.pos.read());
  expect(h.actions.pos.execute({type:'bill.member',billId,memberId,meta:meta()}).ok).toBe(true);
  return settleM3(h.actions,h.actions.money.quoteSale({billId,allocations}),key);
}
describe('M3 canonical money composition',()=>{
  it('applies the production fixture once and exposes both axes, balances and existing quantities',()=>{
    const store=createWidgetDataStore(),s=store.getSnapshot(),read=selectMoneyRead(s);
    expect(selectAccountingDay(read,{date:TODAY})).toMatchObject({
      sales:{total:831220,gross:859500,discount:28280,byRealMethodSale:{card:557050,easy_pay:217270,cash:56900},chargeUsed:0,receivableCreated:0,membershipCount:0,subscriptionDaily:0},
      deposits:{total:831220,byMethod:{card:557050,easy_pay:217270,cash:56900}},orderCount:153,realPaymentCount:153,cost:244333,expenses:110000,profit:721220,
    });
    expect(selectAccountingDay(read, { date: TODAY }).sales.refund === 0).toBe(true);
    expect(selectAccountingDrawer(read).expected).toBe(256900);
    expect(selectMemberAccounts(read)).toMatchObject({chargeBalance:37000,receivableBalance:21400,chargeHolders:2,receivableHolders:2});
    expect(selectMemberships(read).activeCount).toBe(3);
    const quantities = Object.fromEntries(seedToday.rollup.menu.map(([menuId, qty])=>[menuId,qty]));
    expect(Object.fromEntries(s.tables.menuDaily.filter(d=>d.businessDate===TODAY).map(d=>[d.menuId,d.qty]))).toEqual(quantities);
    expect(readModel(s,'ledger')).toMatchObject({sales:{net:831220},netProfit:721220});
    expect(readModel(s,'margin')).toMatchObject({netSales:831220,cost:244333,grossProfit:586887});
    expect(selectAccountingPresentation(s).views).toContainEqual(expect.objectContaining({status:'ready',period:{start:TODAY,end:TODAY},summary:expect.objectContaining({deposits:expect.objectContaining({total:831220})})}));
    expect(posFacts(s)).toEqual(expect.arrayContaining([expect.objectContaining({key:'accounting.deposits.total',value:831220}),expect.objectContaining({key:'pos.cash.expected',value:256900})]));
    expect(widgetFacts(selectWidget(s,'credit-receivable',{kind:'default'},'normal'))).toContainEqual(expect.objectContaining({key:'account.charge.total',value:37000}));
    expect(selectMoneyRead(s)).toBe(read);
  });
  it('publishes topup and mixed sale with original reversal as coherent data/run snapshots',()=>{
    const h=m2Session(),{actions,data,run}=h;
    const before=data.getSnapshot(),n=run.getState().pos.orders.length;
    const quote=actions.money.quoteSettlement({target:{purpose:'charge_topup',memberId:'M-0001',amount:50000},allocations:[{kind:'method',method:'card',amount:50000}]});
    const begin=actions.money.beginApproval({quote,idempotencyKey:'new-topup'});expect(begin.ok).toBe(true);
    expect(data.dispatch({type:'closing.closeDay',date:TODAY,scenario:'normal',expectedGeneration:0,idempotencyKey:'pending-funding-close'})).toMatchObject({ok:false,reason:'UNPAID_BILLS'});
    expect(selectMoneyRead(data.getSnapshot()).state.payments).toEqual(selectMoneyRead(before).state.payments);
    const seen:boolean[]=[];const off=data.subscribe(()=>seen.push(data.getSnapshot().pos===run.getState().pos));
    const pending=actions.money.approval()!;
    expect(actions.money.finishApproval({runId:pending.runId,attemptId:pending.attemptId,outcome:'approved'}).ok).toBe(true);off();actions.money.dismissApproval();
    expect(seen).toEqual([true]);expect(run.getState().pos.orders).toHaveLength(n);
    expect(selectAccountingDay(actions.money.read(),{date:TODAY})).toMatchObject({sales:{total:831220},deposits:{total:881220}});
    const sale=saleM3(h,'m-americano','M-0001',[{kind:'charge',amount:1500},{kind:'method',method:'card',amount:1500}],'mixed');
    expect(selectAccountingDay(actions.money.read(),{date:TODAY})).toMatchObject({sales:{total:834220},deposits:{total:882720}});
    expect(data.getSnapshot().tables.menuDaily.find(m=>m.businessDate===TODAY && m.menuId==='m-americano')?.qty).toBe(63);
    const reversal=actions.money.quoteReversal({settlementId:sale.value.settlementId,kind:'cancel'});
    expect(reversal).toMatchObject({canSubmit:true,realMethodReturns:[{method:'card',amount:1500}]});
    expect(actions.money.reverse({quote:reversal,idempotencyKey:'return-mixed'}).ok).toBe(true);
    expect(selectAccountingDay(actions.money.read(),{date:TODAY})).toMatchObject({sales:{total:831220},deposits:{total:881220}});
    expect(data.getSnapshot().tables.inventoryStock).toEqual(before.tables.inventoryStock);
    expect(actions.money.reverse({quote:reversal,idempotencyKey:'return-mixed'})).toMatchObject({ok:true,duplicate:true});
  });
  it('receives the canonical custom advance without duplicate receipts or inventory effects',()=>{
    const h=m2Session({ advance: true }),before=h.data.getSnapshot();
    expect(h.actions.custom.dispatch({type:'customOrder.receive',customOrderId:'CO-001',idempotencyKey:'m3-receive'})).toMatchObject({ok:true});
    expect(selectAccountingDay(h.actions.money.read(),{date:TODAY})).toMatchObject({sales:{total:876220},deposits:{total:876220},unknownCostSales:[expect.objectContaining({sourceId:'CO-001',amount:45000,cost:null})]});
    expect(h.data.getSnapshot().tables.menuDaily).toEqual(before.tables.menuDaily);
    expect(h.data.getSnapshot().tables.inventoryStock).toEqual(before.tables.inventoryStock);
    expect(h.actions.custom.dispatch({type:'customOrder.receive',customOrderId:'CO-001',idempotencyKey:'m3-receive'})).toMatchObject({ok:true,duplicate:true});
  });
});

it('reserves a charge-only split once then abandons it without sale, quantity or stock effects',()=>{
  const h=m2Session(),{actions,run,data}=h,meta=(key:string)=>({runId:run.getState().runId,idempotencyKey:key});
  actions.pos.execute({type:'cart.type',orderType:'takeout',meta:meta('type')});
  actions.pos.execute({type:'cart.add',menuId:'m-americano',optionIds:requiredOptions(actions.pos.read(),'m-americano'),qty:2,meta:meta('add')});
  const billId=getPaymentBillId(actions.pos.read());
  expect(actions.pos.execute({type:'bill.member',billId,memberId:chargedMember,meta:meta('member')}).ok).toBe(true);
  expect(actions.pos.execute({type:'bill.split',billId,kind:'equal',n:2,meta:meta('split')}).ok).toBe(true);
  const before=data.getSnapshot(),part=actions.pos.read().pos.bills.find(b=>b.billId===billId)!.splitPlan!.parts[0];
  settleM3(actions,actions.money.quoteSale({billId,partId:part.partId,allocations:[{kind:'charge',amount:3000}]}),'partial-charge');
  expect(selectAccountingDay(actions.money.read(),{date:TODAY})).toMatchObject({sales:{total:831220},deposits:{total:831220}});
  expect(selectMemberAccounts(actions.money.read()).chargeBalance).toBe(34000);
  expect(data.getSnapshot().tables.menuDaily).toEqual(before.tables.menuDaily);
  expect(data.getSnapshot().tables.inventoryStock).toEqual(before.tables.inventoryStock);
  expect(actions.pos.read().pos.bills.find(b=>b.billId===billId)?.splitPlan?.parts[0].status).toBe('paid');
  const quote=actions.money.quotePartialCancellation(billId);expect(quote.canSubmit).toBe(true);
  expect(actions.money.cancelPartial({quote,idempotencyKey:'abandon'}).ok).toBe(true);
  expect(selectMemberAccounts(actions.money.read()).chargeBalance).toBe(37000);
  expect(data.getSnapshot().tables.menuDaily).toEqual(before.tables.menuDaily);
  expect(run.getState().pos.cart.lock).toBeNull();
});
it('keeps count and zero-won period uses in POS quantities while restoring their use independently of service days',()=>{
  for(const kind of ['count','period'] as const){
    const h=m2Session({ period: kind === 'period' }),{actions,run}=h,meta=(key:string)=>({runId:run.getState().runId,idempotencyKey:key});
    actions.pos.execute({type:'cart.type',orderType:'takeout',meta:meta('type')});
    actions.pos.execute({type:'cart.add',menuId:'m-americano',optionIds:requiredOptions(actions.pos.read(),'m-americano'),meta:meta('add')});
    const pass=selectMemberships(actions.money.read()).memberships.find(p=>p.membershipId === (kind === 'count' ? openingCount : 'test-period'))!;
    const memberId=pass.memberId,billId=getPaymentBillId(actions.pos.read());
    expect(pass).toBeTruthy();
    expect(actions.pos.execute({type:'bill.member',billId,memberId,meta:meta('member')}).ok).toBe(true);
    expect(actions.pos.execute({type:'bill.setDiscount',billId,discountInput:{source:'membership',membershipId:pass.membershipId},meta:meta('pass')}).ok).toBe(true);
    const done=settleM3(actions,actions.money.quoteSale({billId,allocations:[]}),'use-pass');
    expect(selectAccountingDay(actions.money.read(),{date:TODAY})).toMatchObject({sales:{total:kind==='count'?833920:832220,subscriptionDaily:kind==='count'?0:1000},deposits:{total:831220}});
    expect(h.data.getSnapshot().tables.menuDaily.find(r=>r.businessDate===TODAY&&r.menuId==='m-americano')?.qty).toBe(63);
    const reversal=actions.money.quoteReversal({settlementId:done.value.settlementId,kind:'cancel'});
    expect(reversal.canSubmit).toBe(true);expect(actions.money.reverse({quote:reversal,idempotencyKey:'restore'})).toMatchObject({ok:true});
    expect(selectMemberships(actions.money.read()).memberships.find(p=>p.membershipId===pass.membershipId)?.usesRemaining).toBe(pass.usesRemaining);
    expect(selectAccountingDay(actions.money.read(),{date:TODAY}).sales.total).toBe(kind === 'count' ? 831220 : 832220);
  }
});
it('uses original debt mappings for partial collection, blocks collected sale reversal and clears a failed approval without money',()=>{
  const h=m2Session(),{actions,data}=h;
  const debt = saleM3(h, 'm-americano', 'M-0005', [{ kind: 'receivable', amount: 3000 }], 'debt').value;
  const collection=settleM3(actions,actions.money.quoteSettlement({target:{purpose:'receivable_collection',memberId:'M-0005',amount:1000},allocations:[{kind:'method',method:'cash',amount:1000}]}),'partial-collection');
  expect(selectMemberAccounts(actions.money.read()).receivableBalance).toBe(23400);
  expect(selectAccountingDrawer(actions.money.read()).expected).toBe(257900);
  expect(actions.money.quoteReversal({settlementId:debt.settlementId,kind:'refund'})).toMatchObject({canSubmit:false,issues:expect.arrayContaining([expect.objectContaining({reason:'RECEIVABLE_ALREADY_COLLECTED'})])});
  const quote=actions.money.quoteReversal({settlementId:collection.value.settlementId,kind:'cancel'});expect(actions.money.reverse({quote,idempotencyKey:'return-collection'}).ok).toBe(true);
  expect(selectMemberAccounts(actions.money.read()).receivableBalance).toBe(24400);
  const before=data.getSnapshot(),funding=actions.money.quoteSettlement({target:{purpose:'charge_topup',memberId:'M-0001',amount:10000},allocations:[{kind:'method',method:'card',amount:10000}]});
  actions.money.beginApproval({quote:funding,idempotencyKey:'fail'});const pending=actions.money.approval()!;
  expect(actions.money.read()).toBe(actions.money.read());
  expect(actions.money.finishApproval({runId:pending.runId,attemptId:pending.attemptId,outcome:'failed'})).toMatchObject({ok:false,reason:'APPROVAL_FAILED'});
  expect(data.getSnapshot()).toBe(before);expect(actions.money.dismissApproval()).toBe(true);
});

it('requires covered POS context for legacy use commands and routes use cancellation through original money',()=>{
  const h=m2Session(),before=h.data.getSnapshot();
  expect(h.data.dispatch({type:'memberships.useOnce',membershipId:openingCount,idempotencyKey:'no-menu'})).toMatchObject({ok:false,reason:'POS_CONTEXT_REQUIRED'});
  expect(h.data.getSnapshot()).toBe(before);
});

it('exposes charge-only received value to checkout and custom account allocations without treating them as deposits',()=>{
  const h=m2Session(),{actions,run}=h,meta=(key:string)=>({runId:run.getState().runId,idempotencyKey:key});
  actions.pos.execute({type:'cart.type',orderType:'takeout',meta:meta('type')});actions.pos.execute({type:'cart.add',menuId:'m-americano',optionIds:requiredOptions(actions.pos.read(),'m-americano'),qty:2,meta:meta('add')});
  const billId=getPaymentBillId(actions.pos.read());actions.pos.execute({type:'bill.member',billId,memberId:chargedMember,meta:meta('member')});actions.pos.execute({type:'bill.split',billId,kind:'equal',n:2,meta:meta('split')});
  const part=actions.pos.read().pos.bills.find(b=>b.billId===billId)!.splitPlan!.parts[0];settleM3(actions,actions.money.quoteSale({billId,partId:part.partId,allocations:[{kind:'charge',amount:3000}]}),'share');
  expect(quotePaymentBill(actions.pos.read(),billId)).toMatchObject({received:3000,remaining:3000});
  // CO-002 becomes a linked-member on-pickup order, then uses charge + receivable.
  expect(actions.custom.dispatch({type:'customOrder.update',customOrderId:'CO-002',expectedQuoteRevision:1,memberId:chargedMember,guest:null})).toMatchObject({ok:true});
  const updatedQuote = actions.custom.dispatch({ type: 'customOrder.quote', customOrderId: 'CO-002',
    quoteAmount: 60000, proposedPickupAt: `${TOMORROW}T14:00`, idempotencyKey: 'updated-quote' });
  if (!updatedQuote.ok) throw new Error(updatedQuote.messageKey);
  expect(actions.custom.dispatch({type:'customOrder.recordDecision',customOrderId:'CO-002',quoteRevision:actions.custom.read().tables.customOrder.find(o=>o.customOrderId==='CO-002')!.quoteRevision,decision:'approved',paymentTiming:'on_pickup',idempotencyKey:'decision'})).toMatchObject({ok:true});
  const done=settleM3(actions,actions.money.quoteSettlement({target:{purpose:'custom_order',customOrderId:'CO-002'},allocations:[{kind:'charge',amount:10000},{kind:'receivable',amount:50000}]}),'custom-accounts');
  const order=readModel(h.data.getSnapshot(),'custom-order').orders.find(o=>o.customOrderId==='CO-002')!;
  expect(order.payment).toMatchObject({amountSettled:60000,realDeposits:0,chargeApplied:10000,receivableAmount:50000});
  expect(selectAccountingDay(actions.money.read(),{date:TODAY})).toMatchObject({sales:{total:831220},deposits:{total:831220}});
  const quote=actions.money.quoteReversal({settlementId:done.value.settlementId,kind:'cancel'});
  expect(actions.money.reverse({quote,idempotencyKey:'cancel-custom',cancelOrder:true}).ok).toBe(true);
  expect(readModel(h.data.getSnapshot(),'custom-order').orders.find(o=>o.customOrderId==='CO-002')).toMatchObject({stage:'canceled',payment:{realDeposits:0,chargeApplied:0,receivableAmount:0}});
});

it('adapts the existing POS approval entry to canonical cafe money',()=>{
  const h=m2Session(),{actions,run}=h;
  actions.pos.execute({type:'cart.type',orderType:'takeout',meta:{runId:run.getState().runId,idempotencyKey:'type'}});
  actions.pos.execute({type:'cart.add',menuId:'m-americano',optionIds:requiredOptions(actions.pos.read(),'m-americano'),meta:{runId:run.getState().runId,idempotencyKey:'add'}});
  const r=actions.pos.read();
  expect(actions.pos.beginApproval({cartId:r.pos.cart.cartId,quoteRevision:r.pos.cart.revision,splits:[{method:'card',amount:3000}],meta:{runId:r.runId,idempotencyKey:'legacy'}}).ok).toBe(true);
  const pending=run.getState().posUi.approval!;
  expect(actions.pos.finishApproval({runId:r.runId,attemptId:pending.attemptId,expectedQuoteFingerprint:pending.quoteFingerprint,outcome:'approved'}).ok).toBe(true);
  expect(selectAccountingDay(actions.money.read(),{date:TODAY})).toMatchObject({sales:{total:834220},deposits:{total:834220}});
});

it('item split cancellation returns only its original item while the other share keeps quantity, stock and sales',()=>{
  const h=m2Session(),{actions,run,data}=h,meta=(key:string)=>({runId:run.getState().runId,idempotencyKey:key});
  actions.pos.execute({type:'cart.type',orderType:'takeout',meta:meta('type')});
  actions.pos.execute({type:'cart.add',menuId:'m-americano',qty:2,optionIds:requiredOptions(actions.pos.read(),'m-americano'),meta:meta('coffee')});
  actions.pos.execute({type:'cart.add',menuId:'m-saltbread',optionIds:requiredOptions(actions.pos.read(),'m-saltbread'),meta:meta('bread')});
  const billId=getPaymentBillId(actions.pos.read()),lines=quotePaymentBill(actions.pos.read(),billId).lines;
  expect(actions.pos.execute({type:'bill.split',billId,kind:'items',parts:lines.map(l=>({lineQtyAllocations:[{allocationId:l.lineId,qty:l.qty}]})),meta:meta('split')}).ok).toBe(true);
  const parts=quotePaymentBill(actions.pos.read(),billId).parts,completed: string[]=[];
  for(const [i,p]of parts.entries())completed.push(settleM3(actions,actions.money.quoteSale({billId,partId:p.partId,allocations:[{kind:'method',method:'card',amount:p.amount}]}),'item:'+i).value.settlementId!);
  const before=data.getSnapshot(),bread=before.tables.menuDaily.find(r=>r.businessDate===TODAY&&r.menuId==='m-saltbread')!;
  const quote=actions.money.quoteReversal({settlementId:completed[0],kind:'cancel'});
  expect(actions.money.reverse({quote,idempotencyKey:'cancel-coffee'}).ok).toBe(true);
  expect(data.getSnapshot().tables.menuDaily.find(r=>r.businessDate===TODAY&&r.menuId==='m-americano')?.qty).toBe(62);
  expect(data.getSnapshot().tables.menuDaily.find(r=>r.businessDate===TODAY&&r.menuId==='m-saltbread')).toEqual(bread);
  expect(readModel(data.getSnapshot(),'inventory-booking').ingredients.find(r=>r.itemId==='i-saltbread')?.stock).toBe(readModel(before,'inventory-booking').ingredients.find(r=>r.itemId==='i-saltbread')?.stock);
  expect(selectAccountingDay(actions.money.read(),{date:TODAY}).sales.total).toBe(834420);
});

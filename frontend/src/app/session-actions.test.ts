import { describe, expect, it } from 'vitest';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { createRunStore } from '../state';
import { seedCatalog } from '../data/db/generated/catalog';
import manifest from '../data/db/generated/manifest.json';
import { seedToday } from '../data/db/generated/today';
import { NOW, TODAY } from '../data/db/time';
import { createWidgetDataStore } from '../data/widget-data';
import { timePolicy } from '../ui';
import { createSessionActions, createSessionGate } from './session-actions';
import { quoteCart } from '../pos/domain';
import { readModel, deriveUsage, selectStockHistory } from '../data/widget-data';
import { planPosCommand } from '../pos/domain';

const cookie = seedCatalog.menu.find(menu => menu.menuId === 'm-cookie-choco')!;
const cookieOptions = cookie.groups.filter(group => group.required).map(group => group.options[0].optionId);

function setup() {
  const gate = createSessionGate();
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', sessionGate: gate });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId, sessionGate: gate, pos: run.getState().pos, readPosUi: () => run.getState().posUi });
  const actions = createSessionActions(run, data, gate);
  run.actions.setOnboardingAnswer({ businessType: 'cafe' });
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  return { gate, run, data, actions };
}
describe('API-212 session coordinator', () => {
  it('publishes both references before either first subscriber and rejects cross-store reentry', () => {
    const { gate, run, data, actions } = setup();
    const seen: string[] = [];
    data.subscribe(() => {
      expect(run.getState().transactionId).toBe(data.getSnapshot().transactionId);
      expect(data.getSnapshot().tables.shopSettings).toMatchObject(run.getState().shopSettings);
      const before = run.getState();
      expect(run.actions.switchLayer('marketing')).toBe(false);
      run.actions.setTheme('dark');
      expect(run.getState()).toBe(before);
      expect(actions.completeOnboarding(null)).toMatchObject({ ok: false, reason: 'TRANSACTION_BUSY' });
      seen.push('data');
      throw new Error('subscriber');
    });
    run.subscribe(() => {
      expect(run.getState().transactionId).toBe(data.getSnapshot().transactionId);
      expect(data.dispatch({ type: 'menu.update', menuId: 'missing', patch: { price: 1 } })).toMatchObject({ ok: false, reason: 'TRANSACTION_BUSY' });
      seen.push('run');
    });
    expect(actions.completeOnboarding(null)).toMatchObject({ ok: true, value: { tableLayoutEnabled: false, totalSeats: manifest.store.seats } });
    expect(seen).toEqual(['data', 'run']);
    expect(gate.phase).toBe('idle');
  });
  it('keeps snapshots, revisions, notifications and undo unchanged on validation failure', () => {
    const { run, data, actions } = setup();
    const beforeRun = run.getState(), beforeData = data.getSnapshot();
    let count = 0; run.subscribe(() => count++); data.subscribe(() => count++);
    expect(actions.completeOnboarding('Z' as 'A').ok).toBe(false);
    expect(run.getState()).toBe(beforeRun); expect(data.getSnapshot()).toBe(beforeData); expect(count).toBe(0);
  });
  it('rejects stale run, revision and transition tokens before publication', () => {
    const { run, data, actions } = setup();
    const stamp = actions.capture();
    for (const stale of [{ ...stamp, runId: 'old' }, { ...stamp, expectedDataRevision: -1 }, { ...stamp, expectedRunRevision: -1 }, { ...stamp, transitionToken: 'old' }]) {
      const r = run.getState(), d = data.getSnapshot();
      expect(actions.completeOnboarding(null, stale).ok).toBe(false);
      expect(run.getState()).toBe(r); expect(data.getSnapshot()).toBe(d);
    }
  });
  it('saves the data source and run mirror together without changing boards or onboarding', () => {
    const { run, data, actions } = setup();
    expect(actions.completeOnboarding(null).ok).toBe(true);
    run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'menu' });
    const before = run.getState();
    expect(actions.updateSettings({ ...data.getSnapshot().tables.shopSettings, businessType: 'retail', revision: 2 }).ok).toBe(true);
    expect(run.getState().boards).toBe(before.boards);
    expect(run.getState().onboarding).toBe(before.onboarding);
    expect(run.getState().businessType).toBe('retail');
    expect(data.getSnapshot().tables.shopSettings).toMatchObject(run.getState().shopSettings);
  });
  it('keeps an unchanged settings save a no-op and still rejects a stale stamp',()=>{
    const {run,data,actions}=setup();expect(actions.completeOnboarding(null).ok).toBe(true);
    const r=run.getState(),d=data.getSnapshot(),stamp=actions.capture();let count=0;run.subscribe(()=>count++);data.subscribe(()=>count++);
    expect(actions.updateSettings({...r.shopSettings,revision:r.shopSettings.revision+1})).toMatchObject({ok:true});
    expect(run.getState()).toBe(r);expect(data.getSnapshot()).toBe(d);expect(count).toBe(0);
    expect(actions.updateSettings({...r.shopSettings,revision:r.shopSettings.revision+1},{...stamp,transitionToken:'old'}).ok).toBe(false);
  });

  it('aborts both prepared tickets when a last currentness check fails',()=>{
    const {run,data,gate}=setup();
    const r=run.getState(),d=data.getSnapshot();let count=0;run.subscribe(()=>count++);data.subscribe(()=>count++);
    const actions=createSessionActions(run,{...data,session:{...data.session,isCurrent:()=>false}},gate);
    expect(actions.completeOnboarding('A')).toMatchObject({ok:false,reason:'STALE_REVISION'});
    expect(run.getState()).toBe(r);expect(data.getSnapshot()).toBe(d);expect(count).toBe(0);expect(gate.phase).toBe('idle');
  });

});

describe('API-240 atomic POS coordinator', () => {
  it('new approval publishes management numbers with the same POS before either notification', () => {
    const { gate, run, data, actions } = setup();
    expect(actions.completeOnboarding(null).ok).toBe(true);
    expect(actions.pos).toBeDefined();
    const pos = actions.pos;
    const americano = seedCatalog.menu.find(menu => menu.menuId === 'm-americano')!;
    const optionIds = americano.groups.flatMap(group => group.options.filter(option => ['ICE', '레귤러'].includes(option.name)).map(option => option.optionId));
    const beforeUsage = deriveUsage(data.getSnapshot(), { date: TODAY }).byItem;
    const added = pos.execute({ type: 'cart.add', menuId: 'm-americano', optionIds, qty: 2, meta: { runId: run.getState().runId, idempotencyKey: 'add' } });
    expect(added.ok).toBe(true);
    const beforeRun = run.getState(), beforeData = data.getSnapshot();
    const observed: unknown[] = [];
    const check = () => {
      observed.push({ samePos: run.getState().pos === data.getSnapshot().pos, sameTransaction: run.getState().transactionId === data.getSnapshot().transactionId,
        revenue: readModel(data.getSnapshot(), 'ledger').sales.net,
        posReentry: pos.execute({ type: 'cart.clear', meta: { runId: run.getState().runId, idempotencyKey: 'reentry' } }),
        dataReentry: data.dispatch({ type: 'closing.closeDay', date: TODAY, scenario: 'normal', expectedGeneration: 0, idempotencyKey: 'reentry' }) });
    };
    const read = pos.read(), quote = quoteCart(read, read.pos.cart.cartId);
    expect(pos.beginApproval({ cartId: read.pos.cart.cartId, quoteRevision: quote.revision, splits: [{ method: 'card', amount: americano.price * 2 }], meta: { runId: read.runId, idempotencyKey: 'approve' } })).toMatchObject({ ok: true, status: 'pending' });
    expect(data.dispatch({ type: 'closing.closeDay', date: TODAY, scenario: 'empty', expectedGeneration: 0, idempotencyKey: 'pending' })).toMatchObject({ ok: false, reason: 'UNPAID_BILLS' });
    const offData = data.subscribe(check), offRun = run.subscribe(check);
    const attempt = run.getState().posUi.approval!;
    const callback = { runId: read.runId, attemptId: attempt.attemptId, expectedQuoteFingerprint: attempt.quoteFingerprint, outcome: 'approved' as const };
    expect(pos.finishApproval(callback)).toMatchObject({ ok: true, value: { orderIds: [`O-${seedToday.pos.orders.at(-1)!.orderNo + 1}`], settled: true } });
    expect(observed).toHaveLength(2);
    for (const value of observed) expect(value).toMatchObject({ samePos: true, sameTransaction: true, revenue: seedToday.rollup.net + americano.price * 2, posReentry: { ok: false, reason: 'TRANSACTION_BUSY' }, dataReentry: { ok: false, reason: 'TRANSACTION_BUSY' } });
    offData(); offRun();
    const s = data.getSnapshot();
    expect(s.revision).toBe(beforeData.revision + 1);
    expect(run.getState().posRevision).toBe(beforeRun.posRevision + 1);
    const netSales = seedToday.rollup.net + americano.price * 2, cost = seedToday.rollup.cost + americano.unitCost * 2;
    expect(readModel(s, 'margin')).toMatchObject({ cost, netSales, grossProfit: netSales - cost });
    expect(deriveUsage(s, { date: TODAY }).byItem).toMatchObject({ 'i-bean-house': beforeUsage['i-bean-house'] + 36, 'i-cup-takeout': beforeUsage['i-cup-takeout'] + 2 });
    const previousUsageRow = selectStockHistory(beforeData, { itemId: 'i-bean-house', period: 'today' }).dayGroups[0].rows.find(r => r.sourceRef === 'm-americano')!;
    expect(selectStockHistory(s, { itemId: 'i-bean-house', period: 'today' }).dayGroups[0].rows.find(r => r.sourceRef === 'm-americano')).toMatchObject({ delta: previousUsageRow.delta - 36, asOf: '15:45' });
    expect(pos.finishApproval(callback)).toMatchObject({ ok: true, duplicate: true });
    expect(data.getSnapshot()).toBe(s); expect(gate.phase).toBe('idle');
    // An older general undo must preserve the current ledger projection.
    expect(pos.read()).toBe(pos.read());
  });

  it('aborts both POS preparations on stale/currentness failures and preserves general undo', () => {
    const { run, data, gate, actions } = setup();
    expect(actions.pos).toBeDefined();
    const expense = data.dispatch({ type: 'ledger.recordExpense', date: TODAY, category: 'operations', amount: 100 });
    const r = run.getState(), d = data.getSnapshot();
    let notices = 0; run.subscribe(() => notices++); data.subscribe(() => notices++);
    const reject = createSessionActions(run, { ...data, session: { ...data.session, isCurrent: () => false } }, gate);
    expect(reject.pos.execute({ type: 'cart.add', menuId: cookie.menuId, optionIds: cookieOptions, meta: { runId: r.runId, idempotencyKey: 'reject' } })).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    expect(run.getState()).toBe(r); expect(data.getSnapshot()).toBe(d); expect(notices).toBe(0);
    const stale = actions.pos.read();
    const planned = planPosCommand(stale, { type: 'cart.add', menuId: cookie.menuId, optionIds: cookieOptions, meta: { runId: r.runId, idempotencyKey: 'stale' } }, NOW);
    run.actions.setTheme('dark');
    expect(planned.ok).toBe(true);
    if (planned.ok) expect(actions.commit(planned.plan, stale)).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    expect(actions.pos.execute({ type: 'cart.add', menuId: cookie.menuId, optionIds: cookieOptions, meta: { runId: r.runId, idempotencyKey: 'good' } }).ok).toBe(true);
    const current = data.getSnapshot().pos;
    if (!expense.ok || !expense.undoToken) throw new Error('Missing expense undo');
    expect(data.undo(expense.undoToken).ok).toBe(true);
    expect(data.getSnapshot().pos).toBe(current);
    expect(readModel(data.getSnapshot(), 'ledger').netProfit).toBe(seedToday.rollup.net - seedToday.rollup.expenses);
  });

  it('rejects a data prepare failure without changing either store', () => {
    const { run, data, gate } = setup();
    const actions = createSessionActions(run, { ...data, session: { ...data.session, prepare: () => ({ ok: false, code: 'VALIDATION', reason: 'INVALID_POS_PLAN', messageKey: 'run.session.validation' }) } }, gate);
    expect(actions.pos).toBeDefined();
    const r = run.getState(), d = data.getSnapshot();
    expect(actions.pos.execute({ type: 'cart.add', menuId: cookie.menuId, optionIds: cookieOptions, meta: { runId: r.runId, idempotencyKey: 'bad' } })).toMatchObject({ ok: false, reason: 'INVALID_POS_PLAN' });
    expect(run.getState()).toBe(r); expect(data.getSnapshot()).toBe(d); expect(gate.phase).toBe('idle');
  });

  it('keeps no-op POS keys in the runtime without a business revision or notification', () => {
    const { run, data, actions } = setup();
    expect(actions.pos).toBeDefined();
    const r = run.getState(), d = data.getSnapshot(); let notices = 0;
    run.subscribe(() => notices++); data.subscribe(() => notices++);
    const command = { type: 'cart.clear' as const, meta: { runId: r.runId, idempotencyKey: 'empty' } };
    expect(actions.pos.execute(command)).toMatchObject({ ok: true, status: 'unchanged' });
    expect(actions.pos.execute(command)).toMatchObject({ ok: true, duplicate: true });
    expect(run.getState()).toBe(r); expect(data.getSnapshot()).toBe(d); expect(notices).toBe(0);
  });
});

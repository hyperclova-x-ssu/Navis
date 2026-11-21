import { describe, expect, it } from 'vitest';
import type { PosDataRead, PosPlan, PosReadSnapshot } from '../contracts/pos';
import { createRunStore } from './index';
import { createPosRuntime } from '../pos/runtime';
import { createPosSeed, createPosSeedCatalog } from '../pos/seed';
import { selectPosDayTotals, quoteCart } from '../pos/domain';
import { getRegistry } from '../catalog';
import { screenPresets } from '../layout/presets';
import { testTime } from '../layout/test-policy';
import { POS_NOW } from '../pos/clock';

const opening = createPosSeed();
const nextOrder = opening.orders.at(-1)!.orderNo + 1;
const nextOrderId = `O-${String(nextOrder).padStart(3, '0')}`;
const americano = createPosSeedCatalog().items.find(menu => menu.menuId === 'm-americano')!;
const americanoOptions = (temperature: 'HOT' | 'ICE') =>
  americano.groups.flatMap(group => group.options.filter(option => [temperature, '레귤러'].includes(option.name)).map(option => option.optionId));


function setup() {
  let time = 0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => time, theme: 'light' });
  run.actions.chooseBusiness('cafe'); run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' }); run.actions.startEmpty();
  let data: PosDataRead = { revision: 0, catalog: createPosSeedCatalog(), dayClosed: false, closingGeneration: 0 };
  let rejectCommit = false;
  const commit = (plan: PosPlan, read: PosReadSnapshot) => {
    if (rejectCommit) return { ok: false as const, code: 'CONFLICT' as const, reason: 'DATA_PREPARE_FAILED', messageKey: 'run.session.conflict' };
    const s = run.getState();
    const result = run.session.prepare({ transactionId: `pos:${plan.nextPos.revision}`, runId: s.runId, expectedRunRevision: s.runRevision, expectedDataRevision: data.revision, transitionToken: s.transitionToken }, { type: 'pos.commit', expectedPosRevision: read.posRevision, nextPos: plan.nextPos, nextUi: plan.nextUi });
    if (!result.ok) return result;
    data = { ...data, revision: data.revision + 1 };
    run.session.publish(result.change); run.session.flush(result.change.transactionId);
    return { ...plan.result, transactionId: result.change.transactionId };
  };
  const pos = createPosRuntime({ run, readData: () => data, commit });
  const add = (key = 'add') => pos.execute({ type: 'cart.add', menuId: 'm-americano', optionIds: americanoOptions('ICE'), qty: 2, meta: { runId: run.getState().runId, idempotencyKey: key } });
  const begin = (key = 'approve') => pos.beginApproval({ cartId: run.getState().pos.cart.cartId, splits: [{ method: 'card', amount: quoteCart(pos.read()).payable }], quoteRevision: run.getState().pos.cart.revision, meta: { runId: run.getState().runId, idempotencyKey: key } });
  const finish = (outcome: 'approved' | 'failed' = 'approved') => {
    const a = run.getState().posUi.approval!;
    return pos.finishApproval({ runId: run.getState().runId, attemptId: a.attemptId, expectedQuoteFingerprint: a.quoteFingerprint, outcome });
  };
  return { run, pos, add, begin, finish, setData: (next: Partial<PosDataRead>) => { data = { ...data, ...next }; }, reject: () => { rejectCommit = true; }, advance: () => { time += 31000; run.actions.tick(); } };
}

describe('T-241 prepaid flow through RunState', () => {
  it('commits one approval at 15:45, keeps UI completion separate, and resets the next run', () => {
    const h = setup(); h.add();
    const business = h.run.getState().pos;
    expect(h.begin()).toMatchObject({ ok: true, status: 'pending' });
    expect(h.run.getState().pos).toBe(business);
    expect(h.begin()).toMatchObject({ ok: true, duplicate: true });
    expect(h.pos.dismissApproval()).toBe(false);
    expect(h.finish()).toMatchObject({ ok: true, value: { settled: true, orderIds: [nextOrderId] } });
    expect(h.run.getState().pos.orders.at(-1)).toMatchObject({ orderNo: nextOrder, orderedAt: POS_NOW, preparation: 'accepted', completedInRun: false });
    expect(h.run.getState().pos.payments.at(-1)).toMatchObject({ transactionNo: `거래-${opening.businessDate.replaceAll('-', '')}-${String(opening.payments.length + 1).padStart(4, '0')}`, approvalNo: `예시-${String(opening.payments.length + 1).padStart(6, '0')}`, amount: 6000 });
    expect(selectPosDayTotals(h.run.getState().pos)).toMatchObject({ revenue: 837220, paymentCount: 154, byMethod: { card: 563050 }, methodCounts: { card: 104 } });
    const committed = h.run.getState().pos;
    expect(h.finish()).toMatchObject({ ok: true, duplicate: true });
    expect(h.run.getState().pos).toBe(committed);
    expect(h.run.getState().posUi.approval?.status).toBe('succeeded');
    expect(h.pos.dismissApproval()).toBe(true);
    expect(h.run.getState().pos).toBe(committed);
    h.run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light' });
    expect(h.run.getState().pos.payments).toHaveLength(opening.payments.length);
    expect(h.run.getState().pos.cart.lines).toHaveLength(0);
    expect(h.run.getState().posUi.approval).toBeNull();
    h.pos.dispose(); h.run.dispose();
  });
  it('keeps a pending approval on repeat, rejects other methods, preserves the cart on failure, and retries with a fresh key', () => {
    const h = setup(); h.add(); h.run.actions.setPosPreview('payment-failure');
    const before = h.run.getState().pos;
    h.begin();
    expect(h.pos.beginApproval({ cartId: before.cart.cartId, splits: [{ method: 'cash', amount: 6000 }], quoteRevision: before.cart.revision, meta: { runId: h.run.getState().runId, idempotencyKey: 'cash' } })).toMatchObject({ ok: false, reason: 'APPROVAL_BUSY' });
    expect(h.finish()).toMatchObject({ ok: false, code: 'PREVIEW_FAILURE', reason: 'APPROVAL_FAILED' });
    expect(h.run.getState().pos).toBe(before);
    h.run.actions.setPosPreview('normal'); h.begin('retry');
    expect(h.finish()).toMatchObject({ ok: true });
    expect(h.run.getState().pos.orders.at(-1)?.orderNo).toBe(nextOrder);
    h.pos.dispose(); h.run.dispose();
  });
  it('revalidates catalog, closing and preview at finish without applying partial business state', () => {
    for (const change of ['price', 'closed', 'error', 'sold'] as const) {
      const h = setup(); h.add(); h.begin(); const before = h.run.getState().pos;
      if (change === 'price') h.setData({ catalog: { ...createPosSeedCatalog(), items: createPosSeedCatalog().items.map(m => m.menuId === 'm-americano' ? { ...m, price: 5000 } : m) } });
      if (change === 'closed') h.setData({ dayClosed: true });
      if (change === 'error') {
        h.run.actions.setPosPreview('error');
        const pending = h.run.getState().posUi.approval!;
        expect(h.pos.finishApproval({ runId: h.run.getState().runId, attemptId: `${pending.attemptId}:old`, expectedQuoteFingerprint: pending.quoteFingerprint, outcome: 'approved' })).toMatchObject({ ok: false, reason: 'STALE_ATTEMPT' });
        expect(h.run.getState().posUi.approval).toBe(pending);
      }
      if (change === 'sold') h.setData({ catalog: { ...createPosSeedCatalog(), items: createPosSeedCatalog().items.map(m => ({ ...m, saleStatus: 'sold_out' as const })) } });
      expect(h.finish()).toMatchObject({ ok: false, reason: { price: 'QUOTE_CHANGED', closed: 'DAY_CLOSED', error: 'DATA_UNAVAILABLE', sold: 'SOLD_OUT' }[change] });
      expect(h.run.getState().pos).toBe(before);
      h.pos.dispose(); h.run.dispose();
    }
  });
  it('does not commit when the data prepare rejects, and ignores old-run or disposed callbacks', () => {
    const h = setup(); h.add(); h.begin(); const before = h.run.getState().pos;
    const attempt = h.run.getState().posUi.approval!;
    h.reject(); expect(h.finish()).toMatchObject({ ok: false, reason: 'DATA_PREPARE_FAILED' });
    expect(h.run.getState().pos).toBe(before);
    const callback = { attemptId: attempt.attemptId, expectedQuoteFingerprint: attempt.quoteFingerprint, runId: h.run.getState().runId, outcome: 'approved' as const };
    h.run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light' });
    expect(h.pos.finishApproval(callback)).toMatchObject({ ok: false, reason: 'STALE_RUN' });
    h.pos.dispose(); expect(h.pos.finishApproval({ ...callback, runId: h.run.getState().runId })).toMatchObject({ ok: false, reason: 'STALE_RUN' }); h.run.dispose();
  });
  it('keeps order state across layers, excludes POS from idle hiding, and keeps empty/error preview away from normal ledger', () => {
    const h = setup(); h.add(); const before = h.run.getState().pos;
    h.run.actions.skipWidgetCoaches(); h.run.actions.switchLayer('orders-payment'); h.advance();
    expect(h.run.getState().idle.mode).toBe('active');
    h.pos.setTab('status'); h.run.actions.switchLayer('management'); h.run.actions.switchLayer('orders-payment');
    expect(h.run.getState().posUi.tab).toBe('order');
    h.run.actions.setPreviewFamily('empty'); expect(quoteCart(h.pos.read()).canSubmit).toBe(false);
    expect(h.run.getState().pos).toBe(before);
    h.run.actions.setPosPreview('normal'); expect(quoteCart(h.pos.read()).payable).toBe(6000);
    h.run.actions.setPosPreview('error'); expect(h.begin()).toMatchObject({ ok: false, reason: 'DATA_UNAVAILABLE' });
    h.pos.dispose(); h.run.dispose();
  });
  it('remembers an unchanged command key so it cannot become a new destructive command later', () => {
    const h = setup();
    const clear = { type: 'cart.clear' as const, meta: { runId: h.run.getState().runId, idempotencyKey: 'empty-clear' } };
    expect(h.pos.execute(clear)).toMatchObject({ ok: true, status: 'unchanged' });
    h.add(); const before = h.run.getState().pos;
    expect(h.pos.execute(clear)).toMatchObject({ ok: true, status: 'unchanged', duplicate: true });
    expect(h.run.getState().pos).toBe(before);
    h.pos.dispose(); h.run.dispose();
  });
  it('rejects a pending callback after attempt replacement and a duplicate across closing generations', () => {
    const h = setup(); h.add(); h.begin();
    const old = h.run.getState().posUi.approval!;
    h.finish('failed'); h.begin('retry');
    const retry = h.run.getState().posUi.approval;
    expect(h.pos.finishApproval({ runId: h.run.getState().runId, attemptId: old.attemptId, expectedQuoteFingerprint: old.quoteFingerprint, outcome: 'approved' })).toMatchObject({ ok: false, reason: 'STALE_ATTEMPT' });
    expect(h.run.getState().posUi.approval).toBe(retry);
    h.setData({ closingGeneration: 1 });
    expect(h.begin('retry')).toMatchObject({ ok: false, reason: 'STALE_ATTEMPT' });
    h.pos.dispose(); h.run.dispose();
  });
  it('prepares silently, rejects stale POS revisions, aborts without writes, and blocks reentry while publishing', () => {
    const h = setup(); const before = h.run.getState(); let notifications = 0;
    const tx = { transactionId: 'isolated', runId: before.runId, expectedDataRevision: 0, expectedRunRevision: before.runRevision, transitionToken: before.transitionToken };
    const input = { type: 'pos.commit' as const, expectedPosRevision: 0, nextPos: { ...before.pos, revision: 1 }, nextUi: before.posUi };
    expect(h.run.session.prepare(tx, { ...input, expectedPosRevision: 1 })).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    const discarded = h.run.session.prepare(tx, input);
    if (!discarded.ok) throw new Error(discarded.reason);
    h.run.session.abort(discarded.change); expect(h.run.getState()).toBe(before);
    const prepared = h.run.session.prepare(tx, input);
    if (!prepared.ok) throw new Error(prepared.reason);
    let reentry: unknown;
    h.run.subscribe(() => { notifications++; reentry = h.add('reentry'); });
    h.run.session.publish(prepared.change); expect(notifications).toBe(0);
    h.run.session.flush(tx.transactionId); expect(notifications).toBe(1);
    expect(reentry).toMatchObject({ ok: false, reason: 'TRANSACTION_BUSY' });
    expect(h.run.getState().posRevision).toBe(1);
    h.pos.dispose(); h.run.dispose();
  });
});
